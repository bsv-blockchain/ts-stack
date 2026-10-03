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
import * as Connections from './SnapshotJournalConnections'
import type { SnapshotJournalCaptureRequest, SnapshotJournalSource } from './SnapshotJournalCapture'
import * as Capture from './SnapshotJournalCapture'
import * as Closure from '../archive/KnexSnapshotArchiveClosure'
import * as Backend from './SnapshotJournalCaptureBackend'
import * as Receipts from './SnapshotJournalReceipt'
import { snapshotArchiveTables } from '../archive/KnexSnapshotArchiveStore'
import { WERR_INVALID_PARAMETER } from '../../../sdk/WERR_errors'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'
import * as Archive from '../archive/KnexSnapshotArchiveSource'
import * as MysqlGeneration from './SnapshotJournalMysqlGeneration'
import * as Fence from './SnapshotJournalCaptureFence'
import * as ArchiveSql from '../archive/SnapshotArchiveSql'
import { createHash } from 'node:crypto'
import { Duplex } from 'node:stream'

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
    const detach = jest.spyOn(f.k, 'off')
    await f.storage.destroy()
    for (const event of ['query', 'query-response', 'query-error'])
      expect(detach).toHaveBeenCalledWith(event, expect.any(Function))
    expect(view.isOpen).toBe(false)
    await view.closed
    await expect(view.readPage('txLabels')).rejects.toThrow('closed')
    await expect(f.storage.openSnapshotJournalSource(identity, request)).rejects.toThrow('destruction')
  } finally {
    await f.close()
  }
})

test('destruction fences a pending source configuration callback before database access', async () => {
  const f = await fixture(),
    entered = gate(),
    release = gate(),
    retain = Capture.retainSnapshotJournalCapture,
    acquire = jest.spyOn(f.k.client, 'acquireConnection')
  let refused: unknown
  jest.spyOn(Capture, 'retainSnapshotJournalCapture').mockImplementation((chain, configure, ...rest) =>
    retain(
      chain,
      async () => {
        entered.resolve()
        await release.promise
        try {
          return await configure()
        } catch (error) {
          refused = error
          throw error
        }
      },
      ...rest
    )
  )
  try {
    const opening = f.storage.openSnapshotJournalSource(identity, request),
      outcome = opening.then(
        value => ({ value }),
        error => ({ error })
      )
    await entered.promise
    const destruction = f.storage.destroy().then(
      value => ({ value }),
      error => ({ error })
    )
    release.resolve()
    const destroyed = await destruction
    expect(refused).toMatchObject({ message: 'Snapshot journal sources are unavailable after destruction begins' })
    expect(destroyed).toHaveProperty('error', refused)
    expect(await outcome).toHaveProperty('error')
    expect(acquire).not.toHaveBeenCalled()
  } finally {
    release.resolve()
    jest.restoreAllMocks()
    await f.close()
  }
})

