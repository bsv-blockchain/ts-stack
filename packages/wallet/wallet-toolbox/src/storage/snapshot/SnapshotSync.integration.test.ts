import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { knex } from 'knex'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
import { WalletStorageManager } from '../WalletStorageManager'
import { snapshotSyncTables, type SnapshotSyncCheckpoint, type SnapshotSyncStorage } from './SnapshotSync'
import type { WalletReadSnapshot } from './WalletReadSnapshot'
import { runSnapshotSyncSession } from './runSnapshotSyncSession'
import { KnexSnapshotSyncDestination } from './KnexSnapshotSyncDestination'
import { SnapshotResourceLimitError } from './SnapshotResourceLimitError'
import { SnapshotCancelledError } from './SnapshotCancelledError'
import { runInSeries } from '../../utility/runInSeries'
import { WERR_UNAUTHORIZED } from '../../sdk/WERR_errors'

const identity = '02' + '11'.repeat(32)
const foreignIdentity = '03' + '22'.repeat(32)
const when = new Date('2026-01-01T00:00:00.000Z')
const stores: StorageKnex[] = []
const directories: string[] = []
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => {
    resolve = r
  })
  return { promise, resolve }
}
const pendingOperations: Promise<unknown>[] = []
function observe<T>(operation: Promise<T>): Promise<T> {
  // Keep secondary cleanup failures attached when a preceding fault assertion
  // fails. Every primary result is still awaited/asserted by its owning test.
  void operation.catch(() => undefined)
  pendingOperations.push(operation)
  return operation
}
async function waitForBoundary(boundary: Promise<void>, operation: Promise<unknown>): Promise<void> {
  await Promise.race([
    boundary,
    operation.then(() => {
      throw new Error('Operation completed before the required concurrency boundary')
    })
  ])
}
async function fixture(count = 130, wal = true, disabled?: 'source' | 'destination') {
  const directory = await mkdtemp(join(tmpdir(), 'wallet-snapshot-sync-'))
  directories.push(directory)
  async function open(name: string, snapshotSync = true) {
    const store = new StorageKnex({
      ...StorageProvider.createStorageBaseOptions('test'),
      snapshotSync,
      knex: knex({
        client: 'better-sqlite3',
        connection: { filename: join(directory, `${name}.sqlite`) },
        useNullAsDefault: true,
        pool: { min: 1, max: 1 },
        acquireConnectionTimeout: 1000
      })
    })
    stores.push(store)
    if (wal) await store.knex.raw('PRAGMA journal_mode = WAL')
    await store.migrate(name, name)
    await store.makeAvailable()
    const { user } = await store.findOrInsertUser(identity)
    await store.updateUser(user.userId, { activeStorage: 'source' })
    return store
  }
  const source = await open('source', disabled !== 'source')
  const destination = await open('destination', disabled !== 'destination')
  const { user: foreign } = await source.findOrInsertUser(foreignIdentity)
  const user = (await source.findUserByIdentityKey(identity))!
  await runInSeries(
    Array.from({ length: count }, (_, index) => index),
    async index => {
      await source.insertTxLabel({
        txLabelId: 0,
        userId: user.userId,
        created_at: when,
        updated_at: when,
        label: `label-${index}`,
        isDeleted: index % 3 === 0
      })
      await source.insertTxLabel({
        txLabelId: 0,
        userId: foreign.userId,
        created_at: when,
        updated_at: when,
        label: `foreign-${index}`,
        isDeleted: false
      })
    }
  )
  const manager = new WalletStorageManager(identity, source, [destination])
  await manager.makeAvailable()
  return { source, destination, manager, user, open }
}
async function advance(
  view: WalletReadSnapshot,
  destination: SnapshotSyncStorage,
  target: number
): Promise<SnapshotSyncCheckpoint> {
  let checkpoint = await destination.begin(view, view.user.activeStorage)
  while (checkpoint.tableIndex < target) {
    const page = await view.readPage(snapshotSyncTables[checkpoint.tableIndex], checkpoint.cursor)
    const next = (await (await destination.prepare(checkpoint, page))()).checkpoint
    expect(next.sequence).toBe(checkpoint.sequence + 1)
    expect(next.tableIndex).toBe(checkpoint.tableIndex + Number(page.done))
    checkpoint = next
  }
  return checkpoint
}
afterEach(async () => {
  jest.restoreAllMocks()
  await runInSeries(stores.splice(0), store => store.destroy())
  await Promise.allSettled(pendingOperations.splice(0))
  await runInSeries(directories.splice(0), directory => rm(directory, { recursive: true, force: true }))
})

test('ordinary backup yields during preparation while its coherent view excludes foreground changes', async () => {
  const { source, destination, manager, user } = await fixture()
  const legacy = jest.spyOn(destination, 'processSyncChunk')
  const gate = deferred()
  const preparing = deferred()
  const capability = destination.getSnapshotSync()!
  let held = false
  jest.spyOn(destination, 'getSnapshotSync').mockReturnValue({
    ...capability,
    prepare: async (checkpoint, page) => {
      const apply = await capability.prepare(checkpoint, page)
      if (checkpoint.tableIndex === 3 && !held) {
        held = true
        preparing.resolve()
        await gate.promise
      }
      return apply
    }
  })
  const backup = observe(manager.updateBackups())
  try {
    await waitForBoundary(preparing.promise, backup)
    await manager.runAsWriter(async () => {
      await source.findOrInsertTxLabel(user.userId, 'foreground-after-view')
    })
  } finally {
    gate.resolve()
  }
  expect(await backup).toContain('snapshot complete')
  const copied = await destination.findTxLabels({ partial: {} })
  expect(copied).toHaveLength(130)
  expect(copied.every(row => row.label.startsWith('label-'))).toBe(true)
  expect(copied.filter(row => row.isDeleted)).toHaveLength(44)
  expect(legacy).not.toHaveBeenCalled()
  expect(await destination.knex('sync_states')).toHaveLength(0)
  expect(await destination.knex('snapshot_sync_ids').where({ entity: 'txLabel' })).toHaveLength(130)
  await manager.updateBackups()
  expect(await destination.findTxLabels({ partial: {} })).toHaveLength(131)
})

test('lost acknowledgement resumes the durable cursor and rejects a concurrently prepared stale page', async () => {
  const { source, destination } = await fixture(5)
  const view = (await source.getSnapshotSync()!.openSource(identity))!
  const writer = destination.getSnapshotSync()!
  const before = await advance(view, writer, 3)
  const page = await view.readPage('txLabels', before.cursor, { maxRows: 2 })
  const apply = await writer.prepare(before, page)
  const stale = await writer.prepare(before, page)
  await apply()
  const recovered = (await writer.checkpoint(identity, 'source'))!
  expect(recovered.sequence).toBe(before.sequence + 1)
  expect(recovered.cursor).toEqual(page.cursor)
  expect(await writer.begin(view, view.user.activeStorage)).toEqual(recovered)
  await expect(stale()).rejects.toThrow('session changed')
  await expect(apply()).rejects.toThrow('already consumed')
  const rest = await runSnapshotSyncSession(
    { view, destination: writer, activeStorage: view.user.activeStorage, commit: op => op() },
    { maxItems: 2 }
  )
  expect(rest.snapshotCheckpoint?.done).toBe(true)
  expect(await destination.findTxLabels({ partial: {} })).toHaveLength(5)
  await view.close()
})

test('page failure rolls data, mappings and checkpoint back together', async () => {
  const { source, destination } = await fixture(3)
  const view = (await source.getSnapshotSync()!.openSource(identity))!
  const writer = destination.getSnapshotSync()!
  const before = await advance(view, writer, 3)
  await destination.knex.raw(
    "CREATE TRIGGER reject_checkpoint BEFORE UPDATE ON snapshot_sync_sessions BEGIN SELECT RAISE(ABORT, 'checkpoint disk failure'); END"
  )
  await expect((await writer.prepare(before, await view.readPage('txLabels')))()).rejects.toThrow(
    'checkpoint disk failure'
  )
  expect(await destination.findTxLabels({ partial: {} })).toHaveLength(0)
  expect(await destination.knex('snapshot_sync_ids').where({ entity: 'txLabel' })).toHaveLength(0)
  expect(await writer.checkpoint(identity, 'source')).toEqual(before)
  await destination.knex.raw('DROP TRIGGER reject_checkpoint')
  await (
    await writer.prepare(before, await view.readPage('txLabels'))
  )()
  expect(await destination.findTxLabels({ partial: {} })).toHaveLength(3)
  await view.close()
})

