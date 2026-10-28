import { captureBrc38KnexDestinationFence, withBrc38KnexDestinationFence } from '../portable/Brc38KnexDestinationFence'
import { EntitySyncState } from '../schema/entities/EntitySyncState'
import { knex } from 'knex'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
import { canonicalPrimaryHandoffPlan } from '../KnexPrimaryHandoffControl'
import type { PrimaryHandoffPlan } from '../PrimaryHandoffControl'
import {
  PRIMARY_HANDOFF_TABLE,
  removePrimaryHandoffSchema,
  verifyPrimaryHandoffSchema
} from '../schema/primaryHandoffMigration'
import { Validation } from '@bsv/sdk'
import { _tu } from '../../../test/utils/TestUtilsWalletStorage'

const identityKey = '02' + '11'.repeat(32),
  operationId = 'ab'.repeat(16)
async function fixture(local = 'source', peerSnapshotSync = true) {
  const directory = await mkdtemp(join(tmpdir(), 'actual-primary-handoff-'))
  const config = {
    client: 'better-sqlite3',
    connection: { filename: join(directory, 'wallet.sqlite') },
    useNullAsDefault: true,
    pool: { min: 0, max: 1 }
  }
  const storage = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: knex(config) })
  const peer = new StorageKnex({
    ...StorageProvider.createStorageBaseOptions('test'),
    snapshotSync: peerSnapshotSync,
    knex: knex(config)
  })
  const close = async () => {
    const results = await Promise.allSettled([storage.destroy(), peer.destroy()])
    await rm(directory, { recursive: true, force: true })
    const errors = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
    if (errors.length) throw new AggregateError(errors, 'Actual control roots did not drain')
  }
  try {
    await storage.knex.raw('PRAGMA journal_mode = WAL')
    await storage.migrate('actual primary control fixture', local)
    await storage.makeAvailable()
    await peer.makeAvailable()
    const { user } = await storage.findOrInsertUser(identityKey)
    const control = await storage.getPrimaryHandoffControl(),
      independent = peerSnapshotSync ? await peer.getPrimaryHandoffControl() : control
    if (control == null || independent == null) throw new Error('Actual migrated SQL control unavailable')
    return { storage, peer, user, auth: { userId: user.userId, identityKey }, control, independent, close }
  } catch (error) {
    await close()
    throw error
  }
}
function plan(epoch = '0'): PrimaryHandoffPlan {
  return {
    version: 1,
    operationId,
    targetStorageIdentityKey: 'target',
    sources: [{ storageIdentityKey: 'source', epoch }]
  }
}

afterEach(() => jest.restoreAllMocks())

test('actual source retirement persists across independent controllers and fences old writes', async () => {
  const f = await fixture()
  try {
    expect(await f.control.status(f.auth)).toBeUndefined()
    await f.storage.updateUser(f.user.userId, { updated_at: new Date(0) })
    const old = await f.storage.activeWriteTransaction(f.auth)
    const prepared = await f.control.prepareSource(f.auth, operationId, 'target')
    expect(prepared).toEqual({ storageIdentityKey: 'source', epoch: '0' })
    await expect(old.assertCurrent()).resolves.toBeUndefined()
    expect(await f.independent.prepareSource(f.auth, operationId, 'target')).toEqual(prepared)
    const retired = await f.control.retireSource(f.auth, plan(prepared.epoch))
    expect(retired).toMatchObject({ side: 'source', phase: 'retired', localEpoch: '1', sourceEpoch: '0' })
    expect(await f.independent.status(f.auth)).toEqual(retired)
    expect(await f.independent.retireSource(f.auth, plan(prepared.epoch))).toEqual(retired)
    expect((await f.storage.findUsers({ partial: { userId: f.user.userId } }))[0].activeStorage).toBe('target')
    expect((await f.storage.findUsers({ partial: { userId: f.user.userId } }))[0].updated_at.getTime()).toBeGreaterThan(
      0
    )
    const apply = jest.fn(async () => {})
    await expect(old.transaction(apply)).rejects.toMatchObject({ code: 'WERR_NOT_ACTIVE' })
    expect(apply).not.toHaveBeenCalled()
    const row = await f.storage.knex(PRIMARY_HANDOFF_TABLE).first()
    expect([row.roleGateFrom, row.roleGateTo, row.roleGateEpoch]).toEqual([null, null, null])
    expect(await f.storage.knex('snapshot_sync_primary_epochs')).toEqual([{ userId: f.user.userId, epoch: 1 }])
  } finally {
    await f.close()
  }
})

