import { mkdtemp, readdir, rename, rm, stat, symlink } from 'node:fs/promises'
import filesystem from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { knex, type Knex } from 'knex'
import { addSnapshotArchiveTables } from '../../schema/snapshotArchiveMigration'
import { addSnapshotArchiveRequestTable } from '../../schema/snapshotArchiveRequestMigration'
import { addSnapshotArchiveOwnerTable } from '../../schema/snapshotArchiveOwnerMigration'
import {
  addSnapshotArchiveGuardTable,
  removeSnapshotArchiveGuardTable
} from '../../schema/snapshotArchiveGuardMigration'
import { KnexSnapshotArchiveRequestStore } from './KnexSnapshotArchiveRequestStore'
import { snapshotArchiveRequestId } from './SnapshotArchiveRequest'
import { readGuardedSnapshotArchive, recoverSnapshotArchiveGuards } from './SnapshotArchiveGuard'
import { SnapshotArchiveSourceCleanupError } from './KnexSnapshotArchiveSource'
import * as Backend from './SnapshotArchiveGuardBackend'
import * as Registry from './SnapshotArchiveGuardRegistry'

const stores: Knex[] = []
const directories: string[] = []
function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}
function identity(index = 1): string {
  return '02' + index.toString(16).padStart(2, '0').repeat(32)
}
function request(index = 1) {
  const fields = {
    version: 1 as const,
    nonce: index.toString(16).padStart(2, '0').repeat(32),
    notAfter: Date.now() + 300000,
    maxBytes: 32768
  }
  return { ...fields, requestId: snapshotArchiveRequestId(fields) }
}
async function fixture(upgrade = true) {
  const directory = await mkdtemp(join(tmpdir(), 'snapshot-guard-'))
  directories.push(directory)
  const filename = join(directory, 'wallet.sqlite')
  const config: Knex.Config = {
    client: 'better-sqlite3',
    connection: { filename },
    useNullAsDefault: true,
    pool: { min: 0, max: 1 }
  }
  const open = () => {
    const value = knex(config)
    stores.push(value)
    return value
  }
  const control = open()
  await control.raw('PRAGMA journal_mode = WAL')
  await addSnapshotArchiveTables(control)
  await addSnapshotArchiveRequestTable(control)
  await addSnapshotArchiveOwnerTable(control)
  if (upgrade) await addSnapshotArchiveGuardTable(control)
  await control.schema.createTable('fixture_values', table => {
    table.integer('id').primary()
    table.string('value')
  })
  await control('fixture_values').insert({ id: 1, value: 'before' })
  const requests = new KnexSnapshotArchiveRequestStore(control, true, upgrade)
  const recover = async () => {
    await recoverSnapshotArchiveGuards(control, config)
    await requests.reap()
  }
  return { control, requests, recover, directory, filename, config, open }
}
afterEach(async () => {
  jest.restoreAllMocks()
  await Promise.all(stores.splice(0).map(value => value.destroy()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

test('the additive migration preserves unguarded owners and refuses their downgrade', async () => {
  const f = await fixture(false)
  const input = request()
  const claimed = await f.requests.claim(identity(), input)
  await addSnapshotArchiveGuardTable(f.control)
  await addSnapshotArchiveGuardTable(f.control)
  expect(await f.control('snapshot_archive_owner_slots')).toHaveLength(8)
  expect(await f.control('snapshot_archive_owners').first()).toMatchObject({ ...claimed.owner, guardVersion: 0 })
  await f.requests.markCancellation(identity(), input)
  await f.recover()
  expect(await f.control('snapshot_archive_owners')).toHaveLength(1)
  await expect(removeSnapshotArchiveGuardTable(f.control)).rejects.toThrow('Drain')
  await f.requests.sourceClosed(claimed.owner!)
  await removeSnapshotArchiveGuardTable(f.control)
  await removeSnapshotArchiveGuardTable(f.control)
  expect(await f.control.schema.hasColumn('snapshot_archive_owners', 'guardVersion')).toBe(false)
})

test('recovery waits through physical connection close while foreground WAL writes continue', async () => {
  const f = await fixture()
  const input = request()
  const { owner } = await f.requests.claim(identity(), input)
  const source = f.open(),
    opened = gate(),
    stop = gate(),
    closing = gate(),
    finish = gate()
  const destroy = source.client.destroyRawConnection.bind(source.client)
  jest.spyOn(source.client, 'destroyRawConnection').mockImplementation(async connection => {
    closing.resolve()
    await finish.promise
    await destroy(connection)
  })
  const work = readGuardedSnapshotArchive(f.control, source, owner!, async trx => {
    expect((await trx('fixture_values').first()).value).toBe('before')
    await expect(trx('fixture_values').update({ value: 'forbidden' })).rejects.toMatchObject({
      code: 'SQLITE_READONLY'
    })
    opened.resolve()
    await stop.promise
    expect((await trx('fixture_values').first()).value).toBe('before')
  })
  try {
    await opened.promise
    await f.requests.markCancellation(identity(), input)
    await f.recover()
    expect(await f.control('snapshot_archive_owners')).toHaveLength(1)
    await f.control('fixture_values').update({ value: 'foreground' })
    stop.resolve()
    await closing.promise
    await f.recover()
    expect((await f.control('snapshot_archive_capacity').first()).archives).toBe(1)
    finish.resolve()
    await work
    await f.recover()
    expect(await f.control('snapshot_archive_owners')).toHaveLength(0)
    expect((await f.control('snapshot_archive_capacity').first()).archives).toBe(0)
    expect((await f.control('fixture_values').first()).value).toBe('foreground')
  } finally {
    stop.resolve()
    finish.resolve()
    await work.catch(() => undefined)
  }
})

test.each(['unbound', 'bound'] as const)(
  'a %s late acquisition cannot read after recovery or release a successor slot',
  async phase => {
    const f = await fixture(),
      input = request()
    const { owner } = await f.requests.claim(identity(), input)
    const entered = gate(),
      resume = gate()
    if (phase === 'unbound') {
      const bind = Registry.bindSnapshotArchiveOwnerGuard
      jest.spyOn(Registry, 'bindSnapshotArchiveOwnerGuard').mockImplementationOnce(async (...args) => {
        entered.resolve()
        await resume.promise
        return await bind(...args)
      })
    } else {
      const guard = Backend.withSnapshotArchiveBackendGuard
      jest.spyOn(Backend, 'withSnapshotArchiveBackendGuard').mockImplementationOnce(async (...args) => {
        entered.resolve()
        await resume.promise
        return await guard(...args)
      })
    }
    let reads = 0
    const work = readGuardedSnapshotArchive(f.control, f.open(), owner!, async () => {
      reads++
    })
    void work.catch(() => undefined)
    try {
      await entered.promise
      await f.requests.markCancellation(identity(), input)
      await f.recover()
      const successor = await f.requests.claim(identity(), request(2))
      resume.resolve()
      await expect(work).rejects.toThrow('unavailable')
      expect(reads).toBe(0)
      await f.requests.sourceClosed(owner!)
      expect(await f.control('snapshot_archive_owners').first()).toMatchObject(successor.owner!)
      await readGuardedSnapshotArchive(f.control, f.open(), successor.owner!, async trx => {
        expect((await trx('fixture_values').first()).value).toBe('before')
      })
      await f.requests.sourceClosed(successor.owner!)
    } finally {
      resume.resolve()
      await work.catch(() => undefined)
    }
  }
)

test('a missing bound guard fails closed without recreating its inode', async () => {
  const f = await fixture(),
    input = request()
  const { owner } = await f.requests.claim(identity(), input)
  await readGuardedSnapshotArchive(f.control, f.open(), owner!, async () => undefined)
  await f.requests.markCancellation(identity(), input)
  const path = `${f.filename}.snapshot-owner-0.sqlite`,
    moved = path + '.retained'
  const inode = (await stat(path)).ino
  await rename(path, moved)
  await expect(f.recover()).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readdir(f.directory)).not.toContain('wallet.sqlite.snapshot-owner-0.sqlite')
  expect((await f.control('snapshot_archive_capacity').first()).archives).toBe(1)
  await rename(moved, path)
  await f.recover()
  expect((await stat(path)).ino).toBe(inode)
  expect((await f.control('snapshot_archive_capacity').first()).archives).toBe(0)
})

test('an unproved native close never rolls back the guard or releases source capacity', async () => {
  const f = await fixture(),
    input = request(),
    source = f.open()
  const { owner } = await f.requests.claim(identity(), input)
  let connection: { open: boolean; close: () => void } | undefined
  jest.spyOn(source.client, 'destroyRawConnection').mockImplementation(async value => {
    connection = value
  })
  try {
    await expect(
      readGuardedSnapshotArchive(f.control, source, owner!, async trx => {
        expect((await trx('fixture_values').first()).value).toBe('before')
      })
    ).rejects.toBeInstanceOf(SnapshotArchiveSourceCleanupError)
    expect(connection?.open).toBe(true)
    await f.requests.markCancellation(identity(), input)
    await f.recover()
    expect((await f.control('snapshot_archive_capacity').first()).archives).toBe(1)
    connection!.close()
    await f.recover()
    expect((await f.control('snapshot_archive_capacity').first()).archives).toBe(0)
  } finally {
    if (connection?.open) connection.close()
  }
})

test('all eight independent source guards preserve old views and stable slot files through reuse', async () => {
  const f = await fixture(),
    stop = gate(),
    work: Promise<void>[] = []
  try {
    for (let index = 1; index <= 8; index++) {
      const claimed = await f.requests.claim(identity(index), request(index))
      const opened = gate()
      work.push(
        readGuardedSnapshotArchive(f.control, f.open(), claimed.owner!, async trx => {
          expect((await trx('fixture_values').first()).value).toBe('before')
          opened.resolve()
          await stop.promise
          expect((await trx('fixture_values').first()).value).toBe('before')
        })
      )
      await opened.promise
    }
    await expect(f.requests.claim(identity(9), request(9))).rejects.toThrow('capacity')
    const files = (await readdir(f.directory)).filter(name => /snapshot-owner-\d.sqlite$/.test(name)).sort()
    expect(files).toHaveLength(8)
    const inodes = await Promise.all(files.map(async name => (await stat(join(f.directory, name))).ino))
    await f.control('fixture_values').update({ value: 'committed' })
    await f.control('snapshot_archive_requests').update({ expiresAt: 1 })
    await f.recover()
    expect(await f.control('snapshot_archive_owners')).toHaveLength(8)
    stop.resolve()
    await Promise.all(work)
    await f.recover()
    expect((await f.control('snapshot_archive_capacity').first()).archives).toBe(0)
    const successor = await f.requests.claim(identity(), request(10))
    await readGuardedSnapshotArchive(f.control, f.open(), successor.owner!, async trx => {
      expect((await trx('fixture_values').first()).value).toBe('committed')
    })
    expect(await Promise.all(files.map(async name => (await stat(join(f.directory, name))).ino))).toEqual(inodes)
    expect(await f.control('snapshot_archive_owner_slots').whereNotNull('bindingJson')).toHaveLength(8)
  } finally {
    stop.resolve()
    await Promise.allSettled(work)
  }
})

test.each(['owner', 'slot', 'binding', 'request', 'released', 'state', 'expired'] as const)(
  'the final source check rejects a changed %s before reading wallet data',
  async field => {
    const f = await fixture(),
      input = request()
    const { owner } = await f.requests.claim(identity(), input)
    const guard = Backend.withSnapshotArchiveBackendGuard
    jest.spyOn(Backend, 'withSnapshotArchiveBackendGuard').mockImplementationOnce(async (...args) => {
      if (field === 'owner') await f.control('snapshot_archive_owners').delete()
      else if (field === 'slot') await f.control('snapshot_archive_owners').update({ slot: 1 })
      else if (field === 'binding')
        await f.control('snapshot_archive_owner_slots').where({ slot: 0 }).update({ bindingJson: '{}' })
      else if (field === 'request') await f.control('snapshot_archive_requests').delete()
      else if (field === 'released') await f.control('snapshot_archive_requests').update({ released: 1 })
      else if (field === 'state') await f.control('snapshot_archive_requests').update({ state: 'ready' })
      else await f.control('snapshot_archive_requests').update({ expiresAt: 1 })
      return await guard(...args)
    })
    const read = jest.fn()
    await expect(readGuardedSnapshotArchive(f.control, f.open(), owner!, read)).rejects.toThrow('unavailable')
    expect(read).not.toHaveBeenCalled()
  }
)

test.each(['invalid-slot', 'missing-slot'] as const)(
  'a corrupt %s cannot choose an unbound backend guard',
  async kind => {
    const f = await fixture(),
      input = request()
    const { owner } = await f.requests.claim(identity(), input)
    if (kind === 'invalid-slot') await f.control('snapshot_archive_owners').update({ slot: 8 })
    else await f.control('snapshot_archive_owner_slots').where({ slot: 0 }).delete()
    await expect(Registry.readSnapshotArchiveOwnerGuard(f.control, owner!)).rejects.toThrow('unavailable')
  }
)

test('binding rechecks the owner slot and refuses to replace an established binding', async () => {
  const f = await fixture(),
    input = request()
  const { owner } = await f.requests.claim(identity(), input)
  const context = await Registry.readSnapshotArchiveOwnerGuard(f.control, owner!)
  const verify = jest.fn(async () => undefined)
  await f.control('snapshot_archive_owners').update({ slot: 1 })
  await expect(Registry.bindSnapshotArchiveOwnerGuard(f.control, context, 'binding', verify)).rejects.toThrow(
    'unavailable'
  )
  await f.control('snapshot_archive_owners').update({ slot: 0 })
  const bound = await Registry.bindSnapshotArchiveOwnerGuard(f.control, context, 'binding', verify)
  expect(bound.bindingJson).toBe('binding')
  await expect(Registry.bindSnapshotArchiveOwnerGuard(f.control, bound, 'replacement', verify)).rejects.toThrow(
    'unavailable'
  )
  expect((await f.control('snapshot_archive_owner_slots').where({ slot: 0 }).first()).bindingJson).toBe('binding')
})

test('recovery fences only the exact expired owner and preserves live requests', async () => {
  const f = await fixture(),
    input = request()
  const { owner } = await f.requests.claim(identity(), input)
  const context = await Registry.readSnapshotArchiveOwnerGuard(f.control, owner!)
  const fence = (value = context, acknowledge = false) =>
    f.control.transaction(trx => Registry.fenceSnapshotArchiveOwnerGuard(trx, value, acknowledge))
  expect(await fence()).toBe(false)
  expect(await fence({ ...context, slot: 1 })).toBe(false)
  expect(await fence({ ...context, bindingJson: 'different' })).toBe(false)
  await f.control('snapshot_archive_requests').where(owner!).update({ expiresAt: 1 })
  expect(await fence()).toBe(true)
  expect((await f.control('snapshot_archive_requests').where(owner!).first()).state).toBe('expired')
  expect(await f.control('snapshot_archive_owners')).toHaveLength(1)
  expect(await fence(context, true)).toBe(true)
  expect(await f.control('snapshot_archive_owners')).toHaveLength(0)
  expect(await fence(context, true)).toBe(false)
})

test.each(['missing', 'released'] as const)('recovery refuses a %s request without releasing its owner', async kind => {
  const f = await fixture(),
    input = request()
  const { owner } = await f.requests.claim(identity(), input)
  const context = await Registry.readSnapshotArchiveOwnerGuard(f.control, owner!)
  if (kind === 'missing') await f.control('snapshot_archive_requests').delete()
  else await f.control('snapshot_archive_requests').update({ released: 1 })
  await expect(
    f.control.transaction(trx => Registry.fenceSnapshotArchiveOwnerGuard(trx, context, true))
  ).rejects.toThrow('unavailable')
  expect(await f.control('snapshot_archive_owners')).toHaveLength(1)
})

test('a replaced guard marker or symlink cannot prove recovery of the bound source', async () => {
  const f = await fixture(),
    input = request()
  const { owner } = await f.requests.claim(identity(), input)
  await readGuardedSnapshotArchive(f.control, f.open(), owner!, async () => undefined)
  await f.requests.markCancellation(identity(), input)
  const path = `${f.filename}.snapshot-owner-0.sqlite`
  const metadata = knex({ ...f.config, connection: { filename: path } })
  try {
    await metadata('snapshot_owner_guard').update({ marker: 'invalid' })
  } finally {
    await metadata.destroy()
  }
  await expect(f.recover()).rejects.toThrow('identity changed')
  await rename(path, path + '.retained')
  await symlink(path + '.retained', path)
  await expect(f.recover()).rejects.toThrow('identity changed')
  expect(Number((await f.control('snapshot_archive_capacity').first()).archives)).toBe(1)
})

test('a marker changed after preparation is rejected on the guarded physical transaction', async () => {
  const f = await fixture(),
    input = request()
  const { owner } = await f.requests.claim(identity(), input)
  const guard = Backend.withSnapshotArchiveBackendGuard
  jest.spyOn(Backend, 'withSnapshotArchiveBackendGuard').mockImplementationOnce(async (...args) => {
    const metadata = knex({ ...f.config, connection: { filename: `${f.filename}.snapshot-owner-0.sqlite` } })
    try {
      await metadata('snapshot_owner_guard').update({ marker: 'a'.repeat(64) })
    } finally {
      await metadata.destroy()
    }
    return await guard(...args)
  })
  const read = jest.fn()
  await expect(readGuardedSnapshotArchive(f.control, f.open(), owner!, read)).rejects.toThrow('identity changed')
  expect(read).not.toHaveBeenCalled()
})

test('SQLite guards require WAL and reject a different physical database', async () => {
  const f = await fixture()
  await f.control.raw('PRAGMA journal_mode = DELETE')
  await expect(Backend.prepareSnapshotArchiveGuardBackend(f.control, 0, null)).rejects.toThrow('identity changed')
  await f.control.raw('PRAGMA journal_mode = WAL')
  const binding = await Backend.prepareSnapshotArchiveGuardBackend(f.control, 0, null)
  const other = await fixture()
  await expect(Backend.assertSnapshotArchiveGuardBackend(other.control, binding)).rejects.toThrow('identity changed')
})

test('guard creation preserves an independent filesystem failure', async () => {
  const f = await fixture()
  const failure = Object.assign(new Error('fixture storage full'), { code: 'ENOSPC' })
  jest.spyOn(filesystem, 'open').mockRejectedValueOnce(failure)
  await expect(Backend.prepareSnapshotArchiveGuardBackend(f.control, 0, null)).rejects.toBe(failure)
})

test('guard preparation rejects an inode replaced during metadata inspection', async () => {
  const f = await fixture()
  await Backend.prepareSnapshotArchiveGuardBackend(f.control, 0, null)
  const path = `${f.filename}.snapshot-owner-0.sqlite`
  const main = await filesystem.lstat(f.filename, { bigint: true })
  const before = await filesystem.lstat(path, { bigint: true })
  const after = await filesystem.lstat(path, { bigint: true })
  after.ino += 1n
  jest.spyOn(filesystem, 'lstat').mockResolvedValueOnce(main).mockResolvedValueOnce(before).mockResolvedValueOnce(after)
  await expect(Backend.prepareSnapshotArchiveGuardBackend(f.control, 0, null)).rejects.toThrow('identity changed')
})

test('a disconnected main database cannot select a guard from configuration alone', async () => {
  const f = await fixture()
  const raw = f.control.raw.bind(f.control)
  const probe = {
    client: f.control.client,
    raw: (sql: string) => (sql === 'PRAGMA database_list' ? raw('SELECT 1 AS absent') : raw(sql))
  } as unknown as Knex
  await expect(Backend.prepareSnapshotArchiveGuardBackend(probe, 0, null)).rejects.toThrow('identity changed')
})

test('physical connection rechecks both main and guard inode identity', async () => {
  const f = await fixture()
  const binding = await Backend.prepareSnapshotArchiveGuardBackend(f.control, 0, null)
  const main = await filesystem.lstat(f.filename, { bigint: true })
  main.ino += 1n
  const changedMain = jest.spyOn(filesystem, 'lstat').mockResolvedValueOnce(main)
  await expect(Backend.assertSnapshotArchiveGuardBackend(f.control, binding)).rejects.toThrow('identity changed')
  changedMain.mockRestore()
  const mainActual = await filesystem.lstat(f.filename, { bigint: true })
  const guard = await filesystem.lstat(`${f.filename}.snapshot-owner-0.sqlite`, { bigint: true })
  guard.ino += 1n
  jest.spyOn(filesystem, 'lstat').mockResolvedValueOnce(mainActual).mockResolvedValueOnce(guard)
  await expect(Backend.assertSnapshotArchiveGuardBackend(f.control, binding)).rejects.toThrow('identity changed')
})

test('an absent owner cannot enter backend preparation', async () => {
  const f = await fixture()
  await expect(
    Registry.readSnapshotArchiveOwnerGuard(f.control, {
      identityKey: identity(),
      requestId: 'a'.repeat(64),
      claimToken: 'b'.repeat(64)
    })
  ).rejects.toThrow('unavailable')
})

test('a concurrent exact acknowledgement makes an old recovery proof harmless', async () => {
  const f = await fixture(),
    input = request()
  const { owner } = await f.requests.claim(identity(), input)
  await readGuardedSnapshotArchive(f.control, f.open(), owner!, async () => undefined)
  await f.requests.markCancellation(identity(), input)
  const guard = Backend.withSnapshotArchiveBackendGuard
  jest.spyOn(Backend, 'withSnapshotArchiveBackendGuard').mockImplementationOnce(async (...args) => {
    await f.requests.sourceClosed(owner!)
    return await guard(...args)
  })
  await f.recover()
  expect(await f.control('snapshot_archive_owners')).toHaveLength(0)
  expect(Number((await f.control('snapshot_archive_capacity').first()).archives)).toBe(0)
})