test.each(['before-row', 'before-checkpoint', 'before-commit', 'after-commit'] as const)(
  'a process killed %s recovers the atomic page outcome from its durable database',
  async boundary => {
    const { source, destination } = await fixture(3)
    const view = (await source.getSnapshotSync()!.openSource(identity))!
    const writer = destination.getSnapshotSync()!
    const before = await advance(view, writer, 3)
    const page = await view.readPage('txLabels', before.cursor, { maxRows: 2 })
    const filename = (destination.knex.client.config.connection as { filename: string }).filename
    // Use the built package in a separate process: SIGKILL bypasses transaction
    // catch/finally handlers, exercising the database's actual crash recovery.
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
      const { knex } = require('knex')
      const { StorageKnex } = require('./out/src/storage/StorageKnex.js')
      const input = JSON.parse(process.argv[1], (key, value) =>
        key === 'created_at' || key === 'updated_at' ? new Date(value) : value)
      const storage = new StorageKnex({ ...StorageKnex.defaultOptions(), chain: 'test',
        knex: knex({ client: 'better-sqlite3', connection: { filename: input.filename },
          useNullAsDefault: true, pool: { min: 1, max: 1 } }) })
      async function hold() { process.send('at-boundary'); await new Promise(() => {}) }
      async function run() {
        await storage.makeAvailable()
        if (input.boundary === 'before-row') {
          const insert = storage.insertTxLabel.bind(storage)
          storage.insertTxLabel = async (...args) => { await hold(); return insert(...args) }
        }
        if (input.boundary === 'before-checkpoint') {
          const find = storage.findUsers.bind(storage)
          let reads = 0
          storage.findUsers = async (...args) => {
            if (++reads === 2) await hold()
            return find(...args)
          }
        }
        if (input.boundary === 'before-commit') {
          const transaction = storage.transaction.bind(storage)
          storage.transaction = (work, token) => transaction(async trx => {
            const result = await work(trx)
            await hold()
            return result
          }, token)
        }
        await (await storage.getSnapshotSync().prepare(input.before, input.page))()
        if (input.boundary === 'after-commit') await hold()
        throw new Error('Did not reach the requested boundary')
      }
      run().catch(error => { process.send({ error: error.message }); process.exitCode = 1 })
    `,
        JSON.stringify({ filename, boundary, before, page })
      ],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
    )
    let diagnostic = ''
    child.stderr!.on('data', data => {
      diagnostic += String(data)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Child did not reach ${boundary}: ${diagnostic}`)), 10000)
        child.once('message', message => {
          clearTimeout(timer)
          if (message === 'at-boundary') resolve()
          else reject(new Error(JSON.stringify(message)))
        })
        child.once('error', error => {
          clearTimeout(timer)
          reject(error)
        })
        child.once('exit', () => {
          clearTimeout(timer)
          reject(new Error(`Child exited early: ${diagnostic}`))
        })
      })
      const exited = once(child, 'exit')
      expect(child.kill('SIGKILL')).toBe(true)
      expect(await exited).toEqual([null, 'SIGKILL'])
      const committed = boundary === 'after-commit'
      const recovered = (await writer.checkpoint(identity, 'source'))!
      expect(recovered.sequence).toBe(before.sequence + Number(committed))
      expect(recovered.cursor).toEqual(committed ? page.cursor : before.cursor)
      expect(await destination.findTxLabels({ partial: {} })).toHaveLength(committed ? 2 : 0)
      expect(await destination.knex('snapshot_sync_ids').where({ entity: 'txLabel' })).toHaveLength(committed ? 2 : 0)
      expect((await destination.knex.raw('PRAGMA integrity_check'))[0].integrity_check).toBe('ok')
      expect(await destination.knex.raw('PRAGMA foreign_key_check')).toEqual([])
      await runSnapshotSyncSession(
        { view, destination: writer, activeStorage: view.user.activeStorage, commit: op => op() },
        { maxItems: 2 }
      )
      expect(await destination.findTxLabels({ partial: {} })).toHaveLength(3)
      expect(await destination.knex('snapshot_sync_ids').where({ entity: 'txLabel' })).toHaveLength(3)
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      }
      await view.close()
    }
  }
)

test('source replacement fences old pages without replacing legacy checkpoint JSON', async () => {
  const { source, destination } = await fixture(4)
  await destination.findOrInsertSyncStateAuth(
    { identityKey: identity, userId: (await destination.findUserByIdentityKey(identity))!.userId },
    'source',
    'source'
  )
  const legacyBytes = (await destination.knex('sync_states').first()).syncMap
  const writer = destination.getSnapshotSync()!
  const oldView = (await source.getSnapshotSync()!.openSource(identity))!
  const old = await advance(oldView, writer, 3)
  const stale = await writer.prepare(old, await oldView.readPage('txLabels'))
  await oldView.close()
  const fresh = (await source.getSnapshotSync()!.openSource(identity))!
  const started = await writer.begin(fresh, fresh.user.activeStorage)
  expect(started.sequence).toBe(0)
  expect(started.sessionId).not.toBe(old.sessionId)
  await expect(stale()).rejects.toThrow('session changed')
  await runSnapshotSyncSession(
    { view: fresh, destination: writer, activeStorage: fresh.user.activeStorage, commit: op => op() },
    {}
  )
  expect((await destination.knex('sync_states').first()).syncMap).toBe(legacyBytes)
  expect(await destination.findTxLabels({ partial: {} })).toHaveLength(4)
  await fresh.close()
})

test('independent primary change rejects prepared data', async () => {
  const { source, destination } = await fixture(1)
  const view = (await source.getSnapshotSync()!.openSource(identity))!
  const writer = destination.getSnapshotSync()!
  const before = await advance(view, writer, 3)
  const apply = await writer.prepare(before, await view.readPage('txLabels'))
  await destination.knex('users').where({ identityKey: identity }).update({ activeStorage: 'another-primary' })
  await expect(apply()).rejects.toThrow('session changed')
  expect(await destination.findTxLabels({ partial: {} })).toHaveLength(0)
  await view.close()
})

test('an independent away-and-back primary transition cannot revive an old session', async () => {
  const { source, destination } = await fixture(1)
  const view = (await source.getSnapshotSync()!.openSource(identity))!
  const writer = destination.getSnapshotSync()!
  const before = await advance(view, writer, 3)
  const apply = await writer.prepare(before, await view.readPage('txLabels'))
  await destination.knex('users').where({ identityKey: identity }).update({ activeStorage: 'another-primary' })
  await destination.knex('users').where({ identityKey: identity }).update({ activeStorage: 'source' })
  await expect(apply()).rejects.toThrow('session changed')
  await expect(writer.begin(view, view.user.activeStorage)).rejects.toThrow('binding changed')
  expect(await destination.findTxLabels({ partial: {} })).toHaveLength(0)
  await view.close()
})

test('cancellation during commit reports durable outcome and releases source capacity', async () => {
  const { source, destination, manager } = await fixture(3)
  const controller = new AbortController()
  const capability = destination.getSnapshotSync()!
  jest.spyOn(destination, 'getSnapshotSync').mockReturnValue({
    ...capability,
    prepare: async (checkpoint, page) => {
      const apply = await capability.prepare(checkpoint, page)
      return async () => {
        const result = await apply()
        if (checkpoint.tableIndex === 3) controller.abort()
        return result
      }
    }
  })
  const result = await manager.syncToWriterResumable(await manager.getAuth(), destination, {
    signal: controller.signal,
    maxItems: 1
  })
  expect(result.status).toBe('cancelled')
  expect(result.snapshotCheckpoint).toEqual(await capability.checkpoint(identity, 'source'))
  expect(await destination.findTxLabels({ partial: {} })).toHaveLength(1)
  const next = await source.getSnapshotSync()!.openSource(identity)
  expect(next).toBeDefined()
  await next!.close()
})

test('non-WAL SQLite preserves legacy serialized backup', async () => {
  const { source, destination, manager } = await fixture(2, false)
  expect(await source.getSnapshotSync()!.openSource(identity)).toBeUndefined()
  const legacy = jest.spyOn(destination, 'processSyncChunk')
  await manager.updateBackups()
  expect(legacy).toHaveBeenCalled()
  expect(await destination.findTxLabels({ partial: {} })).toHaveLength(2)
  expect(await destination.knex('snapshot_sync_sessions')).toHaveLength(0)
  expect((await manager.syncToWriterResumable(await manager.getAuth(), destination)).mode).toBe('exclusive')
})

test('a backup borrowing an existing exclusive owner keeps the legacy reentrancy contract', async () => {
  const { source, destination, manager } = await fixture(2)
  const capability = jest.spyOn(source, 'getSnapshotSync')
  const legacy = jest.spyOn(destination, 'processSyncChunk')
  const log = await manager.runAsSync(active => manager.updateBackups(active))
  expect(log).toContain('BACKUP CURRENT ACTIVE TO 1 STORES')
  expect(capability).not.toHaveBeenCalled()
  expect(legacy).toHaveBeenCalled()
  expect(await destination.findTxLabels({ partial: {} })).toHaveLength(2)
  expect(await destination.knex('snapshot_sync_sessions')).toHaveLength(0)
})

