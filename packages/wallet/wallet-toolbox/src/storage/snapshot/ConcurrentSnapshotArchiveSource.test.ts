import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { knex } from 'knex'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
import { seedArchiveClosure } from '../../../test/utils/snapshotArchiveFixtures'
import { KnexSnapshotArchiveStore } from './archive/KnexSnapshotArchiveStore'
import { KnexSnapshotArchiveRequestStore } from './archive/KnexSnapshotArchiveRequestStore'
import { snapshotArchiveRequestId } from './archive/SnapshotArchiveRequest'
import { captureSnapshotArchiveSource } from './archive/captureSnapshotArchiveSource'
import { verifySnapshotArchiveDirectory } from './archive/SnapshotArchiveDirectory'
import * as ArchiveGuard from './archive/SnapshotArchiveGuard'
import { SnapshotArchiveSourceCleanupError } from './archive/KnexSnapshotArchiveSource'

const identity = '02' + '11'.repeat(32)
const stores: StorageKnex[] = []
const directories: string[] = []
function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'owned-archive-source-'))
  directories.push(directory)
  const storage = new StorageKnex({
    ...StorageProvider.createStorageBaseOptions('test'),
    knex: knex({
      client: 'better-sqlite3',
      connection: { filename: join(directory, 'wallet.sqlite') },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
  })
  stores.push(storage)
  await storage.knex.raw('PRAGMA journal_mode = WAL')
  await storage.migrate('original source', 'original-source')
  await storage.makeAvailable()
  const { user } = await storage.findOrInsertUser(identity)
  const { user: other } = await storage.findOrInsertUser('03' + '22'.repeat(32))
  await seedArchiveClosure(storage, user.userId, other.userId)
  return storage
}
afterEach(async () => {
  jest.restoreAllMocks()
  await Promise.all(stores.splice(0).map(store => store.destroy()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

test('a ready request waits for owned reader destruction while foreground storage remains usable', async () => {
  const storage = await fixture()
  expect(await storage.supportsSnapshotArchiveSource()).toBe(true)
  expect(Reflect.get(storage, 'snapshotSyncSource')).toBeUndefined()
  const requests = new KnexSnapshotArchiveRequestStore(storage.knex)
  const archives = new KnexSnapshotArchiveStore(storage.knex)
  const fields = {
    version: 1 as const,
    nonce: 'b'.repeat(64),
    notAfter: Date.now() + 300000,
    maxBytes: 32768
  }
  const input = { ...fields, requestId: snapshotArchiveRequestId(fields) }
  const admitted = await requests.claim(identity, input)
  const source = (await storage.openSnapshotArchiveSource(identity))!
  expect(source.user.identityKey).toBe(identity)
  expect(source.sourceStorage.storageIdentityKey).toBe('original-source')
  expect(source.sourceSchema).toBe('2026-10-01-005 add snapshot certificate field key indexes')
  const reader = Reflect.get(storage, 'snapshotSyncSource') as StorageKnex
  expect(reader.knex).not.toBe(storage.knex)
  expect(reader.knex.client.config.pool).toMatchObject({ min: 0, max: 1 })
  const entered = gate()
  const finish = gate()
  const destroy = reader.destroy.bind(reader)
  const intercept = jest.spyOn(reader, 'destroy').mockImplementation(async () => {
    entered.resolve()
    await finish.promise
    await destroy()
  })
  let settled = false
  const pending = captureSnapshotArchiveSource(
    source,
    {
      begin: binding => requests.begin(admitted.owner!, binding),
      append: (writer, page) => archives.append(writer, page),
      seal: writer => requests.seal(admitted.owner!, writer),
      close: () => requests.close(identity, input.requestId, 'failed')
    },
    identity,
    'test'
  ).finally(() => {
    settled = true
  })
  void pending.catch(() => undefined)
  try {
    await Promise.race([
      entered.promise,
      pending.then(() => {
        throw new Error('Capture completed before physical close')
      })
    ])
    expect(settled).toBe(false)
    expect((await requests.status(identity, input.requestId)).state).toBe('building')
    expect((await storage.knex('snapshot_archives').first()).state).toBe('building')
    await expect(storage.getSnapshotSync()!.openSource(identity)).rejects.toThrow('opening or active')
    await storage.knex('tx_labels').where({ txLabelId: 1 }).update({ label: 'foreground write after capture' })
    finish.resolve()
    const manifest = await pending
    expect(Reflect.get(storage, 'snapshotSyncSource')).toBeUndefined()
    expect((await requests.status(identity, input.requestId)).state).toBe('ready')
    const verified = verifySnapshotArchiveDirectory(await archives.directory(identity, manifest.archiveId), {
      identityKey: identity,
      chain: 'test',
      sourceStorageIdentityKey: 'original-source',
      digest: manifest.digest
    })
    expect(verified.manifest).toEqual(manifest)
    const next = (await storage.getSnapshotSync()!.openSource(identity))!
    await next.close()
    await requests.close(identity, input.requestId)
    expect((await storage.knex('snapshot_archive_capacity').first()).archives).toBe(0)
  } finally {
    finish.resolve()
    await pending.catch(() => undefined)
    intercept.mockRestore()
  }
})

test('provider destruction closes its archive reader and fences further admission', async () => {
  const storage = await fixture()
  const source = (await storage.openSnapshotArchiveSource(identity))!
  await storage.destroy()
  await source.closed
  expect(source.isOpen).toBe(false)
  expect(await storage.supportsSnapshotArchiveSource()).toBe(false)
  await expect(storage.openSnapshotArchiveSource(identity)).rejects.toThrow('destruction begins')
})

test('cancellation after source acquisition closes the owned pool before any archive is reserved', async () => {
  const storage = await fixture()
  const source = (await storage.openSnapshotArchiveSource(identity))!
  const controller = new AbortController()
  controller.abort()
  await expect(
    captureSnapshotArchiveSource(source, new KnexSnapshotArchiveStore(storage.knex), identity, 'test', {
      signal: controller.signal
    })
  ).rejects.toThrow('cancelled')
  expect(Reflect.get(storage, 'snapshotSyncSource')).toBeUndefined()
  expect(await storage.knex('snapshot_archives')).toHaveLength(0)
})

test('unsupported in-memory SQLite does not construct a dedicated archive reader', async () => {
  const storage = new StorageKnex({
    ...StorageProvider.createStorageBaseOptions('test'),
    knex: knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    })
  })
  stores.push(storage)
  expect(await storage.supportsSnapshotArchiveSource()).toBe(false)
  expect(await storage.openSnapshotArchiveSource(identity)).toBeUndefined()
  expect(Reflect.get(storage, 'snapshotSyncSource')).toBeUndefined()
})

test('one admitted recovery flight remains drained by destruction while foreground reads continue', async () => {
  const storage = await fixture()
  const entered = gate()
  const finish = gate()
  const recover = ArchiveGuard.recoverSnapshotArchiveGuards
  const recovery = jest.spyOn(ArchiveGuard, 'recoverSnapshotArchiveGuards').mockImplementation(async (...args) => {
    entered.resolve()
    await finish.promise
    await recover(...args)
  })
  const destroy = jest.spyOn(storage.knex.client, 'destroy')
  const first = storage.recoverSnapshotArchiveSources()
  const second = storage.recoverSnapshotArchiveSources()
  expect(second).toBe(first)
  let destruction: Promise<void> | undefined
  try {
    await entered.promise
    expect((await storage.findUsers({ partial: { identityKey: identity } }))[0].identityKey).toBe(identity)
    destruction = storage.destroy()
    await expect(storage.recoverSnapshotArchiveSources()).rejects.toThrow('after destruction')
    expect(destroy).not.toHaveBeenCalled()
    expect(recovery).toHaveBeenCalledTimes(1)
    finish.resolve()
    await Promise.all([first, destruction])
    expect(destroy).toHaveBeenCalledTimes(1)
    await storage.awaitSnapshotArchiveRecovery()
  } finally {
    finish.resolve()
    await Promise.allSettled([first, destruction])
  }
})

test('failed recovery preserves its error and releases the flight for a later retry', async () => {
  const storage = await fixture()
  const failure = new Error('synthetic recovery enumeration failure')
  const recovery = jest.spyOn(ArchiveGuard, 'recoverSnapshotArchiveGuards').mockRejectedValueOnce(failure)
  await expect(storage.recoverSnapshotArchiveSources()).rejects.toBe(failure)
  await storage.recoverSnapshotArchiveSources()
  expect(recovery).toHaveBeenCalledTimes(2)
  await storage.awaitSnapshotArchiveRecovery()
  expect(await storage.supportsSnapshotArchiveSource()).toBe(true)
})

test('destruction drains a failing admitted recovery and still destroys the foreground pool', async () => {
  const storage = await fixture()
  const entered = gate()
  const finish = gate()
  const failure = new Error('synthetic admitted recovery failure')
  jest.spyOn(ArchiveGuard, 'recoverSnapshotArchiveGuards').mockImplementation(async () => {
    entered.resolve()
    await finish.promise
    throw failure
  })
  const destroy = jest.spyOn(storage.knex.client, 'destroy')
  const recovery = storage.recoverSnapshotArchiveSources()
  void recovery.catch(() => undefined)
  let destruction: Promise<void> | undefined
  try {
    await entered.promise
    destruction = storage.destroy()
    void destruction.catch(() => undefined)
    expect(destroy).not.toHaveBeenCalled()
    finish.resolve()
    await expect(recovery).rejects.toBe(failure)
    await expect(destruction).rejects.toBe(failure)
    expect(destroy).toHaveBeenCalledTimes(1)
    await expect(storage.recoverSnapshotArchiveSources()).rejects.toThrow('after destruction')
  } finally {
    finish.resolve()
    await Promise.allSettled([recovery, destruction])
  }
})

test('unsupported in-memory recovery performs no guard work and idle drainage is safe', async () => {
  const storage = new StorageKnex({
    ...StorageProvider.createStorageBaseOptions('test'),
    knex: knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    })
  })
  stores.push(storage)
  const recovery = jest.spyOn(ArchiveGuard, 'recoverSnapshotArchiveGuards')
  await storage.awaitSnapshotArchiveRecovery()
  await storage.recoverSnapshotArchiveSources()
  expect(recovery).not.toHaveBeenCalled()
})

test('the static MySQL source probe does not construct or acquire a private connection', async () => {
  const storage = new StorageKnex({
    ...StorageProvider.createStorageBaseOptions('test'),
    knex: knex({
      client: 'mysql2',
      connection: {
        host: '127.0.0.1',
        port: 1,
        database: 'synthetic_unconnected_probe'
      },
      pool: { min: 0, max: 1 }
    })
  })
  stores.push(storage)
  const acquire = jest.spyOn(storage.knex.client, 'acquireConnection').mockRejectedValue(new Error('Unexpected I/O'))
  expect(await storage.supportsSnapshotArchiveSource()).toBe(true)
  expect(acquire).not.toHaveBeenCalled()
  expect(Reflect.get(storage, 'snapshotSyncSource')).toBeUndefined()
})

test.each(['opening', 'closing'] as const)(
  'unproved guarded source cleanup during %s preserves ownership and permanently fences its provider',
  async phase => {
    const storage = await fixture()
    const requests = new KnexSnapshotArchiveRequestStore(storage.knex, true, true)
    const offered = await requests.offer(identity, {
      lifetimeMs: 300000,
      maxBytes: 32768
    })
    const { owner } = await requests.claimReader(identity, offered.request)
    const failure = new SnapshotArchiveSourceCleanupError(new Error('synthetic native cleanup outcome'))
    const read = ArchiveGuard.readGuardedSnapshotArchive
    let native: { open: boolean; close: () => void } | undefined
    if (phase === 'opening') jest.spyOn(ArchiveGuard, 'readGuardedSnapshotArchive').mockRejectedValueOnce(failure)
    else {
      jest.spyOn(ArchiveGuard, 'readGuardedSnapshotArchive').mockImplementationOnce(async (...args) => {
        jest.spyOn(args[1].client, 'destroyRawConnection').mockImplementation(async connection => {
          native = connection
        })
        return await read(...args)
      })
    }
    let received: unknown
    try {
      try {
        const source = (await storage.openSnapshotArchiveSource(identity, {}, owner))!
        await source.close()
      } catch (error) {
        received = error
      }
      expect(received).toBeInstanceOf(SnapshotArchiveSourceCleanupError)
      if (phase === 'opening') expect(received).toBe(failure)
      else expect(native?.open).toBe(true)
      expect(await storage.knex('snapshot_archive_owners')).toHaveLength(1)
      expect((await storage.knex('snapshot_archive_capacity').first()).archives).toBe(1)
      expect(Reflect.get(storage, 'snapshotSyncSource')).toBeDefined()
      expect(await storage.supportsSnapshotArchiveSource()).toBe(false)
      await expect(storage.openSnapshotArchiveSource(identity, {}, owner)).rejects.toThrow()
      await expect(storage.getSnapshotSync()!.openSource(identity)).rejects.toThrow('destruction begins')
      await expect(storage.recoverSnapshotArchiveSources()).rejects.toThrow('after destruction')
      await expect(storage.destroy()).rejects.toBe(received)
    } finally {
      jest.restoreAllMocks()
      // Only the synthetic fixture may prove and close this intentionally retained native connection.
      if (native?.open) native.close()
      stores.splice(stores.indexOf(storage), 1)
      await storage.destroy().catch(error => {
        expect(error).toBe(received)
      })
    }
  }
)

test.each([new Error('synthetic guarded read failure'), undefined])(
  'an ordinary guarded read failure %p preserves its error but releases a physically cleaned reader',
  async failure => {
    const storage = await fixture()
    const requests = new KnexSnapshotArchiveRequestStore(storage.knex, true, true)
    const offered = await requests.offer(identity, {
      lifetimeMs: 300000,
      maxBytes: 32768
    })
    const { owner } = await requests.claimReader(identity, offered.request)
    jest.spyOn(ArchiveGuard, 'readGuardedSnapshotArchive').mockRejectedValueOnce(failure)
    await expect(storage.openSnapshotArchiveSource(identity, {}, owner)).rejects.toBe(failure)
    expect(await storage.supportsSnapshotArchiveSource()).toBe(true)
    expect(Reflect.get(storage, 'snapshotSyncSource')).toBeUndefined()
    const source = (await storage.openSnapshotArchiveSource(identity, {}, owner))!
    expect(source.user.identityKey).toBe(identity)
    await source.close()
    await requests.sourceClosed(owner!)
    expect(await storage.knex('snapshot_archive_owners')).toHaveLength(0)
  }
)

test('destroying an active guarded reader preserves its ordinary read error for the consumer after proved cleanup', async () => {
  const storage = await fixture()
  const requests = new KnexSnapshotArchiveRequestStore(storage.knex, true, true)
  const offered = await requests.offer(identity, { lifetimeMs: 300000, maxBytes: 32768 })
  const { owner } = await requests.claimReader(identity, offered.request)
  const failure = new Error('synthetic read completion failure after native closure')
  const read = ArchiveGuard.readGuardedSnapshotArchive
  jest.spyOn(ArchiveGuard, 'readGuardedSnapshotArchive').mockImplementationOnce(async (...args) => {
    await read(...args)
    throw failure
  })
  const source = (await storage.openSnapshotArchiveSource(identity, {}, owner))!
  const reader = Reflect.get(storage, 'snapshotSyncSource') as StorageKnex
  const consumer = source.closed.catch(error => error)
  await expect(reader.destroy()).resolves.toBeUndefined()
  expect(await consumer).toBe(failure)
  await expect(reader.knex.raw('SELECT 1')).rejects.toThrow('Unable to acquire a connection')
  await requests.sourceClosed(owner!)
  expect(await storage.knex('snapshot_archive_owners')).toHaveLength(0)
})
