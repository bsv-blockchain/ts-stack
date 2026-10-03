import { knex, type Knex } from 'knex'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StorageKnex } from '../../StorageKnex'
import { StorageProvider } from '../../StorageProvider'
import { seedArchiveClosure } from '../../../../test/utils/snapshotArchiveFixtures'
import {
  installSnapshotJournalSqliteGeneration,
  completeSnapshotJournalSqliteGeneration
} from './SnapshotJournalSqliteGeneration'
import { copySnapshotJournalBootstrapPage } from './SnapshotJournalBootstrap'
import { readSnapshotJournalReceipt } from './SnapshotJournalReceipt'
import { snapshotJournalRevision } from './SnapshotJournalRevision'
import { SnapshotJournalConnectionCleanupError } from './SnapshotJournalConnections'
import type { SnapshotJournalCaptureRequest, SnapshotJournalSource } from './SnapshotJournalCapture'
import * as Closure from '../archive/KnexSnapshotArchiveClosure'
import * as Backend from './SnapshotJournalCaptureBackend'
import * as Receipts from './SnapshotJournalReceipt'
import { snapshotArchiveTables } from '../archive/KnexSnapshotArchiveStore'

const identity = '02' + '11'.repeat(32)
let request: SnapshotJournalCaptureRequest
beforeEach(() => {
  request = {
    ceiling: snapshotJournalRevision('1000000'),
    receiptPolicy: { receiptLimit: 128, receiptLifetimeMs: 600000 }
  }
})
function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => {
    resolve = yes
  })
  return { promise, resolve }
}
async function fixture(complete = true) {
  const directory = await mkdtemp(join(tmpdir(), 'ts569-capture-controller-'))
  const k = knex({
    client: 'better-sqlite3',
    connection: { filename: join(directory, 'wallet.sqlite') },
    useNullAsDefault: true,
    pool: { min: 0, max: 1 }
  })
  const storage = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: k })
  try {
    await storage.migrate('capture controller', 'synthetic-capture-controller')
    await storage.makeAvailable()
    await k.raw('PRAGMA journal_mode = WAL')
    const { user } = await storage.findOrInsertUser(identity)
    const { user: foreign } = await storage.findOrInsertUser('03' + '22'.repeat(32))
    await seedArchiveClosure(storage, user.userId, foreign.userId)
    await installSnapshotJournalSqliteGeneration(k, request.ceiling, request.receiptPolicy)
    if (complete) {
      let finished = false
      for (let n = 0; n < 80 && !finished; n++) finished = (await copySnapshotJournalBootstrapPage(k, 1000000)).complete
      expect(finished).toBe(true)
      await completeSnapshotJournalSqliteGeneration(k, request.receiptPolicy)
    }
    return {
      k,
      storage,
      directory,
      close: async () => {
        await storage.destroy()
        await rm(directory, { recursive: true, force: true })
      }
    }
  } catch (error) {
    await storage.destroy()
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

afterEach(() => jest.restoreAllMocks())

test('all thirteen tables retain their pinned values while independent writers modify every table', async () => {
  const f = await fixture()
  const view = await f.storage.openSnapshotJournalSource(identity, request)
  const raw = [
    'proven_txs',
    'proven_tx_reqs',
    'output_baskets',
    'transactions',
    'commissions',
    'outputs',
    'output_tags',
    'output_tags_map',
    'tx_labels',
    'tx_labels_map',
    'certificates',
    'certificate_fields',
    'sync_states'
  ]
  try {
    expect(snapshotArchiveTables).toHaveLength(13)
    const before = []
    for (const table of snapshotArchiveTables) {
      const page = await view.readPage(table)
      expect(page.done).toBe(true)
      expect(page.rows.length).toBeGreaterThan(0)
      before.push(page.rows)
    }
    for (const table of raw) await f.k(table).update({ created_at: new Date('2026-01-02T00:00:00Z').getTime() })
    for (const [index, table] of snapshotArchiveTables.entries()) {
      const page = await view.readPage(table)
      expect(page.rows).toEqual(before[index])
      for (const row of page.rows) if ('userId' in row) expect(row.userId).toBe(view.user.userId)
    }
    expect(before[0].map(row => ('provenTxId' in row ? row.provenTxId : undefined))).toEqual([1, 3])
    expect(before[1].map(row => ('provenTxReqId' in row ? row.provenTxReqId : undefined))).toEqual([1, 3])
    expect(before[12].map(row => ('syncStateId' in row ? row.syncStateId : undefined))).toEqual([1, 3])
  } finally {
    await view.close()
    await f.close()
  }
})

test('profile closure verification holds no writer barrier and publishes only after verification finishes', async () => {
  const f = await fixture(),
    entered = gate(),
    release = gate()
  const verify = Closure.assertKnexSnapshotArchiveClosure
  jest.spyOn(Closure, 'assertKnexSnapshotArchiveClosure').mockImplementation(async (...args) => {
    entered.resolve()
    await release.promise
    await verify(...args)
  })
  let view: SnapshotJournalSource | undefined
  try {
    const opening = f.storage.openSnapshotJournalSource(identity, request)
    let published = false
    void opening.then(
      () => {
        published = true
      },
      () => undefined
    )
    await entered.promise
    expect(await f.k('snapshot_journal_receipts')).toHaveLength(1)
    await f.k('tx_labels').where('txLabelId', 1).update({ label: 'foreground during closure' })
    expect(published).toBe(false)
    release.resolve()
    view = await opening
    expect((await view.readPage('txLabels')).rows.some(row => row.label === 'foreground during closure')).toBe(false)
  } finally {
    release.resolve()
    await view?.close()
    await f.close()
  }
})

test.each(['receipt before commit', 'closure after commit'] as const)(
  'cancellation during %s rejects promptly and drains before source capacity can reopen',
  async phase => {
    const f = await fixture(),
      entered = gate(),
      release = gate(),
      controller = new AbortController()
    if (phase === 'receipt before commit') {
      const record = Receipts.recordSnapshotJournalReceipt
      jest.spyOn(Receipts, 'recordSnapshotJournalReceipt').mockImplementation(async (...args) => {
        const result = await record(...args)
        entered.resolve()
        await release.promise
        return result
      })
    } else {
      const verify = Closure.assertKnexSnapshotArchiveClosure
      jest.spyOn(Closure, 'assertKnexSnapshotArchiveClosure').mockImplementation(async (...args) => {
        entered.resolve()
        await release.promise
        await verify(...args)
      })
    }
    try {
      const opening = f.storage.openSnapshotJournalSource(identity, request, {
        signal: controller.signal
      })
      const rejection = expect(opening).rejects.toThrow('cancelled')
      await entered.promise
      controller.abort()
      await rejection
      await expect(f.storage.openSnapshotJournalSource(identity, request)).rejects.toThrow('already has')
      let drained = false
      const cleanup = f.storage.awaitSnapshotJournalCaptureCleanup().then(() => {
        drained = true
      })
      await Promise.resolve()
      expect(drained).toBe(false)
      release.resolve()
      await cleanup
      expect(await f.k('snapshot_journal_receipts')).toHaveLength(phase === 'closure after commit' ? 1 : 0)
      jest.restoreAllMocks()
      const next = await f.storage.openSnapshotJournalSource(identity, request)
      expect(await f.k('snapshot_journal_receipts')).toHaveLength(phase === 'closure after commit' ? 2 : 1)
      await next.close()
    } finally {
      release.resolve()
      jest.restoreAllMocks()
      await f.close()
    }
  }
)

test('provider publishes only a committed receipt, serves immutable profile pages and releases its single source admission', async () => {
  const f = await fixture()
  let view: SnapshotJournalSource | undefined
  try {
    const labels = await f.storage.findTxLabels({ partial: { userId: 1 } })
    view = await f.storage.openSnapshotJournalSource(identity, request)
    expect(view.sourceStorage.chain).toBe('test')
    expect(view.user.identityKey).toBe(identity)
    expect(await f.k.transaction(t => readSnapshotJournalReceipt(t, view!.receiptBinding, view!.receipt))).toEqual(
      view.receipt
    )
    await expect(f.storage.openSnapshotJournalSource(identity, request)).rejects.toThrow('already has')
    await expect(f.storage.openSnapshotArchiveSource(identity)).rejects.toThrow('already has')
    await f.k('tx_labels').where('txLabelId', 1).update({ label: 'after capture' })
    const page = await view.readPage('txLabels')
    expect(page.rows.map(row => row.label)).toEqual(labels.map(row => row.label))
    expect(page.rows.every(row => row.userId === view!.user.userId)).toBe(true)
    const rows: Array<{ revision: string }> = await f
      .k('snapshot_journal_physical')
      .select(f.k.raw('CAST(revision AS TEXT) revision'))
    expect(rows.some(row => BigInt(row.revision) > BigInt(view!.receipt.highWater))).toBe(true)
    await view.close()
    const second = await f.storage.openSnapshotJournalSource(identity, request)
    expect(second.receipt.requestId).not.toBe(view.receipt.requestId)
    expect(BigInt(second.receipt.highWater)).toBeGreaterThan(BigInt(view.receipt.highWater))
    expect((await second.readPage('txLabels')).rows.some(row => row.label === 'after capture')).toBe(true)
    await second.close()
  } finally {
    await view?.close()
    await f.close()
  }
})

test('unfinished generation refuses publication and leaves no receipt; completed migration can be retried', async () => {
  const f = await fixture(false)
  try {
    await expect(f.storage.openSnapshotJournalSource(identity, request)).rejects.toThrow('generation')
    expect(await f.k('snapshot_journal_receipts')).toEqual([])
    let finished = false
    for (let n = 0; n < 80 && !finished; n++) finished = (await copySnapshotJournalBootstrapPage(f.k, 1000000)).complete
    await completeSnapshotJournalSqliteGeneration(f.k, request.receiptPolicy)
    const view = await f.storage.openSnapshotJournalSource(identity, request)
    await view.close()
  } finally {
    await f.close()
  }
})

test('an occupied writer refuses promptly without publishing or replaying the independent writer', async () => {
  const f = await fixture()
  const other = knex(f.k.client.config)
  let writer: Knex.Transaction | undefined
  try {
    writer = await other.transaction()
    await writer('tx_labels').where('txLabelId', 1).update({ label: 'uncommitted writer' })
    const start = performance.now()
    await expect(f.storage.openSnapshotJournalSource(identity, request)).rejects.toMatchObject({
      code: 'SQLITE_BUSY'
    })
    expect(performance.now() - start).toBeLessThan(1000)
    expect(await f.k('snapshot_journal_receipts')).toEqual([])
    await writer.commit()
    writer = undefined
    const view = await f.storage.openSnapshotJournalSource(identity, request)
    expect((await view.readPage('txLabels')).rows.some(row => row.label === 'uncommitted writer')).toBe(true)
    await view.close()
  } finally {
    await writer?.rollback()
    await other.destroy()
    await f.close()
  }
})

test('cancelled pool setup rejects opening promptly and retains admission until the pending work drains', async () => {
  const f = await fixture()
  const entered = gate(),
    release = gate(),
    controller = new AbortController()
  const acquire = f.k.client.acquireConnection.bind(f.k.client)
  jest.spyOn(f.k.client, 'acquireConnection').mockImplementation(async () => {
    entered.resolve()
    await release.promise
    return await acquire()
  })
  try {
    const opening = f.storage.openSnapshotJournalSource(identity, request, {
      signal: controller.signal
    })
    const rejection = expect(opening).rejects.toThrow('cancelled')
    await entered.promise
    controller.abort()
    await rejection
    await expect(f.storage.openSnapshotJournalSource(identity, request)).rejects.toThrow('already has')
    let destroyed = false
    const destruction = f.storage.destroy().then(() => {
      destroyed = true
    })
    await Promise.resolve()
    expect(destroyed).toBe(false)
    release.resolve()
    await destruction
    expect(destroyed).toBe(true)
    await expect(f.storage.openSnapshotJournalSource(identity, request)).rejects.toThrow('destruction')
  } finally {
    release.resolve()
    jest.restoreAllMocks()
    await f.close()
  }
})

test('provider destruction drains an active captured view before closing the foreground pool', async () => {
  const f = await fixture()
  try {
    const view = await f.storage.openSnapshotJournalSource(identity, request)
    await f.storage.destroy()
    expect(view.isOpen).toBe(false)
    await view.closed
    await expect(view.readPage('txLabels')).rejects.toThrow('closed')
    await expect(f.storage.openSnapshotJournalSource(identity, request)).rejects.toThrow('destruction')
  } finally {
    await f.close()
  }
})

test('public input is detached before asynchronous setup and invalid input does not reserve admission', async () => {
  const f = await fixture()
  try {
    await expect(f.storage.openSnapshotJournalSource('foreign', request)).rejects.toThrow('identityKey')
    const input = { ...request, receiptPolicy: { ...request.receiptPolicy } }
    const opening = f.storage.openSnapshotJournalSource(identity, input)
    input.receiptPolicy.receiptLimit = 1
    input.ceiling = snapshotJournalRevision('1')
    const view = await opening
    expect(view.receipt.highWater).not.toBe('1')
    await view.close()
  } finally {
    await f.close()
  }
})

test('source failure is retriable after physical cleanup; an unproved close fences provider capacity', async () => {
  const f = await fixture()
  try {
    await expect(f.storage.openSnapshotJournalSource('02' + '99'.repeat(32), request)).rejects.toThrow(
      'existing wallet profile'
    )
    const view = await f.storage.openSnapshotJournalSource(identity, request)
    await view.close()
    // The cleanup helper is exercised with a failed native close in the backend
    // tests. Here assert provider handling of that exact ownership-failure type.
    const fault = new SnapshotJournalConnectionCleanupError(new Error('native close failed'))
    const config = jest.spyOn(f.k.client, 'acquireConnection').mockRejectedValue(fault)
    await expect(f.storage.openSnapshotJournalSource(identity, request)).rejects.toBe(fault)
    config.mockRestore()
    await expect(f.storage.openSnapshotJournalSource(identity, request)).rejects.toThrow('destruction')
    await expect(f.storage.destroy()).rejects.toBe(fault)
  } finally {
    jest.restoreAllMocks()
    await f.storage.destroy().catch(() => undefined)
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('the pinned database type is validated without changing foreground cached settings', async () => {
  const f = await fixture()
  try {
    const cached = f.storage.getSettings()
    await f.k('settings').update({ dbtype: 'MySQL' })
    await expect(f.storage.openSnapshotJournalSource(identity, request)).rejects.toThrow('generation or profile')
    expect(f.storage.getSettings()).toBe(cached)
    expect(f.storage.getSettings().dbtype).toBe('SQLite')
    expect(await f.k('snapshot_journal_receipts')).toHaveLength(0)
    await f.k('settings').update({ dbtype: 'SQLite' })
    const next = await f.storage.openSnapshotJournalSource(identity, request)
    expect(next.sourceStorage.dbtype).toBe('SQLite')
    await next.close()
  } finally {
    await f.close()
  }
})

test('a source failure and owned-provider cleanup failure remain observable together', async () => {
  const f = await fixture()
  const sourceError = new Error('Backend identity changed')
  const cleanupError = new Error('Owned provider did not close')
  const destroy = StorageKnex.prototype.destroy
  jest.spyOn(Backend, 'bindSnapshotJournalCaptureBackend').mockRejectedValue(sourceError)
  jest.spyOn(StorageKnex.prototype, 'destroy').mockImplementation(async function (this: StorageKnex) {
    await destroy.call(this)
    if (this !== f.storage) throw cleanupError
  })
  function causes(value: unknown): unknown[] {
    return [
      value,
      ...(value instanceof AggregateError ? value.errors.flatMap(causes) : []),
      ...(value instanceof Error && value.cause !== undefined ? causes(value.cause) : [])
    ]
  }
  try {
    const error = await f.storage.openSnapshotJournalSource(identity, request).catch(value => value)
    expect(error).toBeInstanceOf(SnapshotJournalConnectionCleanupError)
    expect(causes(error)).toEqual(expect.arrayContaining([sourceError, cleanupError]))
    await expect(f.storage.awaitSnapshotJournalCaptureCleanup()).rejects.toBe(error)
    await expect(f.storage.openSnapshotJournalSource(identity, request)).rejects.toThrow('destruction')
    await expect(f.storage.destroy()).rejects.toBe(error)
  } finally {
    jest.restoreAllMocks()
    await f.storage.destroy().catch(() => undefined)
    await rm(f.directory, { recursive: true, force: true })
  }
})
