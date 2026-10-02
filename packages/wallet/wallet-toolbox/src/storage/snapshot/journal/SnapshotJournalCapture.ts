import { createHash, randomBytes } from 'node:crypto'
import { knex as createKnex, type Knex } from 'knex'
import { StorageKnex } from '../../StorageKnex'
import { StorageProvider } from '../../StorageProvider'
import type { Chain } from '../../../sdk/types'
import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER, WERR_NOT_IMPLEMENTED } from '../../../sdk/WERR_errors'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'
import { retainReadSnapshot, type RetainedReadSnapshotOptions } from '../RetainedReadSnapshot'
import {
  readKnexSnapshotArchiveHeader,
  createKnexSnapshotArchiveSource,
  type KnexSnapshotArchiveHeader,
  type SnapshotArchiveSource
} from '../archive/KnexSnapshotArchiveSource'
import { assertKnexSnapshotArchiveClosure } from '../archive/KnexSnapshotArchiveClosure'
import { snapshotArchiveDatabaseNow } from '../archive/SnapshotArchiveSql'
import {
  snapshotJournalReceiptPolicy,
  recordSnapshotJournalReceipt,
  type SnapshotJournalReceiptPolicy,
  type SnapshotJournalReceipt,
  type SnapshotJournalReceiptBinding
} from './SnapshotJournalReceipt'
import { snapshotJournalRevision, type SnapshotJournalRevision } from './SnapshotJournalRevision'
import { readSnapshotJournalSqliteGeneration } from './SnapshotJournalSqliteGeneration'
import { readSnapshotJournalMysqlGeneration } from './SnapshotJournalMysqlGeneration'
import { reserveSnapshotJournalCaptureFence } from './SnapshotJournalCaptureFence'
import { withSnapshotJournalConnections, SnapshotJournalConnectionCleanupError } from './SnapshotJournalConnections'
import {
  prepareSnapshotJournalCaptureBackend,
  bindSnapshotJournalCaptureBackend,
  closeSnapshotJournalCapturePool
} from './SnapshotJournalCaptureBackend'

export interface SnapshotJournalCaptureRequest {
  ceiling: SnapshotJournalRevision
  receiptPolicy: SnapshotJournalReceiptPolicy
}
export interface SnapshotJournalSource extends SnapshotArchiveSource {
  readonly receipt: SnapshotJournalReceipt
  readonly receiptBinding: SnapshotJournalReceiptBinding
}
export interface SnapshotJournalCaptureLifetime {
  opened: Promise<SnapshotJournalSource>
  closed: Promise<void>
  close: () => Promise<void>
}
interface Captured {
  header: KnexSnapshotArchiveHeader
  receipt: SnapshotJournalReceipt
  binding: SnapshotJournalReceiptBinding
}

function invalid(): never {
  throw new WERR_INVALID_OPERATION('Snapshot journal capture generation or profile is unavailable')
}
function ownedConfig(config: Knex.Config): Knex.Config {
  const connection = config.connection as object
  return {
    ...config,
    connection: Object.create(Object.getPrototypeOf(connection), Object.getOwnPropertyDescriptors(connection)),
    pool: { ...config.pool, min: 0, max: 1 },
    acquireConnectionTimeout: Math.min(config.acquireConnectionTimeout ?? 5000, 5000)
  }
}
async function endTransactions(transactions: Knex.Transaction[]): Promise<void> {
  const settled = await Promise.allSettled(
    transactions.map(async trx => {
      if (!trx.isCompleted()) {
        await trx.rollback()
        await trx.executionPromise
      }
    })
  )
  const failed = settled.filter(result => result.status === 'rejected')
  if (failed.length)
    throw new SnapshotJournalConnectionCleanupError(
      new AggregateError(
        failed.map(result => result.reason),
        'Snapshot capture transactions did not drain'
      )
    )
}
async function begin(k: Knex, connection: unknown, transactions: Knex.Transaction[]): Promise<Knex.Transaction> {
  const trx = await k.transaction({ connection })
  void trx.executionPromise.catch(() => undefined)
  transactions.push(trx)
  return trx
}
async function commit(trx: Knex.Transaction): Promise<void> {
  // Knex's commit query can resolve after a SQL error while executionPromise
  // rejects. Both must settle successfully before a receipt authorizes a view.
  await trx.commit()
  await trx.executionPromise
}
async function prepareReader(writer: Knex, write: unknown, reader: Knex, read: unknown): Promise<void> {
  if (reader.client.config.client === 'better-sqlite3') {
    await writer.raw('PRAGMA busy_timeout = 0').connection(write)
    await reader.raw('PRAGMA query_only = ON').connection(read)
  } else {
    await reader.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY').connection(read)
  }
}
interface CaptureOptions {
  storage: StorageKnex
  writer: Knex
  write: unknown
  read: unknown
  backend: string
  identityKey: string
  request: SnapshotJournalCaptureRequest
  assertActive: () => void
  hold: (trx: Knex.Transaction, captured: Captured) => Promise<void>
}
async function capture(options: CaptureOptions): Promise<void> {
  const { storage, writer, write, read, backend, identityKey, request, assertActive, hold } = options
  const reader = storage.knex,
    transactions: Knex.Transaction[] = []
  try {
    await prepareReader(writer, write, reader, read)
    assertActive()
    const barrier = await begin(writer, write, transactions)
    assertActive()
    const highWater = await reserveSnapshotJournalCaptureFence(barrier)
    if (highWater === undefined) {
      await commit(barrier)
      throw new SnapshotResourceLimitError('Snapshot journal event window is exhausted or disabled')
    }
    assertActive()
    const view = await begin(reader, read, transactions)
    assertActive()
    const generation =
      reader.client.config.client === 'better-sqlite3'
        ? await readSnapshotJournalSqliteGeneration(view, request.receiptPolicy, reader.client.config.migrations)
        : await readSnapshotJournalMysqlGeneration(
            view,
            request.ceiling,
            request.receiptPolicy,
            reader.client.config.migrations
          )
    if (!generation.complete || !generation.enabled || generation.ceiling !== request.ceiling) return invalid()
    assertActive()
    const header = await readKnexSnapshotArchiveHeader(storage, identityKey, view)
    if (
      header.header.user.identityKey.toLowerCase() !== identityKey ||
      header.header.sourceStorage.chain !== storage.chain ||
      header.header.sourceStorage.dbtype !== (reader.client.config.client === 'better-sqlite3' ? 'SQLite' : 'MySQL')
    )
      return invalid()
    // This private provider belongs only to this pinned read view. Page size
    // preflight needs its database type; never initialize it from a live query
    // or change the foreground provider's cached settings.
    storage._settings = { ...header.header.sourceStorage }
    const binding: SnapshotJournalReceiptBinding = {
      backend,
      epoch: generation.epoch,
      source: generation.source,
      schema: createHash('sha256')
        .update('snapshot-journal-schema-v1\n')
        .update(header.header.sourceSchema)
        .digest('hex'),
      storageIdentity: header.header.sourceStorage.storageIdentityKey,
      identityKey,
      userId: header.header.user.userId,
      chain: storage.chain
    }
    assertActive()
    const receipt = await recordSnapshotJournalReceipt(barrier, binding, {
      requestId: randomBytes(32).toString('hex'),
      highWater,
      expiresAt: (await snapshotArchiveDatabaseNow(barrier)) + request.receiptPolicy.receiptLifetimeMs
    })
    assertActive()
    await commit(barrier)
    assertActive()
    await hold(view, { header, receipt, binding })
  } finally {
    await endTransactions(transactions)
  }
}