test('public input is detached before asynchronous setup and invalid input does not reserve admission', async () => {
  const f = await fixture()
  try {
    await expect(f.storage.awaitSnapshotJournalCaptureCleanup()).resolves.toBeUndefined()
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
    await expect(f.storage.awaitSnapshotJournalCaptureCleanup()).rejects.toBe(fault)
    await expect(f.storage.awaitSnapshotJournalCaptureCleanup()).rejects.toBe(fault)
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

test.each(['02' + 'ab'.repeat(32) + 'x', 'x02' + 'ab'.repeat(32), '04' + 'ab'.repeat(32), '', undefined, 1])(
  'invalid compressed identity %p refuses synchronously before configuration',
  identityKey => {
    const configure = jest.fn(async () => undefined)
    expect(() => Capture.retainSnapshotJournalCapture('test', configure, identityKey as string, request)).toThrow(
      WERR_INVALID_PARAMETER
    )
    expect(() => Capture.retainSnapshotJournalCapture('test', configure, identityKey as string, request)).toThrow(
      'identityKey'
    )
    expect(configure).not.toHaveBeenCalled()
  }
)

test('zero revision ceiling refuses synchronously before configuration', () => {
  const configure = jest.fn(async () => undefined)
  expect(() =>
    Capture.retainSnapshotJournalCapture('test', configure, identity, {
      ...request,
      ceiling: snapshotJournalRevision('0')
    })
  ).toThrow('generation or profile')
  expect(configure).not.toHaveBeenCalled()
})

test('an unavailable static configuration retains its exact unsupported-provider refusal through cleanup', async () => {
  const lifetime = Capture.retainSnapshotJournalCapture('test', async () => undefined, identity, request)
  const error = await lifetime.opened.catch(value => value)
  expect(error).toMatchObject({
    name: 'WERR_NOT_IMPLEMENTED',
    message: 'Snapshot journal capture requires file-backed SQLite WAL or static MySQL'
  })
  await expect(lifetime.closed).rejects.toBe(error)
})

test.each(['disabled', 'exhausted'] as const)(
  'a native %s event clock commits refusal without a receipt or ordinary source failure',
  async state => {
    const f = await fixture()
    try {
      await f
        .k('snapshot_journal_clock')
        .update(state === 'disabled' ? { enabled: 0, reason: 'capacity-exhausted' } : { revision: request.ceiling })
      const error = await f.storage.openSnapshotJournalSource(identity, request).catch(value => value)
      expect(error).toBeInstanceOf(SnapshotResourceLimitError)
      expect(error.message).toBe('Snapshot journal event window is exhausted or disabled')
      expect(await f.k('snapshot_journal_clock').first('enabled', 'reason')).toEqual({
        enabled: 0,
        reason: 'capacity-exhausted'
      })
      expect(await f.k('snapshot_journal_receipts')).toEqual([])
      await f.k('tx_labels').where('txLabelId', 1).update({ label: 'ordinary write after exhausted capture' })
      expect((await f.k('tx_labels').where('txLabelId', 1).first()).label).toBe(
        'ordinary write after exhausted capture'
      )
    } finally {
      await f.close()
    }
  }
)

test('a mismatched generation ceiling rolls back its barrier and never publishes a receipt', async () => {
  const f = await fixture()
  try {
    const before = await f.k('snapshot_journal_clock').first()
    await expect(
      f.storage.openSnapshotJournalSource(identity, { ...request, ceiling: snapshotJournalRevision('1000001') })
    ).rejects.toThrow('generation or profile')
    expect(await f.k('snapshot_journal_clock').first()).toEqual(before)
    expect(await f.k('snapshot_journal_receipts')).toEqual([])
  } finally {
    await f.close()
  }
})

test.each(['identity', 'chain'] as const)(
  'a pinned %s header mismatch refuses before receipt publication',
  async field => {
    const f = await fixture(),
      read = Archive.readKnexSnapshotArchiveHeader
    jest.spyOn(Archive, 'readKnexSnapshotArchiveHeader').mockImplementation(async (...args) => {
      const result = await read(...args)
      if (field === 'identity') result.header.user.identityKey = '03' + '22'.repeat(32)
      else result.header.sourceStorage.chain = 'main'
      return result
    })
    try {
      await expect(f.storage.openSnapshotJournalSource(identity, request)).rejects.toThrow('generation or profile')
      expect(await f.k('snapshot_journal_receipts')).toEqual([])
    } finally {
      jest.restoreAllMocks()
      await f.close()
    }
  }
)

test('a receipt failure and both actual transaction rollback failures retain all original causes after native drain', async () => {
  const f = await fixture(),
    connect = Connections.withSnapshotJournalConnections
  const sourceError = new Error('receipt failed'),
    rollbackErrors = [new Error('writer rollback failed'), new Error('reader rollback failed')]
  jest.spyOn(Receipts, 'recordSnapshotJournalReceipt').mockRejectedValue(sourceError)
  jest.spyOn(Connections, 'withSnapshotJournalConnections').mockImplementation(async (...args) => {
    for (const [index, owner] of [args[0], args[1]].entries()) {
      const transaction = owner.transaction.bind(owner)
      Object.defineProperty(owner, 'transaction', {
        ...Object.getOwnPropertyDescriptor(owner, 'transaction'),
        writable: true
      })
      jest.spyOn(owner, 'transaction').mockImplementation(async (...parameters: unknown[]) => {
        const trx = await transaction(parameters[0] as Knex.TransactionConfig),
          query = trx.client.query.bind(trx.client)
        jest.spyOn(trx.client, 'query').mockImplementation(async (...queryParameters: unknown[]) => {
          const result: unknown = await query(queryParameters[0], queryParameters[1])
          if (queryParameters[1] === 'ROLLBACK') throw rollbackErrors[index]
          return result
        })
        return trx
      })
    }
    return await connect(...args)
  })
  function causes(error: unknown): unknown[] {
    return [
      error,
      ...(error instanceof AggregateError ? error.errors.flatMap(causes) : []),
      ...(error instanceof Error && error.cause !== undefined ? causes(error.cause) : [])
    ]
  }
  try {
    const error = await f.storage.openSnapshotJournalSource(identity, request).catch(value => value)
    expect(error).toBeInstanceOf(SnapshotJournalConnectionCleanupError)
    expect(causes(error)).toEqual(expect.arrayContaining([sourceError, ...rollbackErrors]))
    expect(await f.k('snapshot_journal_receipts')).toEqual([])
    await expect(f.storage.awaitSnapshotJournalCaptureCleanup()).rejects.toBe(error)
  } finally {
    jest.restoreAllMocks()
    await f.storage.destroy().catch(() => undefined)
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('successful capture followed by an actual reader rollback failure reports exactly that cleanup cause', async () => {
  const f = await fixture(),
    connect = Connections.withSnapshotJournalConnections,
    rollbackError = new Error('successful source reader rollback failed')
  jest.spyOn(Connections, 'withSnapshotJournalConnections').mockImplementation(async (...args) => {
    const reader = args[1],
      transaction = reader.transaction.bind(reader)
    Object.defineProperty(reader, 'transaction', {
      ...Object.getOwnPropertyDescriptor(reader, 'transaction'),
      writable: true
    })
    jest.spyOn(reader, 'transaction').mockImplementation(async (...parameters: unknown[]) => {
      const trx = await transaction(parameters[0] as Knex.TransactionConfig),
        query = trx.client.query.bind(trx.client)
      jest.spyOn(trx.client, 'query').mockImplementation(async (...queryParameters: unknown[]) => {
        const result: unknown = await query(queryParameters[0], queryParameters[1])
        if (queryParameters[1] === 'ROLLBACK') throw rollbackError
        return result
      })
      return trx
    })
    return await connect(...args)
  })
  const lifetime = Capture.retainSnapshotJournalCapture('test', async () => f.k.client.config, identity, request)
  try {
    const view = await lifetime.opened
    expect((await view.readPage('txLabels')).rows.length).toBeGreaterThan(0)
    const error = await lifetime.close().catch(value => value)
    expect(error).toBeInstanceOf(SnapshotJournalConnectionCleanupError)
    expect(error.cause).toMatchObject({
      message: 'Snapshot capture transactions did not drain',
      errors: [rollbackError]
    })
    await expect(lifetime.closed).rejects.toBe(error)
    expect(await f.k('snapshot_journal_receipts')).toHaveLength(1)
  } finally {
    await lifetime.close().catch(() => undefined)
    jest.restoreAllMocks()
    await f.close()
  }
})

test('successful capture followed by an owned-provider close failure reports exactly that cleanup cause', async () => {
  const f = await fixture(),
    cleanupError = new Error('successful source owned provider did not close'),
    destroy = StorageKnex.prototype.destroy
  jest.spyOn(StorageKnex.prototype, 'destroy').mockImplementation(async function (this: StorageKnex) {
    await destroy.call(this)
    if (this !== f.storage) throw cleanupError
  })
  const lifetime = Capture.retainSnapshotJournalCapture('test', async () => f.k.client.config, identity, request)
  try {
    const view = await lifetime.opened
    expect((await view.readPage('txLabels')).rows.length).toBeGreaterThan(0)
    const error = await lifetime.close().catch(value => value)
    expect(error).toBeInstanceOf(SnapshotJournalConnectionCleanupError)
    expect(error.cause).toMatchObject({
      message: 'Snapshot capture owned providers did not close',
      errors: [cleanupError]
    })
    await expect(lifetime.closed).rejects.toBe(error)
    expect(await f.k('snapshot_journal_receipts')).toHaveLength(1)
  } finally {
    await lifetime.close().catch(() => undefined)
    jest.restoreAllMocks()
    await f.close()
  }
})

test('uppercase caller identity selects the existing canonical profile and receipt key', async () => {
  const f = await fixture(),
    upper = '02' + 'AB'.repeat(32)
  try {
    await f.k('users').where('userId', 1).update({ identityKey: upper.toLowerCase() })
    const view = await f.storage.openSnapshotJournalSource(upper, request)
    try {
      expect(view.user.identityKey).toBe(upper.toLowerCase())
      expect(view.receiptBinding.identityKey).toBe(upper.toLowerCase())
    } finally {
      await view.close()
    }
  } finally {
    await f.close()
  }
})

test('MySQL capture configures both reserved pools before transactions, commits before verification and drains its pinned reader', async () => {
  // This orchestration double checks exact pool/session/transaction boundaries.
  // Native MySQL identity, isolation and thirteen-table data are separate fixtures.
  const f = await fixture()
  const header = await f.k.transaction(t => Archive.readKnexSnapshotArchiveHeader(f.storage, identity, t))
  header.header.sourceStorage.dbtype = 'MySQL'
  const sequence: string[] = [],
    pools: Knex[] = [],
    handles: Array<{ stream: Duplex }> = []
  const factory = jest.requireActual<{ knex: typeof knex }>('knex'),
    create = factory.knex
  const createSource = Archive.createKnexSnapshotArchiveSource
  jest.spyOn(factory, 'knex').mockImplementation((...args: unknown[]) => {
    const config = args[0] as Knex.Config
    expect(config.pool).toMatchObject({ min: 0, max: 1 })
    expect(config.acquireConnectionTimeout).toBe(5000)
    const role = pools.length === 0 ? 'writer' : 'reader',
      owner = create(config)
    const handle = {
      stream: new Duplex({
        read() {},
        write(_chunk, _encoding, callback) {
          callback()
        }
      })
    }
    pools.push(owner)
    handles.push(handle)
    jest.spyOn(owner.client, 'acquireConnection').mockResolvedValue(handle)
    jest.spyOn(owner.client, 'releaseConnection').mockResolvedValue(undefined)
    const destroy = owner.client.destroy.bind(owner.client)
    jest.spyOn(owner.client, 'destroy').mockImplementation(async () => {
      handle.stream.destroy()
      await destroy()
    })
    const raw = owner.client.raw.bind(owner.client)
    jest.spyOn(owner.client, 'raw').mockImplementation((...parameters: unknown[]) => {
      expect(role).toBe('reader')
      expect(parameters).toEqual(['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY'])
      sequence.push('reader session')
      const query = raw('SELECT 1')
      query.connection = jest.fn().mockImplementation(async connection => {
        expect(connection).toBe(handle)
      })
      return query
    })
    Object.defineProperty(owner, 'transaction', {
      ...Object.getOwnPropertyDescriptor(owner, 'transaction'),
      writable: true
    })
    jest.spyOn(owner, 'transaction').mockImplementation(async (...parameters: unknown[]) => {
      expect(parameters).toEqual([{ connection: handle }])
      sequence.push('begin ' + role)
      const completion = gate()
      let completed = false
      return {
        client: owner.client,
        isTransaction: true,
        isCompleted: () => completed,
        executionPromise: completion.promise,
        commit: async () => {
          expect(completed).toBe(false)
          sequence.push('commit ' + role)
          completed = true
          completion.resolve()
        },
        rollback: async () => {
          expect(completed).toBe(false)
          sequence.push('rollback ' + role)
          completed = true
          completion.resolve()
        }
      } as unknown as Knex.Transaction
    })
    return owner
  })
  jest.spyOn(Backend, 'prepareSnapshotJournalCaptureBackend').mockResolvedValue({ kind: 'mysql' })
  jest.spyOn(Backend, 'bindSnapshotJournalCaptureBackend').mockResolvedValue('b'.repeat(64))
  jest.spyOn(Fence, 'reserveSnapshotJournalCaptureFence').mockImplementation(async () => {
    sequence.push('fence')
    return snapshotJournalRevision('7')
  })
  const generation = {
    epoch: '00000000-0000-4000-8000-000000000000',
    source: 'c'.repeat(64),
    plan: 'd'.repeat(64),
    nextObject: 1,
    ceiling: request.ceiling,
    complete: true,
    enabled: true
  }
  jest
    .spyOn(MysqlGeneration, 'readSnapshotJournalMysqlGeneration')
    .mockImplementation(async (_view, ceiling, policy) => {
      expect(ceiling).toBe(request.ceiling)
      expect(policy).toEqual(request.receiptPolicy)
      sequence.push('generation')
      return generation
    })
  jest.spyOn(Archive, 'readKnexSnapshotArchiveHeader').mockImplementation(async () => {
    sequence.push('header')
    return header
  })
  jest.spyOn(ArchiveSql, 'snapshotArchiveDatabaseNow').mockResolvedValue(1000)
  jest.spyOn(Receipts, 'recordSnapshotJournalReceipt').mockImplementation(async (_barrier, binding, value) => {
    expect(binding.identityKey).toBe(identity)
    sequence.push('receipt')
    return { ...value, floor: snapshotJournalRevision('0'), binding: Receipts.snapshotJournalReceiptBinding(binding) }
  })
  jest.spyOn(Closure, 'assertKnexSnapshotArchiveClosure').mockImplementation(async () => {
    sequence.push('verify')
  })
  jest.spyOn(Archive, 'createKnexSnapshotArchiveSource').mockImplementation((storage, ...rest) => {
    expect(storage.getSettings()).toEqual(header.header.sourceStorage)
    expect(storage.getSnapshotSync()).toBeUndefined()
    return createSource(storage, ...rest)
  })
  let lifetime: Capture.SnapshotJournalCaptureLifetime | undefined
  try {
    lifetime = Capture.retainSnapshotJournalCapture(
      'test',
      async () => ({
        client: 'mysql2',
        connection: { database: 'synthetic' },
        pool: { min: 2, max: 10 },
        acquireConnectionTimeout: 50000
      }),
      identity,
      request
    )
    const view = await lifetime.opened
    expect(sequence).toEqual([
      'reader session',
      'begin writer',
      'fence',
      'begin reader',
      'generation',
      'header',
      'receipt',
      'commit writer',
      'verify'
    ])
    expect(view.receipt).toMatchObject({ highWater: '7', expiresAt: 601000 })
    expect(view.receiptBinding.schema).toBe(
      createHash('sha256').update('snapshot-journal-schema-v1\n').update(header.header.sourceSchema).digest('hex')
    )
    await lifetime.close()
    expect(sequence.at(-1)).toBe('rollback reader')
    expect(handles).toHaveLength(2)
    expect(handles.every(handle => handle.stream.closed)).toBe(true)
  } finally {
    await lifetime?.close().catch(() => undefined)
    jest.restoreAllMocks()
    await Promise.allSettled(pools.map(owner => owner.destroy()))
    await f.close()
  }
})
