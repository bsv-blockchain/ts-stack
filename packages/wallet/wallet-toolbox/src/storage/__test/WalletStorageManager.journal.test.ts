import { knex } from 'knex'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
import { WalletStorageManager } from '../WalletStorageManager'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import { SnapshotCancelledError } from '../snapshot/SnapshotCancelledError'
import type { SnapshotJournalProgress } from '../snapshot/journal/SnapshotJournalTypes'
import type { SyncSessionProgress } from '../sync/syncSession'
import { SNAPSHOT_JOURNAL_SOURCE_MIGRATION } from '../snapshot/journal/SnapshotJournalLifecycle'
import type { SnapshotJournalDestinationBinding } from '../snapshot/journal/SnapshotJournalDestinationWindow'

jest.setTimeout(30000)
const identity = '02' + '11'.repeat(32)
function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => {
    resolve = yes
  })
  return { promise, resolve }
}
let directory: string, source: StorageKnex, target: StorageKnex, manager: WalletStorageManager
let opened: StorageKnex[] = []
beforeEach(async () => {
  opened = []
  directory = await mkdtemp(join(tmpdir(), 'manager-journal-'))
  const make = async (name: string): Promise<StorageKnex> => {
    const db = knex({
      client: 'better-sqlite3',
      connection: { filename: join(directory, name + '.sqlite') },
      useNullAsDefault: true,
      pool: { min: 0, max: 1 }
    })
    const storage = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: db })
    opened.push(storage)
    await db.raw('PRAGMA journal_mode = WAL')
    await db.raw('PRAGMA busy_timeout = 0')
    await storage.migrate(name, 'journal-' + name)
    await storage.makeAvailable()
    await storage.findOrInsertUser(identity)
    return storage
  }
  source = await make('source')
  target = await make('target')
  const one = new WalletStorageManager(identity, source)
  await one.makeAvailable()
  await one.setActive(source.getSettings().storageIdentityKey)
  manager = new WalletStorageManager(identity, source, [target])
  await manager.makeAvailable()
  await manager.setActive(source.getSettings().storageIdentityKey)
})
afterEach(async () => {
  jest.restoreAllMocks()
  const drained = await Promise.allSettled(opened.map(async store => await store.destroy()))
  const failures = drained.filter(value => value.status === 'rejected')
  await rm(directory, { recursive: true, force: true })
  if (failures.length !== 0)
    throw new AggregateError(
      failures.map(value => value.reason),
      'Journal fixture did not drain'
    )
})
async function insertBasket(name: string) {
  const { user } = await source.findOrInsertUser(identity)
  return await source.insertOutputBasket({
    basketId: 0,
    userId: user.userId,
    name,
    created_at: new Date(),
    updated_at: new Date(),
    isDeleted: false,
    minimumDesiredUTXOValue: 144,
    numberOfDesiredUTXOs: 32
  })
}
async function sourceWindow(): Promise<SnapshotJournalDestinationBinding> {
  const row = await target
    .knex('snapshot_reconciliation_windows')
    .where('sourceStorageIdentity', source.getSettings().storageIdentityKey)
    .first('bindingJson')
  return JSON.parse(row.bindingJson)
}

test('ordinary push uses durable journal succession and preserves tombstones across fresh manager instances', async () => {
  const id = await insertBasket('journal-ordinary')
  const auth = await manager.getAuth()
  const first = await manager.syncToWriterResumable(auth, target)
  expect(first.status).toBe('completed')
  expect(first.journalCheckpoint?.phase).toBe('acknowledged')
  const firstWindow = await sourceWindow()
  const { user } = await target.findOrInsertUser(identity)
  const copied = await target.findOutputBaskets({ partial: { userId: user.userId, name: 'journal-ordinary' } })
  expect(copied).toHaveLength(1)
  expect(copied[0].numberOfDesiredUTXOs).toBe(32)
  await source.updateOutputBasket(id, { isDeleted: true, updated_at: new Date(Date.now() + 1000) })
  const replacement = new WalletStorageManager(identity, source, [target])
  await replacement.makeAvailable()
  const second = await replacement.syncToWriterResumable(await replacement.getAuth(), target)
  const secondWindow = await sourceWindow()
  expect(second.journalCheckpoint?.phase).toBe('acknowledged')
  expect(secondWindow.bootstrap).toBeUndefined()
  expect(secondWindow.low).toBe(firstWindow.receipt.highWater)
  expect(secondWindow.receipt.requestId).not.toBe(firstWindow.receipt.requestId)
  expect(
    (await target.findOutputBaskets({ partial: { userId: user.userId, name: 'journal-ordinary' } }))[0].isDeleted
  ).toBe(true)
})