test.each([false, true])('primary replacement fences a pending legacy backup (switch back: %s)', async switchBack => {
  const { source, destination, manager } = await fixture(2, false)
  const entered = deferred()
  const release = deferred()
  const capability = source.getSnapshotSync()!
  jest.spyOn(source, 'getSnapshotSync').mockReturnValue({
    ...capability,
    openSource: async (...args) => {
      entered.resolve()
      await release.promise
      return await capability.openSource(...args)
    }
  })
  const copying = observe(manager.updateBackups())
  let merge: jest.SpyInstance | undefined
  let read: jest.SpyInstance | undefined
  try {
    await waitForBoundary(entered.promise, copying)
    await manager.setActive('destination')
    if (switchBack) await manager.setActive('source')
    merge = jest.spyOn(destination, 'processSyncChunk')
    read = jest.spyOn(source, 'getSyncChunk')
  } finally {
    release.resolve()
  }
  await expect(copying).rejects.toThrow('primary generation changed')
  expect(read).not.toHaveBeenCalled()
  expect(merge).not.toHaveBeenCalled()
  expect(manager.getActiveStore()).toBe(switchBack ? 'source' : 'destination')
})

test('cancellation before source admission leaves durable session state untouched', async () => {
  const { source, destination, manager } = await fixture(1)
  const capability = source.getSnapshotSync()!
  const opening = jest.fn(capability.openSource)
  jest.spyOn(source, 'getSnapshotSync').mockReturnValue({ ...capability, openSource: opening })
  const controller = new AbortController()
  controller.abort()
  expect(
    await manager.syncToWriterResumable(await manager.getAuth(), destination, { signal: controller.signal })
  ).toEqual({
    status: 'cancelled',
    mode: 'paged',
    pages: 0,
    inserts: 0,
    updates: 0
  })
  expect(opening).not.toHaveBeenCalled()
  expect(await destination.knex('snapshot_sync_sessions')).toHaveLength(0)
  expect(await destination.findTxLabels({ partial: {} })).toHaveLength(0)
})

test('destroy during the SQLite WAL probe rejects opening before creating a private reader', async () => {
  const { source } = await fixture(0)
  const entered = deferred()
  const release = deferred()
  jest.spyOn(source.knex.client, 'raw').mockImplementationOnce(() => {
    entered.resolve()
    return release.promise.then(() => [{ journal_mode: 'wal' }]) as never
  })
  const privateReader = jest.spyOn(StorageKnex.prototype, 'openWalletReadSnapshot')
  const opening = observe(source.getSnapshotSync()!.openSource(identity))
  let destroying: Promise<void> | undefined
  try {
    await waitForBoundary(entered.promise, opening)
    destroying = observe(source.destroy())
  } finally {
    release.resolve()
  }
  await expect(opening).rejects.toThrow('destruction')
  await destroying
  expect(privateReader).not.toHaveBeenCalled()
})

const primaryCopyModes = ['snapshot', 'non-WAL', 'disabled-source', 'disabled-destination', 'resource-limit'] as const
async function primaryCopyFixture(mode: (typeof primaryCopyModes)[number]) {
  const result = await fixture(
    1,
    mode !== 'non-WAL',
    mode === 'disabled-source' ? 'source' : mode === 'disabled-destination' ? 'destination' : undefined
  )
  if (mode === 'resource-limit') {
    const capability = result.source.getSnapshotSync()!
    jest.spyOn(result.source, 'getSnapshotSync').mockReturnValue({
      ...capability,
      openSource: async () => {
        throw new SnapshotResourceLimitError('Synthetic retention admission limit')
      }
    })
  }
  // The manager deliberately retains its earlier primary while an independent
  // writer records a newer source selection. Push must forward the stored row.
  await result.source.updateUser(result.user.userId, {
    activeStorage: 'new-primary',
    updated_at: new Date('2030-01-01T00:00:00.000Z')
  })
  expect(result.manager.getActiveUser().activeStorage).toBe('source')
  return result
}

describe.each(primaryCopyModes)('primary metadata through %s', mode => {
  test.each(['push', 'resumable-push', 'backup', 'borrowed-push'] as const)(
    '%s preserves the newer source selection',
    async operation => {
      const { source, destination, manager, user } = await primaryCopyFixture(mode)
      const auth = await manager.getAuth()
      if (operation === 'push') await manager.syncToWriter(auth, destination)
      else if (operation === 'resumable-push') await manager.syncToWriterResumable(auth, destination)
      else if (operation === 'backup') await manager.updateBackups()
      else await manager.runAsSync(active => manager.syncToWriter(auth, destination, active))
      expect((await destination.findUserByIdentityKey(identity))!.activeStorage).toBe('new-primary')
      expect((await source.findUserByIdentityKey(identity))!.activeStorage).toBe('new-primary')
      expect(await source.findTxLabels({ partial: { userId: user.userId } })).toHaveLength(1)
      expect(await destination.findTxLabels({ partial: {} })).toHaveLength(1)
    }
  )

  test.each(['pull', 'resumable-pull'] as const)('%s retains the destination selection', async operation => {
    const { source, destination } = await primaryCopyFixture(mode)
    const user = (await destination.findUserByIdentityKey(identity))!
    await destination.updateUser(user.userId, { activeStorage: 'destination' })
    const manager = new WalletStorageManager(identity, destination)
    await manager.makeAvailable()
    if (operation === 'pull') await manager.syncFromReader(identity, source)
    else await manager.syncFromReaderResumable(identity, source)
    expect((await destination.findUserByIdentityKey(identity))!.activeStorage).toBe('destination')
    expect((await source.findUserByIdentityKey(identity))!.activeStorage).toBe('new-primary')
    expect(await destination.findTxLabels({ partial: {} })).toHaveLength(1)
  })
})

test.each(['provider', 'adapter'] as const)(
  'snapshot pull through a %s preserves the active destination and remaps into an occupied profile',
  async kind => {
    const { source, destination } = await fixture(4)
    const { user: foreign } = await destination.findOrInsertUser(foreignIdentity)
    await destination.findOrInsertTxLabel(foreign.userId, 'foreign-existing')
    const user = (await destination.findUserByIdentityKey(identity))!
    await destination.updateUser(user.userId, { activeStorage: 'destination' })
    const manager = new WalletStorageManager(identity, destination)
    await manager.makeAvailable()
    const reader =
      kind === 'provider'
        ? source
        : {
            makeAvailable: source.makeAvailable.bind(source),
            getSyncChunk: source.getSyncChunk.bind(source),
            getSnapshotSync: source.getSnapshotSync.bind(source)
          }
    const legacy = jest.spyOn(destination, 'processSyncChunk')
    const result = await manager.syncFromReaderResumable(identity, reader, { maxItems: 2 })
    expect(legacy).not.toHaveBeenCalled()
    expect(result.snapshotCheckpoint?.done).toBe(true)
    expect((await destination.findUserByIdentityKey(identity))!.activeStorage).toBe('destination')
    expect(await destination.findTxLabels({ partial: { userId: user.userId } })).toHaveLength(4)
    expect(await destination.findTxLabels({ partial: { userId: foreign.userId } })).toHaveLength(1)
  }
)

test('typed cancellation during source reading awaits cleanup and returns the last durable checkpoint', async () => {
  const { source, destination, manager } = await fixture(3)
  const controller = new AbortController()
  const sourceCapability = source.getSnapshotSync()!
  const closing = deferred()
  const release = deferred()
  jest.spyOn(source, 'getSnapshotSync').mockReturnValue({
    ...sourceCapability,
    fallbackOnResourceError: false,
    openSource: async (key, options) => {
      expect(options?.signal).toBe(controller.signal)
      const view = (await sourceCapability.openSource(key, options))!
      return {
        ...view,
        readPage: async (...args) => {
          if (args[0] === 'txLabels') {
            controller.abort()
            throw new SnapshotCancelledError('synthetic cancelled read')
          }
          return await view.readPage(...args)
        },
        close: async () => {
          closing.resolve()
          await release.promise
          await view.close()
        }
      }
    }
  })
  const legacy = jest.spyOn(destination, 'processSyncChunk')
  const pending = observe(
    manager.syncToWriterResumable(await manager.getAuth(), destination, { signal: controller.signal })
  )
  let finished = false
  void pending.then(
    () => {
      finished = true
    },
    () => {
      finished = true
    }
  )
  try {
    await waitForBoundary(closing.promise, pending)
    expect(finished).toBe(false)
    release.resolve()
    const result = await pending
    expect(result).toMatchObject({ status: 'cancelled', pages: 3, mode: 'paged' })
    expect(result.snapshotCheckpoint).toEqual(await destination.getSnapshotSync()!.checkpoint(identity, 'source'))
    expect(legacy).not.toHaveBeenCalled()
    expect(Reflect.get(source, 'snapshotSyncSource')).toBeUndefined()
  } finally {
    release.resolve()
    await pending.catch(() => undefined)
  }
})