/** Internal owned capture. The provider keeps its admission until closed settles.
 * This does not register a journal migration or advertise incremental sync. */
export function retainSnapshotJournalCapture(
  chain: Chain,
  resolveConfig: () => Promise<Knex.Config | undefined>,
  identity: string,
  input: SnapshotJournalCaptureRequest,
  options: RetainedReadSnapshotOptions = {}
): SnapshotJournalCaptureLifetime {
  if (typeof identity !== 'string' || !/^(02|03)[0-9a-fA-F]{64}$/.test(identity))
    throw new WERR_INVALID_PARAMETER('identityKey', 'a compressed public identity key')
  const identityKey = identity.toLowerCase()
  const request = {
    ceiling: snapshotJournalRevision(input.ceiling),
    receiptPolicy: snapshotJournalReceiptPolicy(input.receiptPolicy)
  }
  if (request.ceiling === '0') return invalid()
  let storage: StorageKnex | undefined, captured: Captured | undefined
  const lifetime = retainReadSnapshot(
    async (hold, assertActive) => {
      let writer: Knex | undefined, failure: { error: unknown } | undefined
      try {
        const config = await resolveConfig()
        assertActive()
        if (config === undefined)
          throw new WERR_NOT_IMPLEMENTED('Snapshot journal capture requires file-backed SQLite WAL or static MySQL')
        const expected = await prepareSnapshotJournalCaptureBackend(config)
        assertActive()
        writer = createKnex(ownedConfig(config))
        storage = new StorageKnex({
          ...StorageProvider.createStorageBaseOptions(chain),
          snapshotSync: false,
          knex: createKnex(ownedConfig(config))
        })
        await withSnapshotJournalConnections(
          writer,
          storage.knex,
          assertActive,
          async (write, read) => {
            const backend = await bindSnapshotJournalCaptureBackend(writer!, write, storage!.knex, read, expected)
            assertActive()
            await capture({
              storage: storage!,
              writer: writer!,
              write,
              read,
              backend,
              identityKey,
              request,
              assertActive,
              hold: async (trx, value) => {
                captured = value
                await hold(trx)
              }
            })
          },
          closeSnapshotJournalCapturePool
        )
      } catch (error) {
        // Cancellation rejects opening promptly, but physical cleanup still
        // controls closed/admission. Preserve unrelated source failures too.
        let cancelled = false
        try {
          assertActive()
        } catch (error_) {
          cancelled = error_ === error
        }
        if (!cancelled) failure = { error }
      }
      const settled = await Promise.allSettled([writer?.destroy(), storage?.destroy()])
      const failed = settled.filter(result => result.status === 'rejected')
      if (failed.length)
        throw new SnapshotJournalConnectionCleanupError(
          new AggregateError(
            [...(failure === undefined ? [] : [failure.error]), ...failed.map(result => result.reason)],
            'Snapshot capture owned providers did not close'
          )
        )
      if (failure !== undefined) throw failure.error
    },
    async trx => {
      if (storage === undefined || captured === undefined) return invalid()
      const h = captured.header
      // Closure verification uses the pinned reader after the writer barrier has
      // committed, so foreground writers can progress throughout this work.
      await assertKnexSnapshotArchiveClosure(
        storage.toDb(trx),
        h.header.user.userId,
        h.profileIndexes,
        h.relationIndexes,
        h.certificateIndexes,
        h.globalIndexes
      )
    },
    { ...options }
  )
  const opened = lifetime.opened.then(view => {
    if (storage === undefined || captured === undefined || !view.isOpen) return invalid()
    return {
      ...createKnexSnapshotArchiveSource(storage, view, captured.header),
      get isOpen() {
        return view.isOpen
      },
      receipt: { ...captured.receipt },
      receiptBinding: { ...captured.binding }
    }
  })
  void opened.catch(() => undefined)
  return { opened, closed: lifetime.closed, close: lifetime.close }
}