test('a foreground write during capture is reconciled before primary activation, without queue ownership across the read', async () => {
  const entered = gate(),
    release = gate()
  const open = source.openCurrentSnapshotJournalSource.bind(source)
  let delay = true
  jest.spyOn(source, 'openCurrentSnapshotJournalSource').mockImplementation(async (key, options) => {
    const actual = await open(key, options)
    return new Proxy(actual, {
      get(object, name) {
        if (name !== 'readDeltaPage') return Reflect.get(object, name)
        return async (...args: Parameters<typeof actual.readDeltaPage>) => {
          if (delay) {
            delay = false
            entered.resolve()
            await release.promise
          }
          return await actual.readDeltaPage(...args)
        }
      }
    })
  })
  const targetKey = target.getSettings().storageIdentityKey
  const update = target.updateUser.bind(target)
  const selections: boolean[] = []
  jest.spyOn(target, 'updateUser').mockImplementation(async (id, value, trx) => {
    if (value.activeStorage === targetKey) {
      const rows = await target
        .toDb(trx)('output_baskets')
        .where({ userId: id, name: 'arrived-during-copy' })
        .select('basketId')
      selections.push(rows.length === 1)
    }
    return await update(id, value, trx)
  })
  const transition = manager.setActive(targetKey)
  try {
    await Promise.race([
      entered.promise,
      transition.then(() => {
        throw new Error('Primary transition completed without the retained-source gate')
      })
    ])
    // This must finish while the background source page remains delayed.
    await manager.runAsStorageProvider(async active => {
      expect(active).toBe(source)
      await insertBasket('arrived-during-copy')
    })
    expect(selections).toEqual([])
    release.resolve()
    await transition
    expect(selections).toEqual([true])
    expect(manager.getActive()).toBe(target)
    expect(manager.isActiveEnabled).toBe(true)
    for (const store of [source, target]) {
      expect((await store.findOrInsertUser(identity)).user.activeStorage).toBe(targetKey)
      expect(await store.findOutputBaskets({ partial: { name: 'arrived-during-copy' } })).toHaveLength(1)
    }
  } finally {
    release.resolve()
    await transition.catch(() => undefined)
  }
})

test('partial journal installation fails before the ordinary legacy transport can run', async () => {
  await source.knex('knex_migrations').where('name', SNAPSHOT_JOURNAL_SOURCE_MIGRATION).delete()
  const legacy = jest.spyOn(source, 'getSyncChunk')
  await expect(manager.syncToWriterResumable(await manager.getAuth(), target)).rejects.toThrow('incomplete')
  expect(legacy).not.toHaveBeenCalled()
  expect(await manager.runAsWriter(async () => 'foreground available')).toBe('foreground available')
})

test('serialized resource fallback reports the actual acknowledged journal prefix and every legacy commit', async () => {
  for (let index = 0; index < 8; index++) await insertBasket('fallback-prefix-' + index)
  const open = target.openSnapshotJournalDestination.bind(target)
  let inject = false,
    injected = false
  let prefix: SnapshotJournalProgress | undefined
  jest.spyOn(target, 'openSnapshotJournalDestination').mockImplementation(async (...args) => {
    const actual = await open(...args),
      destination = actual.destination
    return {
      ...actual,
      destination: new Proxy(destination, {
        get(object, name) {
          if (name !== 'promote') {
            // Preserve the real destination receiver and its private fields.
            const value = Reflect.get(object, name, object)
            return typeof value === 'function' ? value.bind(object) : value
          }
          return async (...selected: Parameters<typeof destination.promote>) => {
            if (inject) {
              injected = true
              throw new SnapshotResourceLimitError('finite synthetic source limit')
            }
            const reply = await destination.promote(...selected)
            const status = await destination.status()
            if (status.progress.inserts > 0 && status.checkpoint.phase !== 'acknowledged') {
              prefix = { ...status.progress }
              inject = true
            }
            return reply
          }
        }
      })
    }
  })
  const legacy = target.processSyncChunk.bind(target)
  let legacyPages = 0,
    legacyInserts = 0,
    legacyUpdates = 0
  jest.spyOn(target, 'processSyncChunk').mockImplementation(async (...args) => {
    const reply = await legacy(...args)
    legacyPages++
    legacyInserts += reply.inserts
    legacyUpdates += reply.updates
    return reply
  })
  const progress: SyncSessionProgress[] = []
  const result = await manager.syncToWriterResumable(await manager.getAuth(), target, {
    maxItems: 1,
    maxRoughSize: 65536,
    onProgress: value => {
      progress.push({ ...value })
    }
  })
  expect(injected).toBe(true)
  expect(prefix!.pages).toBeGreaterThan(0)
  expect(prefix!.inserts).toBeGreaterThan(0)
  expect(legacyPages).toBeGreaterThan(0)
  expect(result.status).toBe('completed')
  expect(result.mode).toBe('exclusive')
  expect(result.pages).toBe(prefix!.pages + legacyPages)
  expect(result.inserts).toBe(prefix!.inserts + legacyInserts)
  expect(result.updates).toBe(prefix!.updates + legacyUpdates)
  expect(progress[progress.length - 1].pages).toBe(result.pages)
  expect(progress[progress.length - 1].inserts).toBe(result.inserts)
  expect(await target.findOutputBaskets({ partial: {} })).toEqual(
    expect.arrayContaining(
      Array.from({ length: 8 }, (_, index) => expect.objectContaining({ name: 'fallback-prefix-' + index }))
    )
  )
  expect((await target.findOrInsertUser(identity)).user.activeStorage).toBe(source.getSettings().storageIdentityKey)
})