test('target preparation parks a genuinely writable conflicting target and never activates it', async () => {
  const source = await fixture(),
    target = await fixture('target')
  try {
    const sourceWrite = await source.storage.activeWriteTransaction(source.auth)
    const targetWrite = await target.storage.activeWriteTransaction(target.auth)
    const prepared = await source.control.prepareSource(source.auth, operationId, 'target')
    const selected = plan(prepared.epoch)
    const parked = await target.control.prepareTarget(target.auth, selected)
    expect(parked).toMatchObject({ side: 'target', phase: 'prepared', localEpoch: '1', plan: selected })
    expect(await target.independent.prepareTarget(target.auth, selected)).toEqual(parked)
    await expect(targetWrite.transaction(async () => {})).rejects.toMatchObject({ code: 'WERR_NOT_ACTIVE' })
    await expect(sourceWrite.assertCurrent()).resolves.toBeUndefined()
    await source.control.retireSource(source.auth, selected)
    await expect(sourceWrite.assertCurrent()).rejects.toMatchObject({ code: 'WERR_NOT_ACTIVE' })
    await expect(target.storage.activeWriteTransaction(target.auth)).rejects.toMatchObject({ code: 'WERR_NOT_ACTIVE' })
    expect((await target.storage.findUsers({ partial: { userId: target.user.userId } }))[0].activeStorage).toBe(
      'source'
    )
  } finally {
    await Promise.all([source.close(), target.close()])
  }
})

test('competing operation IDs, targets and original epochs cannot overwrite pending actual intent', async () => {
  const f = await fixture()
  try {
    await f.control.prepareSource(f.auth, operationId, 'target')
    await expect(f.independent.prepareSource(f.auth, 'cd'.repeat(16), 'target')).rejects.toThrow('conflicts')
    await expect(f.independent.prepareSource(f.auth, operationId, 'different-target')).rejects.toThrow('conflicts')
    await expect(f.control.retireSource(f.auth, plan('1'))).rejects.toThrow('conflicts')
    expect((await f.control.status(f.auth))?.phase).toBe('prepared')
    await f.control.retireSource(f.auth, plan())
    await expect(f.control.prepareSource(f.auth, 'cd'.repeat(16), 'source')).rejects.toThrow()
    expect((await f.independent.status(f.auth))?.phase).toBe('retired')
  } finally {
    await f.close()
  }
})

test('actual database guards reject legacy DATA or control reactivation after enrollment', async () => {
  const f = await fixture()
  try {
    await f.control.prepareSource(f.auth, operationId, 'target')
    await expect(f.peer.updateUser(f.user.userId, { activeStorage: 'target' })).rejects.toThrow(
      'Coordinated primary control'
    )
    await f.control.retireSource(f.auth, plan())
    await expect(
      f.peer.knex('users').where({ userId: f.user.userId }).update({ activeStorage: 'source' })
    ).rejects.toThrow('Coordinated primary control')
    await expect(f.peer.setActive({ ...f.auth, isActive: true }, 'source')).rejects.toThrow(
      'Coordinated primary control'
    )
    expect((await f.independent.status(f.auth))?.phase).toBe('retired')
    // No-op replication of the actual selection remains compatible.
    await expect(f.peer.updateUser(f.user.userId, { activeStorage: 'target' })).resolves.toBe(1)
  } finally {
    await f.close()
  }
})