test.each(['resource', 'validation', 'cleanup'] as const)(
  'source policy propagates %s failure without selecting fallback or mistaking it for cancellation',
  async failureKind => {
    const { source, destination, manager } = await fixture(1)
    const controller = new AbortController()
    const capability = source.getSnapshotSync()!
    const failure =
      failureKind === 'validation'
        ? new Error('synthetic invalid row')
        : new SnapshotResourceLimitError('synthetic resource failure')
    jest.spyOn(source, 'getSnapshotSync').mockReturnValue({
      ...capability,
      fallbackOnResourceError: false,
      openSource: async (...args) => {
        const view = (await capability.openSource(...args))!
        return {
          ...view,
          readPage: async () => {
            controller.abort()
            throw failureKind === 'cleanup' ? new Error('synthetic row before cleanup failure') : failure
          },
          close: async () => {
            await view.close()
            if (failureKind === 'cleanup') throw failure
          }
        }
      }
    })
    const legacy = jest.spyOn(destination, 'processSyncChunk')
    await expect(
      manager.syncToWriterResumable(await manager.getAuth(), destination, { signal: controller.signal })
    ).rejects.toBe(failure)
    expect(legacy).not.toHaveBeenCalled()
    expect(await destination.findTxLabels({ partial: {} })).toHaveLength(0)
    expect(Reflect.get(source, 'snapshotSyncSource')).toBeUndefined()
  }
)

async function seedClosure(source: StorageKnex, userId: number, otherId: number): Promise<void> {
  const date = when.toISOString()
  const timestamp = { created_at: date, updated_at: date }
  const k = source.knex
  await k('output_baskets').del()
  for (const id of [1, 2, 3]) {
    await k('proven_txs').insert({
      ...timestamp,
      provenTxId: id,
      txid: String(id).repeat(64),
      height: id,
      index: 0,
      merklePath: Buffer.from([id, 0, 255]),
      rawTx: Buffer.from([id, 1, 255]),
      blockHash: 'a'.repeat(64),
      merkleRoot: 'b'.repeat(64)
    })
    await k('transactions').insert({
      ...timestamp,
      transactionId: id,
      userId: id === 2 ? otherId : userId,
      provenTxId: id === 3 ? null : id,
      status: 'completed',
      reference: `tx-${id}`,
      isOutgoing: true,
      satoshis: 0,
      description: `tx-${id}`,
      txid: String(id).repeat(64),
      rawTx: Buffer.from([id, 2, 255]),
      inputBEEF: Buffer.from([id, 3, 255])
    })
    await k('proven_tx_reqs').insert({
      ...timestamp,
      provenTxReqId: id,
      provenTxId: id,
      txid: String(id).repeat(64),
      status: 'completed',
      attempts: 0,
      notified: true,
      history: '{}',
      notify: '{}',
      rawTx: Buffer.from([id, 4, 255]),
      wasBroadcast: true
    })
    await k('output_baskets').insert({
      ...timestamp,
      basketId: id,
      userId: id === 2 ? otherId : userId,
      name: `basket-${id}`,
      isDeleted: id === 3
    })
    await k('outputs').insert({
      ...timestamp,
      outputId: id,
      userId: id === 2 ? otherId : userId,
      transactionId: id,
      basketId: id,
      spendable: false,
      change: true,
      vout: 0,
      satoshis: 1,
      providedBy: 'you',
      purpose: '',
      type: 'P2PKH',
      lockingScript: Buffer.from([id, 5, 255])
    })
    await k('commissions').insert({
      ...timestamp,
      commissionId: id,
      userId: id === 2 ? otherId : userId,
      transactionId: id,
      satoshis: 0,
      keyOffset: 'offset',
      isRedeemed: true,
      lockingScript: Buffer.from([id, 6, 255])
    })
    await k('output_tags').insert({
      ...timestamp,
      outputTagId: id,
      userId: id === 2 ? otherId : userId,
      tag: `tag-${id}`,
      isDeleted: id === 3
    })
    await k('output_tags_map').insert({ ...timestamp, outputTagId: id, outputId: id, isDeleted: id === 3 })
    await k('tx_labels').insert({
      ...timestamp,
      txLabelId: id,
      userId: id === 2 ? otherId : userId,
      label: `label-${id}`,
      isDeleted: id === 3
    })
    await k('tx_labels_map').insert({ ...timestamp, txLabelId: id, transactionId: id, isDeleted: id === 3 })
    await k('certificates').insert({
      ...timestamp,
      certificateId: id,
      userId: id === 2 ? otherId : userId,
      serialNumber: `serial-${id}`,
      type: 'type',
      certifier: identity,
      subject: identity,
      revocationOutpoint: 'a'.repeat(64) + '.0',
      signature: 'signature',
      isDeleted: id === 3
    })
    for (const fieldName of ['a', 'Z', 'é', '😀'])
      await k('certificate_fields').insert({
        ...timestamp,
        certificateId: id,
        userId: id === 2 ? otherId : userId,
        fieldName,
        fieldValue: `value-${id}`,
        masterKey: 'key'
      })
    await k('sync_states').insert({
      ...timestamp,
      syncStateId: id,
      userId: id === 2 ? otherId : userId,
      storageIdentityKey: `peer-${id}`,
      storageName: `peer-${id}`,
      status: 'unknown',
      init: true,
      refNum: `state-${id}`,
      syncMap: '{}',
      when: date
    })
  }
  // Composite positions must handle repeated first keys and preserve deleted mappings.
  await k('output_tags_map').insert({ ...timestamp, outputTagId: 1, outputId: 3, isDeleted: true })
  await k('tx_labels_map').insert({ ...timestamp, txLabelId: 1, transactionId: 3, isDeleted: true })
}

test('all replica relations and packed blobs remap into an occupied destination, including request-only proofs', async () => {
  const { source, destination, manager, user } = await fixture(0)
  const foreign = (await source.findUserByIdentityKey(foreignIdentity))!
  await seedClosure(source, user.userId, foreign.userId)
  const { user: occupied } = await destination.findOrInsertUser(foreignIdentity)
  await destination.insertTransaction({
    transactionId: 0,
    userId: occupied.userId,
    created_at: when,
    updated_at: when,
    status: 'completed',
    reference: 'occupied',
    isOutgoing: false,
    satoshis: 0,
    description: '',
    txid: 'c'.repeat(64)
  })
  await source
    .knex('proven_tx_reqs')
    .where({ provenTxReqId: 1 })
    .update({ notify: JSON.stringify({ transactionIds: [1, 2, 3] }) })
  const insertProof = jest.spyOn(destination, 'insertProvenTx')
  await manager.updateBackups()
  expect(
    insertProof.mock.calls.every(
      ([proof]) => proof.rawTx instanceof Uint8Array && proof.merklePath instanceof Uint8Array
    )
  ).toBe(true)
  const destinationUser = (await destination.findUserByIdentityKey(identity))!
  const transactions = await destination.findTransactions({ partial: { userId: destinationUser.userId } })
  expect(transactions).toHaveLength(2)
  expect(await destination.findProvenTxs({ partial: {} })).toHaveLength(2)
  const outputs = await destination.findOutputs({ partial: { userId: destinationUser.userId } })
  expect(outputs).toHaveLength(2)
  for (const output of outputs) {
    expect(transactions.some(tx => tx.transactionId === output.transactionId)).toBe(true)
    const basket = (await destination.findOutputBaskets({ partial: { basketId: output.basketId } }))[0]
    expect(basket.userId).toBe(destinationUser.userId)
    expect(basket.name).toBe(`basket-${output.lockingScript![0]}`)
    expect(output.lockingScript).toEqual([output.lockingScript![0], 5, 255])
  }
  expect(await destination.findCertificates({ partial: { userId: destinationUser.userId } })).toHaveLength(2)
  expect(await destination.findCertificateFields({ partial: { userId: destinationUser.userId } })).toHaveLength(8)
  expect(await destination.findCommissions({ partial: { userId: destinationUser.userId } })).toHaveLength(2)
  const requests = await destination.findProvenTxReqs({ partial: {} })
  expect(requests).toHaveLength(2)
  expect(JSON.parse(requests.find(row => row.txid === '1'.repeat(64))!.notify).transactionIds.sort()).toEqual(
    transactions.map(tx => tx.transactionId).sort()
  )
  expect(await destination.knex('sync_states')).toHaveLength(0)
  const unchangedRequest = jest.spyOn(destination, 'updateProvenTxReq')
  await manager.updateBackups()
  expect(unchangedRequest).not.toHaveBeenCalled()
  expect(await destination.findTransactions({ partial: { userId: destinationUser.userId } })).toHaveLength(2)
  expect(await destination.findTransactions({ partial: { userId: occupied.userId } })).toHaveLength(1)
})