test.each(['resource', 'cancelled'] as const)(
  'a typed %s progress-observer error rejects exactly without selecting legacy fallback',
  async kind => {
    await insertBasket('observer-prefix')
    const signal = new AbortController()
    const failure =
      kind === 'resource'
        ? new SnapshotResourceLimitError('synthetic progress observer resource error')
        : new SnapshotCancelledError('synthetic progress observer cancellation')
    const legacy = jest.spyOn(source, 'getSyncChunk')
    let observed = false
    await expect(
      manager.syncToWriterResumable(await manager.getAuth(), target, {
        signal: signal.signal,
        maxItems: 1,
        onProgress: value => {
          if (!observed && value.pages > 0) {
            observed = true
            if (kind === 'cancelled') signal.abort(failure)
            throw failure
          }
        }
      })
    ).rejects.toBe(failure)
    expect(observed).toBe(true)
    expect(legacy).not.toHaveBeenCalled()
    const custody = await target.knex('snapshot_reconciliation_window_progress').select('*')
    expect(custody.length).toBeGreaterThan(0)
    expect(await manager.runAsWriter(async () => 'available after observer drain')).toBe(
      'available after observer drain'
    )
  }
)

test('a cancellation observer cannot mutate the returned journal custody position', async () => {
  for (let index = 0; index < 4; index++) await insertBasket('cancel-prefix-' + index)
  const signal = new AbortController()
  let committedPages = 0
  const result = await manager.syncToWriterResumable(await manager.getAuth(), target, {
    signal: signal.signal,
    maxItems: 1,
    onProgress: value => {
      if (value.state === 'committed' && value.pages > 0) {
        committedPages = value.pages
        signal.abort()
      }
      if (value.state === 'cancelled' && value.journalCheckpoint !== undefined) value.journalCheckpoint.sequence = -999
    }
  })
  expect(result.status).toBe('cancelled')
  expect(result.pages).toBe(committedPages)
  expect(result.pages).toBeGreaterThan(0)
  expect(result.journalCheckpoint!.sequence).toBeGreaterThanOrEqual(0)
})

test('a committed activation with a lost reply recovers through a replacement manager without reactivating its source', async () => {
  await insertBasket('actual recovered primary basket')
  const targetKey = target.getSettings().storageIdentityKey
  const original = target.getPrimaryHandoffControl.bind(target)
  let lose = true
  jest.spyOn(target, 'getPrimaryHandoffControl').mockImplementation(async () => {
    const control = await original()
    if (control === undefined) throw new Error('Actual control unavailable')
    return {
      ...control,
      activateTarget: async (...args) => {
        const status = await control.activateTarget(...args)
        if (lose) {
          lose = false
          throw new Error('injected lost committed activation reply')
        }
        return status
      }
    }
  })
  await expect(manager.setActive(targetKey)).rejects.toThrow('lost committed activation reply')
  await expect(manager.runAsStorageProvider(async () => {})).rejects.toThrow('forward recovery')
  const sourceUser = (await source.findOrInsertUser(identity)).user
  const targetUser = (await target.findOrInsertUser(identity)).user
  const sourceControl = await source.getPrimaryHandoffControl(),
    targetControl = await original()
  expect((await sourceControl?.status({ identityKey: identity, userId: sourceUser.userId }))?.phase).toBe('retired')
  expect((await targetControl?.status({ identityKey: identity, userId: targetUser.userId }))?.phase).toBe('activated')
  await expect(source.activeWriteTransaction(sourceUser)).rejects.toMatchObject({ code: 'WERR_NOT_ACTIVE' })
  const replacement = new WalletStorageManager(identity, source, [target])
  await replacement.makeAvailable()
  await replacement.setActive(targetKey)
  expect(replacement.getActive()).toBe(target)
  expect(replacement.isActiveEnabled).toBe(true)
  expect(await target.findOutputBaskets({ partial: { name: 'actual recovered primary basket' } })).toHaveLength(1)
  expect((await sourceControl?.status(sourceUser))?.phase).toBe('complete')
  expect((await targetControl?.status(targetUser))?.phase).toBe('complete')
  // The interrupted local manager can also reconcile the now-completed durable
  // state and clear only its own stale lifecycle barrier.
  await manager.setActive(targetKey)
  expect(manager.getActive()).toBe(target)
  expect(manager.isActiveEnabled).toBe(true)
})