test('unenrolled profiles and unrelated users retain their original role-control behavior', async () => {
  const f = await fixture()
  try {
    await f.peer.setActive(f.auth, 'target')
    await f.peer.setActive(f.auth, 'source')
    const other = (await f.storage.findOrInsertUser('03' + '22'.repeat(32))).user
    await f.control.prepareSource(f.auth, operationId, 'target')
    await f.peer.setActive(other, 'different-primary')
    expect((await f.storage.findUsers({ partial: { userId: other.userId } }))[0].activeStorage).toBe(
      'different-primary'
    )
    await expect(f.control.status({ identityKey, userId: other.userId, isActive: true })).rejects.toMatchObject({
      code: 'WERR_UNAUTHORIZED'
    })
    await expect(
      f.control.prepareSource({ ...other, isActive: true }, 'cd'.repeat(16), 'target')
    ).rejects.toMatchObject({ code: 'WERR_NOT_ACTIVE' })
  } finally {
    await f.close()
  }
})

test('missing or changed actual control triggers refuse both existing and fresh control handles', async () => {
  const f = await fixture()
  try {
    await f.storage.knex.raw('DROP TRIGGER wallet_primary_control_guard')
    await expect(f.control.prepareSource(f.auth, operationId, 'target')).rejects.toThrow('schema')
    await expect(f.peer.getPrimaryHandoffControl()).rejects.toThrow('schema')
    expect(await f.storage.knex(PRIMARY_HANDOFF_TABLE)).toEqual([])
  } finally {
    await f.close()
  }
})