test.each(['batch', 'history', 'notify', 'updated_at'] as const)(
  'a changed proof-request %s persists once while an unchanged copy stays quiescent',
  async field => {
    const { source, destination, manager, user } = await fixture(0)
    const foreign = (await source.findUserByIdentityKey(foreignIdentity))!
    await seedClosure(source, user.userId, foreign.userId)
    await manager.updateBackups()
    const value = {
      batch: 'batch-a',
      history: JSON.stringify({ notes: [{ what: 'fixture', when: '2026-01-02T00:00:00.000Z' }] }),
      notify: JSON.stringify({ transactionIds: [1, 2, 3] }),
      updated_at: new Date('2026-01-02T00:00:00.000Z')
    }[field]
    // A replicated metadata change need not carry a newer timestamp. Exercise
    // each merge reason independently instead of having updated_at mask it.
    await source
      .knex('proven_tx_reqs')
      .where({ provenTxReqId: 1 })
      .update({
        [field]: value instanceof Date ? value.toISOString() : value
      })
    const writes = jest.spyOn(destination, 'updateProvenTxReq')
    expect(await manager.updateBackups()).toContain('0 inserts, 0 updates')
    expect(writes).toHaveBeenCalledTimes(1)
    const copied = (await destination.findProvenTxReqs({ partial: { txid: '1'.repeat(64) } }))[0]
    if (field === 'notify') {
      const transactions = await destination.findTransactions({
        partial: { userId: (await destination.findUserByIdentityKey(identity))!.userId }
      })
      expect(JSON.parse(copied.notify).transactionIds).toEqual(transactions.map(row => row.transactionId).sort())
      expect(copied.notified).toBe(false)
    } else expect(copied[field]).toEqual(value)
    await destination.updateProvenTxReq(copied.provenTxReqId, { notified: true })
    writes.mockClear()
    expect(await manager.updateBackups()).toContain('0 inserts, 0 updates')
    expect(writes).not.toHaveBeenCalled()
    expect((await destination.findProvenTxReqs({ partial: { provenTxReqId: copied.provenTxReqId } }))[0].notified).toBe(
      true
    )
    if (field === 'batch') {
      await source.updateProvenTxReq(1, { batch: 'conflicting-batch' })
      await expect(manager.updateBackups()).rejects.toThrow('merge batch not equal')
      expect((await destination.findProvenTxReqs({ partial: { provenTxReqId: copied.provenTxReqId } }))[0].batch).toBe(
        'batch-a'
      )
    }
  }
)

test.each([false, true])('primary replacement fences a prepared snapshot page (switch back: %s)', async switchBack => {
  const { destination, manager } = await fixture(3)
  const gate = deferred()
  const preparing = deferred()
  const capability = destination.getSnapshotSync()!
  const applyLatePage = jest.fn()
  jest.spyOn(destination, 'getSnapshotSync').mockReturnValue({
    ...capability,
    prepare: async (checkpoint, page) => {
      const apply = await capability.prepare(checkpoint, page)
      if (checkpoint.tableIndex === 3) {
        applyLatePage.mockImplementation(apply)
        preparing.resolve()
        await gate.promise
        return applyLatePage
      }
      return apply
    }
  })
  const copying = observe(manager.updateBackups())
  try {
    await waitForBoundary(preparing.promise, copying)
    await manager.setActive('destination')
    if (switchBack) await manager.setActive('source')
  } finally {
    gate.resolve()
  }
  await expect(copying).rejects.toThrow('primary generation changed')
  expect(applyLatePage).not.toHaveBeenCalled()
  expect(manager.getActiveStore()).toBe(switchBack ? 'source' : 'destination')
  expect((await destination.findUserByIdentityKey(identity))!.activeStorage).toBe(switchBack ? 'source' : 'destination')
})

test('cancellation while queued never begins the prepared destination page', async () => {
  const { destination, manager } = await fixture(3)
  const controller = new AbortController()
  const entered = deferred()
  const release = deferred()
  let blocking: Promise<void> | undefined
  const copying = observe(
    manager.syncToWriterResumable(await manager.getAuth(), destination, {
      signal: controller.signal,
      onProgress: progress => {
        if (progress.state === 'committing' && progress.snapshotCheckpoint?.tableIndex === 3) {
          blocking = observe(
            manager.runAsWriter(async () => {
              entered.resolve()
              await release.promise
            })
          )
        }
      }
    })
  )
  try {
    await waitForBoundary(entered.promise, copying)
    controller.abort()
  } finally {
    release.resolve()
  }
  await blocking
  const result = await copying
  expect(result.status).toBe('cancelled')
  expect(result.snapshotCheckpoint?.tableIndex).toBe(3)
  expect(await destination.findTxLabels({ partial: {} })).toHaveLength(0)
})

test('an uncommitted auxiliary migration keeps ordinary backup on the compatible legacy path', async () => {
  const { destination, manager } = await fixture(2)
  await destination.knex('knex_migrations').where({ name: '2026-09-30-001 add durable snapshot sync' }).del()
  expect(await destination.getSnapshotSync()!.supportsDestination()).toBe(false)
  const legacy = jest.spyOn(destination, 'processSyncChunk')
  await manager.updateBackups()
  expect(legacy).toHaveBeenCalled()
  expect(await destination.knex('snapshot_sync_sessions')).toHaveLength(0)
})

test('large valid rows select serialized fallback after bounded commits without losing counts or data', async () => {
  const { source, destination, manager, user } = await fixture(2)
  const destinationUser = (await destination.findUserByIdentityKey(identity))!
  await destination.insertTxLabel({
    txLabelId: 0,
    userId: destinationUser.userId,
    created_at: new Date('2025-01-01'),
    updated_at: new Date('2025-01-01'),
    label: 'label-0',
    isDeleted: false
  })
  const bytes = new Uint8Array(200000).fill(173)
  await source.insertTransaction({
    transactionId: 0,
    userId: user.userId,
    created_at: when,
    updated_at: when,
    status: 'completed',
    reference: 'large',
    isOutgoing: false,
    satoshis: 0,
    description: '',
    rawTx: bytes as unknown as number[]
  })
  const legacy = jest.spyOn(destination, 'processSyncChunk')
  const modes: string[] = []
  const progress: Array<{ mode: string; state: string; pages: number; inserts: number; updates: number }> = []
  const result = await manager.syncToWriterResumable(await manager.getAuth(), destination, {
    onProgress: p => {
      modes.push(p.mode)
      progress.push({ ...p })
    }
  })
  expect(result.status).toBe('completed')
  expect(result.mode).toBe('exclusive')
  expect(result.inserts).toBe(2)
  expect(result.updates).toBe(1)
  const paged = progress.filter(p => p.mode === 'paged').at(-1)!
  const exclusive = progress.filter(p => p.mode === 'exclusive')
  expect(paged).toMatchObject({ inserts: 1, updates: 1 })
  expect(exclusive[0]).toMatchObject({ pages: paged.pages, inserts: 1, updates: 1 })
  expect(exclusive.at(-1)).toMatchObject({ pages: result.pages, inserts: 2, updates: 1 })
  expect(result.pages).toBe(paged.pages + exclusive.filter(p => p.state === 'committed').length)
  expect(modes).toContain('paged')
  expect(modes).toContain('exclusive')
  expect(legacy).toHaveBeenCalled()
  const transactions = await destination.findTransactions({ partial: {} })
  expect(transactions).toHaveLength(1)
  expect(new Uint8Array(transactions[0].rawTx!)).toEqual(bytes)
  expect(await destination.findTxLabels({ partial: {} })).toHaveLength(2)
  const fresh = await source.getSnapshotSync()!.openSource(identity)
  await fresh!.close()
})

test.each(['admission', 'commit'] as const)(
  'expiry during destination %s selects fallback after physical cleanup',
  async boundary => {
    const { source, destination, manager } = await fixture(2)
    const reader = source.getSnapshotSync()!
    let view!: WalletReadSnapshot
    jest.spyOn(source, 'getSnapshotSync').mockReturnValue({
      ...reader,
      openSource: async (...args) => {
        view = (await reader.openSource(...args))!
        return view
      }
    })
    const writer = destination.getSnapshotSync()!
    let expired = false
    const expire = async <T>(operation: () => Promise<T>): Promise<T> => {
      expired = true
      const clock = jest.spyOn(Date, 'now').mockReturnValue(view.expiresAt)
      try {
        return await operation()
      } finally {
        clock.mockRestore()
      }
    }
    jest.spyOn(destination, 'getSnapshotSync').mockReturnValue({
      ...writer,
      begin: async (...args) =>
        boundary === 'admission' && !expired ? await expire(() => writer.begin(...args)) : await writer.begin(...args),
      prepare: async (checkpoint, page) => {
        const apply = await writer.prepare(checkpoint, page)
        return async () =>
          boundary === 'commit' && !expired && checkpoint.tableIndex === 3 ? await expire(apply) : await apply()
      }
    })
    const merge = destination.processSyncChunk.bind(destination)
    const legacy = jest.spyOn(destination, 'processSyncChunk').mockImplementation(async (...args) => {
      expect(view.isOpen).toBe(false)
      await expect(view.closed).resolves.toBeUndefined()
      return await merge(...args)
    })
    const result = await manager.syncToWriterResumable(await manager.getAuth(), destination)
    expect(result).toMatchObject({ status: 'completed', mode: 'exclusive', inserts: 2 })
    expect(legacy).toHaveBeenCalled()
    expect(await destination.findTxLabels({ partial: {} })).toHaveLength(2)
    const fresh = (await reader.openSource(identity))!
    await fresh.close()
  }
)