test('cancellation during a genuine warm copy drains and allows the same durable plan to resume', async () => {
  const entered = gate(),
    release = gate(),
    controller = new AbortController()
  const open = source.openCurrentSnapshotJournalSource.bind(source)
  let first = true
  jest.spyOn(source, 'openCurrentSnapshotJournalSource').mockImplementation(async (...args) => {
    const actual = await open(...args)
    return new Proxy(actual, {
      get(object, key) {
        if (key !== 'readDeltaPage') return Reflect.get(object, key)
        return async (...request: Parameters<typeof actual.readDeltaPage>) => {
          if (first) {
            first = false
            entered.resolve()
            await release.promise
          }
          return await actual.readDeltaPage(...request)
        }
      }
    })
  })
  const targetKey = target.getSettings().storageIdentityKey
  const transition = manager.setActive(targetKey, undefined, { signal: controller.signal })
  try {
    await Promise.race([
      entered.promise,
      transition.then(() => {
        throw new Error('Actual warm copy did not pause')
      })
    ])
    controller.abort(new Error('requested primary cancellation'))
    release.resolve()
    await expect(transition).rejects.toBeInstanceOf(Error)
    await manager.makeAvailable()
    expect(manager.getActive()).toBe(source)
    expect(manager.isActiveEnabled).toBe(true)
    await expect(source.activeWriteTransaction((await source.findOrInsertUser(identity)).user)).resolves.toBeDefined()
    await manager.setActive(targetKey)
    expect(manager.getActive()).toBe(target)
    expect(manager.isActiveEnabled).toBe(true)
  } finally {
    release.resolve()
    await transition.catch(() => undefined)
  }
})

test('primary handoff continues through genuine large operational history and retains its exact field provenance', async () => {
  // The original checkpoint API creates this actual managed-peer history.
  // It is operational provenance, without a financial placeholder or ACK.
  await source.getSyncCheckpoint(
    await manager.getAuth(),
    target.getSettings().storageIdentityKey,
    target.getSettings().storageName
  )
  const states = await source.findSyncStates({
    partial: { userId: (await source.findOrInsertUser(identity)).user.userId }
  })
  expect(states.length).toBeGreaterThan(0)
  const state = states[0],
    originalError = JSON.stringify({
      name: 'Error',
      message: 'retained original sync error 雪\u0000' + '🧾'.repeat(40000)
    })
  await source.updateSyncState(state.syncStateId, { errorLocal: originalError, updated_at: new Date() })
  const warm = await manager.syncToWriterResumable(await manager.getAuth(), target, {
    journalFields: true,
    maxRoughSize: 65536
  })
  expect(warm.status).toBe('completed')
  // A replacement manager must recover protocol choice from the actual window,
  // without an in-memory protocol flag or granting authority to status DATA.
  manager = new WalletStorageManager(identity, source, [target])
  await manager.makeAvailable()
  const sourceIdentity = source.getSettings().storageIdentityKey,
    targetIdentity = target.getSettings().storageIdentityKey
  await manager.setActive(targetIdentity, undefined, { maxRoughSize: 65536 })
  expect(manager.getActive()).toBe(target)
  expect(manager.isActiveEnabled).toBe(true)
  for (const storage of [source, target]) {
    expect((await storage.findOrInsertUser(identity)).user.activeStorage).toBe(targetIdentity)
    expect(
      await (await storage.getPrimaryHandoffControl())!.status({
        identityKey: identity,
        userId: (await storage.findOrInsertUser(identity)).user.userId
      })
    ).toMatchObject({ phase: 'complete' })
  }
  const window = await sourceWindow()
  expect(window.fieldEncoding).toBe('wallet-journal-fields/1')
  const provenance = await manager.readJournalFieldProvenance(sourceIdentity),
    retained = provenance.page.rows.find(row => row.incomingId === state.syncStateId)
  expect(retained?.fields.errorLocal.bytes).toBe(Buffer.byteLength(originalError))
  const reader = await manager.openJournalProvenanceField(sourceIdentity, state.syncStateId, 'errorLocal', {
      checkpoint: provenance.checkpoint
    }),
    actual = Buffer.alloc(Buffer.byteLength(originalError))
  try {
    for (let offset = 0; offset < actual.length; offset += 16001) {
      const chunk = await reader.read(offset, Math.min(16001, actual.length - offset))
      try {
        actual.set(chunk, offset)
      } finally {
        chunk.fill(0)
      }
    }
    expect(actual.toString('utf8')).toBe(originalError)
  } finally {
    actual.fill(0)
    reader.close()
  }
}, 120000)