test('control rollback preserves role, epoch and intent, and enrolled downgrade is refused', async () => {
  const f = await fixture()
  try {
    await f.control.prepareSource(f.auth, operationId, 'target')
    const stop = (query: { sql: string; bindings?: readonly unknown[] }) => {
      if (/^update [`"]wallet_primary_handoffs[`"]/.test(query.sql) && query.bindings?.includes('retired'))
        throw new Error('injected retirement rollback')
    }
    const original = f.storage.runSnapshotJournalWriter.bind(f.storage)
    let injected = false
    const writer = jest.spyOn(f.storage, 'runSnapshotJournalWriter').mockImplementation(
      async (apply, backend, signal) =>
        await original(
          async (trx, actualBackend) => {
            trx.on('query', stop)
            try {
              injected = true
              return await apply(trx, actualBackend)
            } finally {
              trx.removeListener('query', stop)
            }
          },
          backend,
          signal
        )
    )
    try {
      await expect(f.control.retireSource(f.auth, plan())).rejects.toThrow('injected retirement rollback')
      expect(injected).toBe(true)
    } finally {
      writer.mockRestore()
    }
    expect((await f.independent.status(f.auth))?.phase).toBe('prepared')
    expect((await f.storage.findUsers({ partial: { userId: f.user.userId } }))[0].activeStorage).toBe('source')
    expect(await f.storage.knex('snapshot_sync_primary_epochs')).toEqual([])
    await expect(removePrimaryHandoffSchema(f.storage.knex)).rejects.toThrow('forward recovery')
    await verifyPrimaryHandoffSchema(f.storage.knex)
    expect((await f.control.retireSource(f.auth, plan())).phase).toBe('retired')
  } finally {
    await f.close()
  }
})

test('bounded canonical plans reject DATA-shaped extra authority and malformed participant sets', () => {
  expect(canonicalPrimaryHandoffPlan(plan())).toEqual(plan())
  for (const bad of [
    { ...plan(), isActive: true },
    { ...plan(), sources: [] },
    { ...plan(), sources: Array(9).fill(plan().sources[0]) },
    { ...plan(), sources: [plan().sources[0], plan().sources[0]] },
    { ...plan(), operationId: 'x'.repeat(33) },
    plan('9223372036854775808')
  ])
    expect(() => canonicalPrimaryHandoffPlan(bad)).toThrow()
})

test('an actual createAction prepared before durable source retirement cannot publish ownership', async () => {
  const ctx = await _tu.createLegacyWalletSQLiteCopy('primary-handoff-real-create-race', 'legacy')
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let entered!: () => void
  const reached = new Promise<void>(resolve => {
    entered = resolve
  })
  let pending: Promise<unknown> | undefined
  try {
    await _tu.installOfflineLegacyChainTracker(ctx)
    await ctx.activeStorage.knex.raw('PRAGMA journal_mode = WAL')
    const control = await ctx.activeStorage.getPrimaryHandoffControl()
    if (control == null) throw new Error('Actual SQL control unavailable')
    const auth = { identityKey: ctx.identityKey, userId: ctx.userId }
    const before = await ctx.activeStorage.knex('transactions').count({ n: '*' }).first()
    const available = ctx.activeStorage.findOutputBaskets.bind(ctx.activeStorage)
    jest.spyOn(ctx.activeStorage, 'findOutputBaskets').mockImplementationOnce(async (...args) => {
      const result = await available(...args)
      entered()
      await gate
      return result
    })
    pending = ctx.activeStorage.createAction(
      auth,
      Validation.validateCreateActionArgs({
        description: 'real primary retirement preparation race',
        outputs: [{ satoshis: 1, lockingScript: '51', outputDescription: 'retired output' }],
        options: { noSend: true }
      })
    )
    await Promise.race([
      reached,
      pending.then(() => {
        throw new Error('Actual createAction did not pause at preparation')
      })
    ])
    const source = await control.prepareSource(auth, operationId, 'target')
    await control.retireSource(auth, { ...plan(source.epoch), sources: [source] })
    release()
    await expect(pending).rejects.toMatchObject({ code: 'WERR_NOT_ACTIVE' })
    expect(await ctx.activeStorage.knex('transactions').count({ n: '*' }).first()).toEqual(before)
  } finally {
    release()
    await pending?.catch(() => undefined)
    await ctx.wallet.destroy()
  }
})

test('a mutable manager authentication object cannot change an admitted control identity', async () => {
  const f = await fixture()
  try {
    const other = (await f.storage.findOrInsertUser('03' + '22'.repeat(32))).user
    const mutable = { ...f.auth }
    const pending = f.control.prepareSource(mutable, operationId, 'target')
    mutable.userId = other.userId
    mutable.identityKey = other.identityKey
    await pending
    expect((await f.control.status(f.auth))?.phase).toBe('prepared')
    expect(await f.control.status(other)).toBeUndefined()
  } finally {
    await f.close()
  }
})

test('even empty control schema uses forward recovery rather than a racy MySQL-style downgrade', async () => {
  const f = await fixture()
  try {
    await expect(removePrimaryHandoffSchema(f.storage.knex)).rejects.toThrow('forward recovery')
    await verifyPrimaryHandoffSchema(f.storage.knex)
    expect(await f.control.status(f.auth)).toBeUndefined()
  } finally {
    await f.close()
  }
})

test('actual legacy DATA prepared before retirement cannot merge rows or advance its checkpoint', async () => {
  const source = await fixture('backup'),
    destination = await fixture()
  try {
    await source.storage.findOrInsertTxLabel(source.user.userId, 'actual late sync label')
    const ss = await EntitySyncState.fromStorage(destination.storage, identityKey, source.storage.getSettings())
    const args = ss.makeRequestSyncChunkArgs(identityKey, 'source')
    const chunk = await source.storage.getSyncChunk(args)
    const prepared = await destination.storage.prepareSyncChunk(args, chunk)
    const before = await destination.storage.knex('sync_states')
    await destination.control.prepareSource(destination.auth, operationId, 'target')
    await destination.control.retireSource(destination.auth, plan())
    await expect(destination.storage.transaction(async trx => await prepared(trx))).rejects.toMatchObject({
      code: 'WERR_NOT_ACTIVE'
    })
    await expect(destination.storage.processSyncChunk(args, chunk)).rejects.toMatchObject({ code: 'WERR_NOT_ACTIVE' })
    expect(await destination.storage.knex('sync_states')).toEqual(before)
    expect(await destination.storage.findTxLabels({ partial: { label: 'actual late sync label' } })).toEqual([])
  } finally {
    await Promise.all([source.close(), destination.close()])
  }
})

test('enrolled target DATA preserves parked selection while merging genuine allowed-source rows', async () => {
  const source = await fixture(),
    target = await fixture('target'),
    foreign = await fixture('foreign')
  try {
    const prepared = await source.control.prepareSource(source.auth, operationId, 'target')
    await target.control.prepareTarget(target.auth, plan(prepared.epoch))
    await source.storage.findOrInsertTxLabel(source.user.userId, 'declared actual source label')
    await source.control.retireSource(source.auth, plan(prepared.epoch))
    const ss = await EntitySyncState.fromStorage(target.storage, identityKey, source.storage.getSettings())
    const args = ss.makeRequestSyncChunkArgs(identityKey, 'target')
    const chunk = await source.storage.getSyncChunk(args)
    // The actual source selects target after retirement. A DATA user merge
    // cannot activate it or bypass the explicit durable control gate.
    expect(chunk.user?.activeStorage).toBe('target')
    if (chunk.user == null) throw new Error('Genuine sync user missing')
    chunk.user.updated_at = new Date(Date.now() + 1000)
    await target.storage.processSyncChunk(args, chunk)
    expect(await target.storage.findTxLabels({ partial: { label: 'declared actual source label' } })).toHaveLength(1)
    expect((await target.storage.findUsers({ partial: { userId: target.user.userId } }))[0].activeStorage).toBe(
      'source'
    )
    expect((await target.control.status(target.auth))?.phase).toBe('prepared')
    await foreign.storage.findOrInsertTxLabel(foreign.user.userId, 'undeclared source label')
    const foreignState = await EntitySyncState.fromStorage(target.storage, identityKey, foreign.storage.getSettings())
    const foreignArgs = foreignState.makeRequestSyncChunkArgs(identityKey, 'target')
    await expect(
      target.storage.processSyncChunk(foreignArgs, await foreign.storage.getSyncChunk(foreignArgs))
    ).rejects.toMatchObject({ code: 'WERR_NOT_ACTIVE' })
    expect(await target.storage.findTxLabels({ partial: { label: 'undeclared source label' } })).toEqual([])
  } finally {
    await Promise.all([source.close(), target.close(), foreign.close()])
  }
})

test('disabling snapshot capability cannot downgrade an enrolled ordinary writer', async () => {
  const f = await fixture('source', false)
  try {
    expect(await f.peer.supportsPrimaryWriteFences()).toBe(false)
    await f.control.prepareSource(f.auth, operationId, 'target')
    expect(await f.peer.supportsPrimaryWriteFences()).toBe(true)
    const old = await f.peer.activeWriteTransaction(f.auth)
    await f.control.retireSource(f.auth, plan())
    const apply = jest.fn(async () => {})
    await expect(old.transaction(apply)).rejects.toMatchObject({ code: 'WERR_NOT_ACTIVE' })
    await expect(f.peer.activeWriteTransaction(f.auth)).rejects.toMatchObject({ code: 'WERR_NOT_ACTIVE' })
    expect(apply).not.toHaveBeenCalled()
  } finally {
    await f.close()
  }
})

test('changed actual control guards reject incoming enrolled DATA without cached schema authority', async () => {
  const source = await fixture('backup'),
    target = await fixture()
  try {
    await target.control.prepareSource(target.auth, operationId, 'target')
    const ss = await EntitySyncState.fromStorage(target.storage, identityKey, source.storage.getSettings())
    const args = ss.makeRequestSyncChunkArgs(identityKey, 'source')
    const chunk = await source.storage.getSyncChunk(args)
    await target.storage.processSyncChunk(args, chunk)
    await target.storage.knex.raw('DROP TRIGGER wallet_primary_control_guard')
    await expect(target.storage.processSyncChunk(args, chunk)).rejects.toThrow('schema')
    await expect(target.storage.activeWriteTransaction(target.auth)).rejects.toThrow('schema')
  } finally {
    await Promise.all([source.close(), target.close()])
  }
})

test('activation cannot select a target from control DATA without actual final financial ACKs', async () => {
  const source = await fixture(),
    target = await fixture('target')
  try {
    const prepared = await source.control.prepareSource(source.auth, operationId, 'target')
    const selected = plan(prepared.epoch)
    await target.control.prepareTarget(target.auth, selected)
    await source.control.retireSource(source.auth, selected)
    await expect(target.control.activateTarget(target.auth, selected)).rejects.toThrow('actual completed')
    expect((await target.independent.status(target.auth))?.phase).toBe('prepared')
    expect((await target.storage.findUsers({ partial: { userId: target.user.userId } }))[0].activeStorage).toBe(
      'source'
    )
    await expect(source.control.cancel(source.auth, operationId)).rejects.toThrow('recover forward')
    await expect(target.control.completeTarget(target.auth, selected)).rejects.toThrow()
  } finally {
    await Promise.all([source.close(), target.close()])
  }
})

test('cancellation preserves source writes, never reactivates a parked target, and permits a fresh operation', async () => {
  const source = await fixture(),
    target = await fixture('target')
  try {
    const prepared = await source.control.prepareSource(source.auth, operationId, 'target')
    await target.control.prepareTarget(target.auth, plan(prepared.epoch))
    expect((await source.control.cancel(source.auth, operationId)).phase).toBe('cancelled')
    await expect(source.storage.activeWriteTransaction(source.auth)).resolves.toBeDefined()
    expect((await target.control.cancel(target.auth, operationId)).phase).toBe('cancelled')
    await expect(target.storage.activeWriteTransaction(target.auth)).rejects.toMatchObject({ code: 'WERR_NOT_ACTIVE' })
    await expect(source.control.retireSource(source.auth, plan())).rejects.toThrow()
    await expect(target.control.activateTarget(target.auth, plan())).rejects.toThrow()
    const next = 'cd'.repeat(16)
    await source.control.prepareSource(source.auth, next, 'target')
    await target.control.prepareTarget(target.auth, { ...plan(), operationId: next })
    expect((await source.independent.status(source.auth))?.operationId).toBe(next)
    expect((await target.independent.status(target.auth))?.operationId).toBe(next)
  } finally {
    await Promise.all([source.close(), target.close()])
  }
})

test('explicit backup propagation cannot bypass retirement of an actual writable participant', async () => {
  const f = await fixture('backup')
  try {
    await expect(f.control.followTarget(f.auth, plan())).rejects.toThrow()
    expect(await f.control.status(f.auth)).toBeUndefined()
    await f.peer.setActive(f.auth, 'source')
    const followed = await f.control.followTarget(f.auth, plan())
    expect(followed).toMatchObject({ side: 'backup', phase: 'complete', targetStorageIdentityKey: 'target' })
    expect(await f.independent.followTarget(f.auth, plan())).toEqual(followed)
    await expect(f.storage.activeWriteTransaction(f.auth)).rejects.toMatchObject({ code: 'WERR_NOT_ACTIVE' })
    await expect(f.peer.setActive(f.auth, 'backup')).rejects.toThrow('Coordinated primary control')
  } finally {
    await f.close()
  }
})

test('cancelling an actual control writer before physical commit rolls back role epoch and intent together', async () => {
  const f = await fixture(),
    controller = new AbortController()
  try {
    const control = await f.storage.getPrimaryHandoffControl({ signal: controller.signal })
    if (control === undefined) throw new Error('Actual control unavailable')
    await control.prepareSource(f.auth, operationId, 'target')
    const update = f.storage.updateUser.bind(f.storage)
    const spy = jest.spyOn(f.storage, 'updateUser').mockImplementation(async (...args) => {
      const result = await update(...args)
      if (args[1].activeStorage === 'target') controller.abort(new Error('actual cutover cancellation'))
      return result
    })
    try {
      await expect(control.retireSource(f.auth, plan())).rejects.toThrow('actual cutover cancellation')
    } finally {
      spy.mockRestore()
    }
    expect((await f.independent.status(f.auth))?.phase).toBe('prepared')
    expect((await f.storage.findUsers({ partial: { userId: f.user.userId } }))[0].activeStorage).toBe('source')
    expect(await f.storage.knex('snapshot_sync_primary_epochs')).toEqual([])
    await expect(f.storage.activeWriteTransaction(f.auth)).resolves.toBeDefined()
  } finally {
    await f.close()
  }
})

test('genuine restore writer defers on a retired source while read-only preview remains observable', async () => {
  const f = await fixture()
  try {
    await f.storage.knex.raw('PRAGMA journal_mode=WAL')
    await f.control.prepareSource(f.auth, operationId, 'target')
    await f.control.retireSource(f.auth, plan())
    const policy = await f.storage
      .knex('snapshot_journal_retention')
      .select('receiptLimit', 'receiptLifetimeMs')
      .first()
    if (policy === undefined) throw new Error('Actual retention policy unavailable')
    const selected = { identityKey, chain: 'test' as const, targetStorageIdentityKey: 'source', mode: 'merge' as const }
    const preview = await captureBrc38KnexDestinationFence(f.storage, selected, policy)
    const before = await f.storage.knex('tx_labels')
    const apply = jest.fn(
      async (trx: import('knex').Knex.Transaction) =>
        await f.storage.findOrInsertTxLabel(f.user.userId, 'late restore row', trx)
    )
    await expect(withBrc38KnexDestinationFence(f.storage, preview, policy, apply)).rejects.toMatchObject({
      code: 'WERR_NOT_ACTIVE'
    })
    expect(apply).not.toHaveBeenCalled()
    expect(await f.storage.knex('tx_labels')).toEqual(before)
    expect((await f.independent.status(f.auth))?.phase).toBe('retired')
  } finally {
    await f.close()
  }
})

test.each(['memory', 'rollback-file'] as const)(
  'unenrolled %s storage retains legacy selection without advertising journal primary control',
  async kind => {
    const directory = await mkdtemp(join(tmpdir(), 'primary-unsupported-')),
      storage = new StorageKnex({
        ...StorageProvider.createStorageBaseOptions('test'),
        knex: knex({
          client: 'better-sqlite3',
          connection: { filename: kind === 'memory' ? ':memory:' : join(directory, 'wallet.sqlite') },
          useNullAsDefault: true,
          pool: { min: 0, max: 1 }
        })
      })
    try {
      await storage.migrate('actual legacy primary fixture', 'legacy-root')
      await storage.makeAvailable()
      const { user } = await storage.findOrInsertUser(identityKey)
      expect(await storage.supportsPrimaryWriteFences()).toBe(true)
      expect(await storage.supportsSnapshotJournalSync()).toBe(false)
      expect(await storage.getPrimaryHandoffControl()).toBeUndefined()
      await storage.updateUser(user.userId, { activeStorage: 'legacy-peer' })
      expect((await storage.findUsers({ partial: { userId: user.userId } }))[0].activeStorage).toBe('legacy-peer')
      expect(await storage.knex(PRIMARY_HANDOFF_TABLE)).toHaveLength(0)
    } finally {
      await storage.destroy()
      await rm(directory, { recursive: true, force: true })
    }
  }
)

test('an enrolled actual profile cannot downgrade control when its journal backend becomes unavailable', async () => {
  const f = await fixture()
  try {
    const original = await f.storage.activeWriteTransaction(f.auth)
    await f.control.prepareSource(f.auth, operationId, 'target')
    // Drain the independent physical connection before changing the actual
    // journal mode. No mocked capability can substitute for this prerequisite.
    await f.peer.destroy()
    await f.storage.knex.raw('PRAGMA journal_mode = DELETE')
    expect(await f.storage.supportsSnapshotJournalSync()).toBe(false)
    await expect(f.storage.getPrimaryHandoffControl()).rejects.toThrow('actual journal backend')
    await expect(original.assertCurrent()).resolves.toBeUndefined()
    await expect(f.storage.updateUser(f.user.userId, { activeStorage: 'target' })).rejects.toThrow()
    await f.storage.knex.raw('PRAGMA journal_mode = WAL')
    expect(await (await f.storage.getPrimaryHandoffControl())!.status(f.auth)).toMatchObject({
      phase: 'prepared',
      side: 'source'
    })
  } finally {
    await f.close()
  }
})

test('explicit full data deletion erases enrolled control while ordinary downgrade remains refused', async () => {
  const f = await fixture()
  try {
    await f.control.prepareSource(f.auth, operationId, 'target')
    const before = await f.storage.knex(PRIMARY_HANDOFF_TABLE).first()
    await expect(removePrimaryHandoffSchema(f.storage.knex)).rejects.toThrow('forward recovery')
    expect(await f.storage.knex(PRIMARY_HANDOFF_TABLE).first()).toEqual(before)
    await f.storage.dropAllData()
    for (const table of ['users', 'wallet_primary_handoffs', 'wallet_primary_copy_sources'])
      expect(await f.storage.knex.schema.hasTable(table)).toBe(false)
    expect(await f.storage.knex('knex_migrations')).toEqual([])
    await f.storage.dropAllData()
  } finally {
    await f.close()
  }
})