test('profile or allocation corruption never selects the legacy fallback', async () => {
  const { source, destination, manager } = await fixture(1)
  const capability = destination.getSnapshotSync()!
  const legacy = jest.spyOn(destination, 'processSyncChunk')
  jest.spyOn(destination, 'getSnapshotSync').mockReturnValue({
    ...capability,
    prepare: async (checkpoint, page) => {
      if (checkpoint.tableIndex === 3) (page.rows[0] as { userId: number }).userId = 999
      return await capability.prepare(checkpoint, page)
    }
  })
  await expect(manager.updateBackups()).rejects.toThrow('another profile')
  expect(legacy).not.toHaveBeenCalled()
  expect(await destination.findTxLabels({ partial: {} })).toHaveLength(0)
  const next = await source.getSnapshotSync()!.openSource(identity)
  await next!.close()
})

test('rejects invalid source bindings before creating a destination session', async () => {
  const { source, destination } = await fixture(1)
  const view = (await source.getSnapshotSync()!.openSource(identity))!
  const capability = destination.getSnapshotSync()!
  const invalid = [
    { ...view, version: 2 },
    { ...view, snapshotId: 'a'.repeat(63) },
    { ...view, snapshotId: 'g'.repeat(64) },
    { ...view, expiresAt: NaN },
    { ...view, expiresAt: Date.now() - 1 },
    { ...view, expiresAt: Date.now() + 36000000 },
    { ...view, user: { ...view.user, userId: 0 } },
    { ...view, user: { ...view.user, userId: 1.5 } },
    { ...view, user: { ...view.user, identityKey: 'not-an-identity' } },
    { ...view, sourceStorage: { ...view.sourceStorage, storageIdentityKey: '' } },
    { ...view, sourceStorage: { ...view.sourceStorage, storageIdentityKey: 'a'.repeat(131) } },
    { ...view, sourceStorage: { ...view.sourceStorage, storageIdentityKey: 'destination' } },
    { ...view, sourceStorage: { ...view.sourceStorage, chain: 'main' } }
  ]
  for (const header of invalid)
    await expect(capability.begin(header as typeof view, view.user.activeStorage)).rejects.toThrow()
  expect(await destination.knex('snapshot_sync_sessions')).toHaveLength(0)
  await view.close()
})

test('rejects changed checkpoints and malformed pages without advancing durable progress', async () => {
  const { source, destination } = await fixture(3)
  const view = (await source.getSnapshotSync()!.openSource(identity))!
  const capability = destination.getSnapshotSync()!
  const before = await advance(view, capability, 3)
  const page = await view.readPage('txLabels', undefined, { maxRows: 1 })
  const changed = [
    { ...before, version: 2 },
    { ...before, sessionId: 'g'.repeat(64) },
    { ...before, sessionId: 'f'.repeat(64) },
    { ...before, snapshotId: 'f'.repeat(64) },
    { ...before, sequence: -1 },
    { ...before, sequence: 1.5 },
    { ...before, sequence: before.sequence + 1 },
    { ...before, tableIndex: -1 },
    { ...before, tableIndex: 0.5 },
    { ...before, tableIndex: 12, done: true },
    { ...before, destinationStorageIdentityKey: 'different' },
    { ...before, sourceStorageIdentityKey: 'different' },
    { ...before, identityKey: foreignIdentity }
  ]
  for (const checkpoint of changed)
    await expect((async () => (await capability.prepare(checkpoint as typeof before, page))())()).rejects.toThrow()
  const badPages = [
    { ...page, rows: [] },
    { ...page, rows: Array(1001).fill(page.rows[0]) },
    { ...page, done: undefined },
    { ...page, payloadBytes: -1 },
    { ...page, payloadBytes: Infinity },
    { ...page, payloadBytes: 16777217 },
    { ...page, payloadBytes: 1 },
    { ...page, cursor: undefined },
    { ...page, cursor: { ...page.cursor!, version: 2 } },
    { ...page, cursor: { ...page.cursor!, table: 'outputs' } },
    { ...page, cursor: { ...page.cursor!, after: [] } },
    { ...page, cursor: { ...page.cursor!, after: [999] } },
    { ...page, rows: [{ ...page.rows[0], userId: 999 }] },
    { ...page, rows: [{ ...page.rows[0], userId: undefined }] },
    { ...page, rows: [{ ...page.rows[0], txLabelId: 0 }], cursor: { ...page.cursor!, after: [0] } },
    { ...page, rows: [{ ...page.rows[0], txLabelId: NaN }] },
    { ...page, rows: [{ ...page.rows[0], label: { nested: true } }] },
    { ...page, rows: [{ ...page.rows[0], created_at: new Date(NaN) }] }
  ]
  for (const invalid of badPages)
    await expect((async () => (await capability.prepare(before, invalid as typeof page))())()).rejects.toThrow()
  expect(await capability.checkpoint(identity, 'source')).toEqual(before)
  expect(await destination.findTxLabels({ partial: {} })).toHaveLength(0)
  await view.close()
})

test('archive positions persist with rows, detach before proof I/O and reject an omitted durable binding', async () => {
  const { source, destination } = await fixture(3)
  const view = (await source.getSnapshotSync()!.openSource(identity))!
  const writer = destination.getSnapshotSync()!
  try {
    let checkpoint = await advance(view, writer, 3)
    const first = await view.readPage('txLabels', undefined, { maxRows: 1 })
    const second = await view.readPage('txLabels', first.cursor, { maxRows: 1 })
    const last = await view.readPage('txLabels', second.cursor, { maxRows: 1 })
    first.cursor!.archivePosition = { version: 1, archiveId: 'c'.repeat(64), sequence: 3, rowOffset: 1 }
    checkpoint = (await (await writer.prepare(checkpoint, first))()).checkpoint
    expect((await writer.checkpoint(identity, 'source'))!.cursor!.archivePosition).toEqual(
      first.cursor!.archivePosition
    )
    second.cursor!.archivePosition = { ...first.cursor!.archivePosition, rowOffset: 2 }
    const preparing = writer.prepare(checkpoint, second)
    checkpoint.cursor!.archivePosition!.rowOffset = 999
    second.cursor!.archivePosition.rowOffset = 999
    checkpoint = (await (await preparing)()).checkpoint
    expect(checkpoint.cursor!.archivePosition!.rowOffset).toBe(2)
    expect(await destination.findTxLabels({ partial: {} })).toHaveLength(2)
    const missing = { ...checkpoint, cursor: { ...checkpoint.cursor!, archivePosition: undefined } }
    const apply = await writer.prepare(missing, last)
    await expect(apply()).rejects.toThrow('Snapshot session changed')
    expect(await writer.checkpoint(identity, 'source')).toEqual(checkpoint)
    expect(await destination.findTxLabels({ partial: {} })).toHaveLength(2)
  } finally {
    await view.close()
  }
})

test('source admission, expiry and destruction retain bounded reader ownership', async () => {
  const { source, destination } = await fixture(0)
  const capability = source.getSnapshotSync()!
  for (const lifetimeMs of [0, -1, 1.5, Infinity, 3600001])
    await expect(capability.openSource(identity, { lifetimeMs })).rejects.toThrow('lifetimeMs')
  const controller = new AbortController()
  controller.abort()
  await expect(capability.openSource(identity, { signal: controller.signal })).rejects.toThrow('cancelled')
  await expect(capability.openSource('02' + '33'.repeat(32))).rejects.toThrow('existing wallet profile')
  const view = (await capability.openSource(identity, { lifetimeMs: 10000 }))!
  await expect(capability.openSource(identity)).rejects.toThrow('already has')
  expect(await destination.getSnapshotSync()!.checkpoint(identity, 'missing')).toBeUndefined()
  expect(await destination.getSnapshotSync()!.checkpoint(foreignIdentity, 'source')).toBeUndefined()
  const clock = jest.spyOn(Date, 'now').mockReturnValue(view.expiresAt)
  await expect(view.readPage('txLabels')).rejects.toThrow('expired')
  await expect(view.closed).resolves.toBeUndefined()
  clock.mockRestore()
  const fresh = (await capability.openSource(identity))!
  await source.destroy()
  await fresh.closed
  expect(fresh.isOpen).toBe(false)
  await expect(capability.openSource(identity)).rejects.toThrow('destruction')
})

test('all push and pull APIs reject another profile before touching the peer', async () => {
  const { manager, destination } = await fixture(0)
  const peer = jest.spyOn(destination, 'makeAvailable')
  await expect(manager.syncToWriter({ identityKey: foreignIdentity }, destination)).rejects.toThrow()
  await expect(manager.syncToWriterResumable({ identityKey: foreignIdentity }, destination)).rejects.toThrow()
  await expect(manager.syncFromReader(foreignIdentity, destination)).rejects.toBeInstanceOf(WERR_UNAUTHORIZED)
  await expect(manager.syncFromReaderResumable(foreignIdentity, destination)).rejects.toBeInstanceOf(WERR_UNAUTHORIZED)
  expect(peer).not.toHaveBeenCalled()
})

test.each(['source', 'destination'] as const)(
  'disabling snapshot sync on the %s preserves ordinary backup through the legacy path',
  async disabled => {
    const { source, destination, manager } = await fixture(2, true, disabled)
    const store = disabled === 'source' ? source : destination
    const legacy = jest.spyOn(destination, 'processSyncChunk')
    expect(store.getSnapshotSync()).toBeUndefined()
    expect(await store.knex.schema.hasTable('snapshot_sync_sessions')).toBe(true)
    expect(store.supportsWalletReadSnapshot()).toBe(true)
    expect(await manager.updateBackups()).toContain('serialized complete')
    expect(legacy).toHaveBeenCalled()
    expect(await destination.findTxLabels({ partial: {} })).toHaveLength(2)
    expect(await destination.knex('snapshot_sync_sessions')).toHaveLength(0)
  }
)

test('profile selection and its update count are atomic with the first page', async () => {
  const { source, destination, manager } = await fixture(0)
  await destination
    .knex('users')
    .where({ identityKey: identity })
    .update({ activeStorage: 'old-primary', updated_at: '2000-01-01T00:00:00.000Z' })
  const controller = new AbortController()
  const cancelled = await manager.syncToWriterResumable(await manager.getAuth(), destination, {
    signal: controller.signal,
    onProgress: progress => {
      if (progress.state === 'reading') controller.abort()
    }
  })
  expect(cancelled.pages).toBe(0)
  expect(cancelled.status).toBe('cancelled')
  expect((await destination.findUserByIdentityKey(identity))!.activeStorage).toBe('old-primary')
  const result = await manager.syncToWriterResumable(await manager.getAuth(), destination)
  expect(result.status).toBe('completed')
  expect(result.updates).toBe(1)
  expect((await destination.findUserByIdentityKey(identity))!.activeStorage).toBe('source')
  expect((await source.findUserByIdentityKey(identity))!.activeStorage).toBe('source')
})

test('ordinary copies retain their previous byte ceiling while a fresh manager initializes lazily', async () => {
  const { source, destination } = await fixture(1)
  const limits: number[] = []
  for (const store of [source, destination]) {
    const capability = store.getSnapshotSync()!
    jest.spyOn(store, 'getSnapshotSync').mockReturnValue({
      ...capability,
      openSource: async (...args) => {
        const view = (await capability.openSource(...args))!
        return {
          ...view,
          get isOpen() {
            return view.isOpen
          },
          readPage: async (table, cursor, bounds) => {
            limits.push(bounds!.maxBytes!)
            return await view.readPage(table, cursor, bounds)
          }
        }
      }
    })
  }
  const manager = new WalletStorageManager(identity, source, [destination])
  await manager.syncToWriter({ identityKey: identity }, destination)
  await manager.updateBackups()
  await manager.syncFromReader(identity, destination)
  expect(limits.length).toBeGreaterThanOrEqual(36)
  expect(limits.every(limit => limit === 10000000)).toBe(true)
  const fresh = new WalletStorageManager(identity, source)
  expect((await fresh.syncToWriterResumable({ identityKey: identity }, destination)).status).toBe('completed')
})

test('unmigrated destinations refuse durable sessions without applying an implicit migration', async () => {
  const { source, destination } = await fixture(0)
  const view = (await source.getSnapshotSync()!.openSource(identity))!
  const capability = destination.getSnapshotSync()!
  await destination.knex.schema.dropTable('knex_migrations')
  expect(await capability.supportsDestination()).toBe(false)
  await expect(capability.begin(view, 'source')).rejects.toThrow('requires the version-one migration')
  expect(await destination.knex.schema.hasTable('knex_migrations')).toBe(false)
  await view.close()
})

test.each([-1, 9007199254740992])('invalid persisted primary epoch %s refuses a session', async epoch => {
  const { source, destination } = await fixture(0)
  const view = (await source.getSnapshotSync()!.openSource(identity))!
  await destination.knex('snapshot_sync_primary_epochs').update({ epoch })
  await expect(destination.getSnapshotSync()!.begin(view, 'source')).rejects.toThrow('Invalid primary epoch')
  expect(await destination.knex('snapshot_sync_sessions')).toHaveLength(0)
  await view.close()
})

test('source expiry during destination admission creates no durable session', async () => {
  const { source, destination } = await fixture(0)
  const view = (await source.getSnapshotSync()!.openSource(identity))!
  const original = destination.findOrInsertUser.bind(destination)
  let clock: jest.SpyInstance | undefined
  jest.spyOn(destination, 'findOrInsertUser').mockImplementation(async (...args) => {
    const result = await original(...args)
    clock = jest.spyOn(Date, 'now').mockReturnValue(view.expiresAt)
    return result
  })
  try {
    await expect(destination.getSnapshotSync()!.begin(view, 'source')).rejects.toThrow(
      'expired before session admission'
    )
    expect(await destination.knex('snapshot_sync_sessions')).toHaveLength(0)
  } finally {
    clock?.mockRestore()
    await view.close()
  }
})

test.each(['changed', 'removed'] as const)(
  'a proof %s after preparation cannot advance a snapshot page',
  async change => {
    const { source, destination, user } = await fixture(0)
    const foreign = (await source.findUserByIdentityKey(foreignIdentity))!
    await seedClosure(source, user.userId, foreign.userId)
    const proof = (await source.findProvenTxs({ partial: { provenTxId: 1 } }))[0]
    await destination.insertProvenTx({ ...proof, provenTxId: 0 })
    const prior = (await destination.findProvenTxs({ partial: { txid: proof.txid } }))[0]
    const second = (await source.findProvenTxs({ partial: { provenTxId: 3 } }))[0]
    await destination.insertProvenTx({ ...second, provenTxId: 0 })
    const proofs = await destination.findProvenTxs({ partial: {} })
    const view = (await source.getSnapshotSync()!.openSource(identity))!
    // Isolate the commit-time compare-and-set from the separately tested canonical
    // proof service: this callback supplies its captured preflight authority.
    const writer = new KnexSnapshotSyncDestination(destination, async () => new Map(proofs.map(row => [row.txid, row])))
    const before = await writer.begin(view, 'source')
    const apply = await writer.prepare(before, await view.readPage('provenTxs'))
    if (change === 'removed') await destination.knex('proven_txs').where({ provenTxId: prior.provenTxId }).del()
    else await destination.updateProvenTx(prior.provenTxId, { blockHash: 'c'.repeat(64) })
    await expect(apply()).rejects.toThrow('Proof changed during snapshot preparation')
    expect(await writer.checkpoint(identity, 'source')).toEqual(before)
    expect(await destination.knex('snapshot_sync_ids')).toHaveLength(0)
    await view.close()
  }
)

test('a source capability returning the wrong profile is closed before any destination mutation', async () => {
  const { source, destination, manager } = await fixture(1)
  const capability = source.getSnapshotSync()!
  const writer = destination.getSnapshotSync()!
  const begin = jest.fn(writer.begin)
  let opened: WalletReadSnapshot | undefined
  jest.spyOn(destination, 'getSnapshotSync').mockReturnValue({ ...writer, begin })
  jest.spyOn(source, 'getSnapshotSync').mockReturnValue({
    ...capability,
    openSource: async (...args) => {
      opened = (await capability.openSource(...args))!
      return { ...opened, user: { ...opened.user, identityKey: foreignIdentity } }
    }
  })
  await expect(manager.syncToWriterResumable({ identityKey: identity }, destination)).rejects.toBeInstanceOf(
    WERR_UNAUTHORIZED
  )
  expect(begin).not.toHaveBeenCalled()
  expect(opened!.isOpen).toBe(false)
  expect(await destination.knex('snapshot_sync_sessions')).toHaveLength(0)
  expect(await destination.findTxLabels({ partial: {} })).toHaveLength(0)
})

test('a cleanup failure remains observable after the destination commits the complete copy', async () => {
  const { source, destination, manager } = await fixture(1)
  const capability = source.getSnapshotSync()!
  const failure = new Error('synthetic physical cleanup failure')
  const legacy = jest.spyOn(destination, 'processSyncChunk')
  jest.spyOn(source, 'getSnapshotSync').mockReturnValue({
    ...capability,
    openSource: async (...args) => {
      const view = (await capability.openSource(...args))!
      return {
        ...view,
        close: async () => {
          await view.close()
          throw failure
        }
      }
    }
  })
  await expect(manager.syncToWriterResumable({ identityKey: identity }, destination)).rejects.toBe(failure)
  expect((await destination.getSnapshotSync()!.checkpoint(identity, 'source'))!.done).toBe(true)
  expect(await destination.findTxLabels({ partial: {} })).toHaveLength(1)
  expect(legacy).not.toHaveBeenCalled()
})

test.each([
  ['sourceUserId', 999],
  ['sourceActiveStorage', 'different-primary'],
  ['sourceUserCreatedAt', '2000-01-01T00:00:00.000Z'],
  ['sourceUserUpdatedAt', '2000-01-01T00:00:00.000Z'],
  ['chain', 'main'],
  ['destinationStorageIdentityKey', 'different-destination'],
  ['version', 2],
  ['activeStorage', 'different-primary'],
  ['expiresAt', 1],
  ['primaryEpoch', 99]
])('same-view admission refuses a changed durable %s binding', async (field, value) => {
  const { source, destination } = await fixture(0)
  const view = (await source.getSnapshotSync()!.openSource(identity))!
  const writer = destination.getSnapshotSync()!
  try {
    await writer.begin(view, 'source')
    await destination.knex('snapshot_sync_sessions').update({ [field]: value })
    const before = await destination.knex('snapshot_sync_sessions').first()
    await expect(writer.begin(view, 'source')).rejects.toThrow('Snapshot session binding changed')
    expect(await destination.knex('snapshot_sync_sessions').first()).toEqual(before)
  } finally {
    await view.close()
  }
})

test.each([
  ['version', 2],
  ['sessionId', 'g'.repeat(64)],
  ['sessionId', 'x' + 'a'.repeat(64)],
  ['sessionId', 'a'.repeat(64) + 'x'],
  ['sequence', -1],
  ['sequence', 0.5],
  ['sequence', Number.MAX_SAFE_INTEGER + 1],
  ['tableIndex', -1],
  ['tableIndex', 0.5]
])('malformed checkpoint %s=%s rejects before proof preparation', async (field, value) => {
  const { source, destination } = await fixture(0)
  const view = (await source.getSnapshotSync()!.openSource(identity))!
  const proofs = jest.fn(async () => new Map())
  const writer = new KnexSnapshotSyncDestination(destination, proofs)
  try {
    const checkpoint = await writer.begin(view, 'source')
    await expect(
      writer.prepare({ ...checkpoint, [field]: value }, { rows: [], done: true, payloadBytes: 0 })
    ).rejects.toThrow('a version-one durable snapshot checkpoint')
    expect(proofs).not.toHaveBeenCalled()
    expect(await writer.checkpoint(identity, 'source')).toEqual(checkpoint)
  } finally {
    await view.close()
  }
})

test.each(['snapshot-prefix', 'snapshot-suffix', 'identity-prefix', 'identity-suffix', 'storage-type'])(
  'source %s rejects before creating a profile or session',
  async kind => {
    const { source, destination } = await fixture(0)
    const view = (await source.getSnapshotSync()!.openSource(identity))!
    const writer = destination.getSnapshotSync()!
    const input = { ...view, user: { ...view.user }, sourceStorage: { ...view.sourceStorage } }
    if (kind === 'snapshot-prefix') input.snapshotId = 'x' + view.snapshotId
    if (kind === 'snapshot-suffix') input.snapshotId = view.snapshotId + 'x'
    if (kind === 'identity-prefix') input.user.identityKey = 'x' + identity
    if (kind === 'identity-suffix') input.user.identityKey = identity + 'x'
    if (kind === 'storage-type') input.sourceStorage.storageIdentityKey = 1 as unknown as string
    try {
      await expect(writer.begin(input, 'source')).rejects.toThrow('a live version-one wallet snapshot')
      expect(await destination.findUsers({ partial: {} })).toHaveLength(1)
      expect(await destination.knex('snapshot_sync_sessions')).toHaveLength(0)
    } finally {
      await view.close()
    }
  }
)

test.each([
  ['version', 2],
  ['identityKey', foreignIdentity],
  ['snapshotId', 'c'.repeat(64)],
  ['tableIndex', 2],
  ['sequence', 99],
  ['sessionId', 'c'.repeat(64)],
  ['activeStorage', 'another-primary'],
  ['chain', 'main'],
  ['cursor-version', 2],
  ['cursor-snapshotId', 'c'.repeat(64)],
  ['cursor-table', 'outputs'],
  ['cursor-after', [999]]
])('a prepared page refuses changed durable position %s before applying rows', async (field, value) => {
  const { source, destination } = await fixture(3)
  const view = (await source.getSnapshotSync()!.openSource(identity))!
  const writer = destination.getSnapshotSync()!
  try {
    let checkpoint = await advance(view, writer, 3)
    const first = await view.readPage('txLabels', checkpoint.cursor, { maxRows: 1 })
    checkpoint = (await (await writer.prepare(checkpoint, first))()).checkpoint
    const page = await view.readPage('txLabels', checkpoint.cursor, { maxRows: 1 })
    const apply = await writer.prepare(checkpoint, page)
    const patch = field.startsWith('cursor-')
      ? { cursor: JSON.stringify({ ...checkpoint.cursor, [field.slice(7)]: value }) }
      : { [field]: value }
    await destination.knex('snapshot_sync_sessions').update(patch)
    const prior = await destination.knex('snapshot_sync_sessions').first()
    await expect(apply()).rejects.toThrow('Snapshot session changed')
    expect(await destination.knex('snapshot_sync_sessions').first()).toEqual(prior)
    expect(await destination.findTxLabels({ partial: {} })).toHaveLength(1)
  } finally {
    await view.close()
  }
})

test('source admission accepts the exact lifetime and storage-identity length ceilings', async () => {
  const { source, destination } = await fixture(0)
  const view = (await source.getSnapshotSync()!.openSource(identity))!
  const now = Date.now()
  const clock = jest.spyOn(Date, 'now').mockReturnValue(now)
  const storageIdentityKey = 'a'.repeat(130)
  try {
    const result = await destination.getSnapshotSync()!.begin(
      {
        ...view,
        expiresAt: now + 3600000,
        sourceStorage: { ...view.sourceStorage, storageIdentityKey }
      },
      'source'
    )
    expect(result.sourceStorageIdentityKey).toBe(storageIdentityKey)
    expect(result.sequence).toBe(0)
  } finally {
    clock.mockRestore()
    await view.close()
  }
})

test.each(['push', 'backup', 'legacy-backup'] as const)(
  'ordinary %s delivers committed-page progress to the existing logger',
  async operation => {
    const { source, destination, manager } = await fixture(2, operation !== 'legacy-backup')
    const messages: string[] = []
    const rendered: string[] = []
    const logger = (message: string): string => {
      messages.push(message)
      const value = `[observed:${message}]`
      rendered.push(value)
      return value
    }
    const log =
      operation === 'push'
        ? (await manager.syncToWriter(await manager.getAuth(), destination, undefined, 'prefix:', logger)).log
        : await manager.updateBackups(undefined, logger)
    const pages = messages.filter(message => message.startsWith('chunk '))
    expect(pages.length).toBeGreaterThan(0)
    expect(messages.indexOf(pages[0])).toBeLessThan(messages.length - 1)
    for (const value of rendered) expect(log).toContain(value)
    if (operation === 'push') expect(log.startsWith('prefix:')).toBe(true)
    expect(await destination.findTxLabels({ partial: {} })).toHaveLength(2)
    expect(source.getSnapshotSync()).toBeDefined()
  }
)

test('snapshot capability configuration rejects a non-boolean before database admission', async () => {
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  try {
    expect(
      () =>
        new StorageKnex({
          ...StorageProvider.createStorageBaseOptions('test'),
          knex: database,
          snapshotSync: 'enabled' as unknown as boolean
        })
    ).toThrow('snapshotSync')
    expect(database.client.pool.numUsed()).toBe(0)
  } finally {
    await database.destroy()
  }
})

test('an expiry during cleanup preserves an earlier malformed-page failure', async () => {
  const { source, destination, manager } = await fixture(1)
  const capability = source.getSnapshotSync()!
  const failure = new Error('synthetic malformed page')
  const legacy = jest.spyOn(destination, 'processSyncChunk')
  jest.spyOn(source, 'getSnapshotSync').mockReturnValue({
    ...capability,
    openSource: async (...args) => {
      const view = (await capability.openSource(...args))!
      return {
        ...view,
        readPage: async () => {
          throw failure
        },
        close: async () => {
          await view.close()
          throw new SnapshotResourceLimitError('synthetic cleanup expiry')
        }
      }
    }
  })
  await expect(manager.syncToWriterResumable({ identityKey: identity }, destination)).rejects.toBe(failure)
  expect(legacy).not.toHaveBeenCalled()
  expect(await destination.findTxLabels({ partial: {} })).toHaveLength(0)
})
