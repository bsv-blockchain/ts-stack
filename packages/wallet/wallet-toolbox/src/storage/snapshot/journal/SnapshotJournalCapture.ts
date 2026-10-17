import { isOwnedNativeSqlite } from '../../schema/ownedNativeSqliteRuntimeNode'
import { createOwnedNativeReadDatabase, ownedNativeRootIdentity } from '../../schema/ownedNativeSqliteConnectionsNode'
import type { SnapshotJournalReconciliationSource } from './SnapshotJournalProvider'
import type { SnapshotJournalDeltaPage, SnapshotJournalPosition } from './SnapshotJournalTypes'
export type {
  SnapshotJournalSource,
  SnapshotJournalDeltaRequest,
  SnapshotJournalReconciliationSource
} from './SnapshotJournalProvider'
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
  type KnexSnapshotArchiveHeader
} from '../archive/KnexSnapshotArchiveSource'
import { assertKnexSnapshotArchiveClosure } from '../archive/KnexSnapshotArchiveClosure'
import { snapshotArchiveDatabaseNow } from '../archive/SnapshotArchiveSql'
import {
  snapshotJournalReceiptPolicy,
  recordSnapshotJournalReceipt,
  readSnapshotJournalReceipt,
  type SnapshotJournalReceiptPolicy,
  type SnapshotJournalReceipt,
  type SnapshotJournalReceiptBinding
} from './SnapshotJournalReceipt'
import { snapshotJournalRevision, type SnapshotJournalRevision } from './SnapshotJournalRevision'
import { readSnapshotJournalDeltaPage, snapshotJournalPhysicalMember } from './SnapshotJournalDeltaPage'
import { readSnapshotJournalMetadataPage, type SnapshotJournalInterval } from './SnapshotJournalPage'
import { encodeSnapshotJournalDeltaFrame } from './SnapshotJournalDeltaFrame'
import { readSnapshotJournalRowSourceIdentities } from './SnapshotJournalRowReferences'
import { readSnapshotJournalSqliteGeneration } from './SnapshotJournalSqliteGeneration'
import { readSnapshotJournalMysqlGeneration } from './SnapshotJournalMysqlGeneration'
import { reserveSnapshotJournalCaptureFence } from './SnapshotJournalCaptureFence'
import { withSnapshotJournalPrimaryCommitFence } from './SnapshotJournalPrimaryCommitFence'
import {
  withSnapshotJournalCurrentDataFence,
  type SnapshotJournalCurrentDataResult
} from './SnapshotJournalCurrentDataFence'
import { compareSnapshotJournalRevisions } from './SnapshotJournalRevision'
import { withSnapshotJournalConnections, SnapshotJournalConnectionCleanupError } from './SnapshotJournalConnections'
import {
  prepareSnapshotJournalCaptureBackend,
  prepareSnapshotJournalSqliteWriter,
  bindSnapshotJournalCaptureBackend,
  closeSnapshotJournalCapturePool
} from './SnapshotJournalCaptureBackend'

export interface SnapshotJournalCaptureRequest {
  ceiling: SnapshotJournalRevision
  receiptPolicy: SnapshotJournalReceiptPolicy
}
export interface SnapshotJournalCaptureLifetime {
  opened: Promise<SnapshotJournalReconciliationSource>
  closed: Promise<void>
  close: () => Promise<void>
}
interface Captured {
  header: KnexSnapshotArchiveHeader
  receipt: SnapshotJournalReceipt
  binding: SnapshotJournalReceiptBinding
  primary: { activeStorage: string | null; epoch: SnapshotJournalRevision }
  verifyLive: () => Promise<void>
  withCommitFence: <T>(commit: () => Promise<T>) => Promise<T>
  withCurrentDataFence: <T>(
    since: SnapshotJournalRevision,
    commit: () => Promise<T>
  ) => Promise<SnapshotJournalCurrentDataResult<T>>
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
async function endTransactions(transactions: Knex.Transaction[], failure?: { error: unknown }): Promise<void> {
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
        [...(failure === undefined ? [] : [failure.error]), ...failed.map(result => result.reason)],
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
  if (reader.client.config.client === 'better-sqlite3' || isOwnedNativeSqlite(reader)) {
    await prepareSnapshotJournalSqliteWriter(writer, write)
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
  releaseWriter?: () => Promise<void>
}
async function capture(options: CaptureOptions): Promise<void> {
  const { storage, writer, write, read, backend, identityKey, request, assertActive, hold } = options
  const reader = storage.knex,
    transactions: Knex.Transaction[] = []
  let failure: { error: unknown } | undefined
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
      reader.client.config.client === 'better-sqlite3' || isOwnedNativeSqlite(reader)
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
      header.header.sourceStorage.dbtype !==
        (reader.client.config.client === 'better-sqlite3' || isOwnedNativeSqlite(reader) ? 'SQLite' : 'MySQL')
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
    const primaryRows: Array<{ epoch: unknown }> = await view('snapshot_sync_primary_epochs')
      .where('userId', binding.userId)
      .select(
        view.raw(
          reader.client.config.client === 'better-sqlite3' || isOwnedNativeSqlite(reader)
            ? 'CAST(epoch AS TEXT) AS epoch'
            : 'CAST(epoch AS CHAR) AS epoch'
        )
      )
      .limit(2)
    if (primaryRows.length > 1) return invalid()
    const primary = {
      activeStorage: header.header.user.activeStorage ?? null,
      epoch: snapshotJournalRevision(primaryRows[0]?.epoch ?? '0')
    }
    assertActive()
    const receipt = await recordSnapshotJournalReceipt(barrier, binding, {
      requestId: randomBytes(32).toString('hex'),
      highWater,
      expiresAt: (await snapshotArchiveDatabaseNow(barrier)) + request.receiptPolicy.receiptLifetimeMs
    })
    assertActive()
    await commit(barrier)
    await options.releaseWriter?.()
    assertActive()
    // Keep only source data and the owned verifier, never a reusable verdict.
    // A fresh transaction on the reserved writer connection sees current
    // generation/receipt/expiry after the long-lived reader was pinned.
    const verifyCurrent = async (current: Knex.Transaction): Promise<void> => {
      const actual =
        reader.client.config.client === 'better-sqlite3' || isOwnedNativeSqlite(reader)
          ? await readSnapshotJournalSqliteGeneration(current, request.receiptPolicy, reader.client.config.migrations)
          : await readSnapshotJournalMysqlGeneration(
              current,
              request.ceiling,
              request.receiptPolicy,
              reader.client.config.migrations
            )
      if (
        !actual.complete ||
        !actual.enabled ||
        actual.epoch !== binding.epoch ||
        actual.source !== binding.source ||
        actual.ceiling !== request.ceiling
      )
        return invalid()
      const currentHeader = await readKnexSnapshotArchiveHeader(storage, identityKey, current)
      const epochs: Array<{ epoch: unknown }> = await current('snapshot_sync_primary_epochs')
        .where('userId', binding.userId)
        .select(
          current.raw(
            reader.client.config.client === 'better-sqlite3' || isOwnedNativeSqlite(reader)
              ? 'CAST(epoch AS TEXT) AS epoch'
              : 'CAST(epoch AS CHAR) AS epoch'
          )
        )
        .limit(2)
      if (
        epochs.length > 1 ||
        snapshotJournalRevision(epochs[0]?.epoch ?? '0') !== primary.epoch ||
        (currentHeader.header.user.activeStorage ?? null) !== primary.activeStorage ||
        currentHeader.header.user.userId !== binding.userId ||
        currentHeader.header.user.identityKey.toLowerCase() !== binding.identityKey ||
        currentHeader.header.sourceStorage.storageIdentityKey !== binding.storageIdentity ||
        currentHeader.header.sourceStorage.chain !== binding.chain ||
        createHash('sha256')
          .update('snapshot-journal-schema-v1\n')
          .update(currentHeader.header.sourceSchema)
          .digest('hex') !== binding.schema ||
        JSON.stringify(await readSnapshotJournalReceipt(current, binding, receipt)) !== JSON.stringify(receipt)
      )
        return invalid()
      assertActive()
    }
    let currentBusy = false
    const withCurrent = async <T>(apply: (current: Knex.Transaction) => Promise<T>): Promise<T> => {
      if (currentBusy) return invalid()
      currentBusy = true
      let current: Knex.Transaction | undefined, currentConnection: unknown
      let outcome: { value: T } | { cause: unknown }
      try {
        assertActive()
        const expected = await prepareSnapshotJournalCaptureBackend(writer.client.config, writer)
        // The retained reader does not monopolize the finite foreground writer.
        currentConnection = options.releaseWriter === undefined ? write : await writer.client.acquireConnection()
        assertActive()
        if ((await bindSnapshotJournalCaptureBackend(writer, currentConnection, reader, read, expected)) !== backend)
          invalid()
        current = await begin(writer, currentConnection, transactions)
        outcome = { value: await apply(current) }
      } catch (cause) {
        outcome = { cause }
      }
      const cleanupFailures: unknown[] = []
      try {
        if (current !== undefined) {
          await current.rollback()
          await current.executionPromise
          const index = transactions.indexOf(current)
          if (index >= 0) transactions.splice(index, 1)
        }
      } catch (cause) {
        cleanupFailures.push(cause)
      }
      let releaseFailed = false
      if (options.releaseWriter !== undefined && currentConnection !== undefined) {
        try {
          await writer.client.releaseConnection(currentConnection)
        } catch (cause) {
          releaseFailed = true
          cleanupFailures.push(cause)
        }
      }
      // A failed physical release keeps admission fenced, as before.
      if (!releaseFailed) currentBusy = false
      if (cleanupFailures.length !== 0) {
        const causes = [...('cause' in outcome ? [outcome.cause] : []), ...cleanupFailures]
        throw new SnapshotJournalConnectionCleanupError(
          causes.length === 1
            ? causes[0]
            : new AggregateError(causes, 'Current snapshot check and physical cleanup failed')
        )
      }
      if ('cause' in outcome) throw outcome.cause
      return outcome.value
    }
    const verifyLive = async (): Promise<void> => {
      await withCurrent(verifyCurrent)
      assertActive()
    }
    const withCommitFence = async <T>(operation: () => Promise<T>): Promise<T> => {
      const result = await withCurrent(
        async current =>
          await withSnapshotJournalPrimaryCommitFence(
            current,
            binding.userId,
            async () => await verifyCurrent(current),
            operation
          )
      )
      assertActive()
      return result
    }
    const withCurrentDataFence = async <T>(
      since: SnapshotJournalRevision,
      operation: () => Promise<T>
    ): Promise<SnapshotJournalCurrentDataResult<T>> => {
      snapshotJournalRevision(since)
      if (compareSnapshotJournalRevisions(since, receipt.highWater) > 0) return invalid()
      if (compareSnapshotJournalRevisions(since, receipt.floor) < 0) return { current: false }
      const result = await withCurrent(
        async current =>
          await withSnapshotJournalCurrentDataFence(
            current,
            binding.userId,
            since,
            request.ceiling,
            async () => await verifyCurrent(current),
            operation
          )
      )
      assertActive()
      return result
    }
    await hold(view, { header, receipt, binding, primary, verifyLive, withCommitFence, withCurrentDataFence })
  } catch (error) {
    failure = { error }
    throw error
  } finally {
    await endTransactions(transactions, failure)
  }
}

/** Internal owned capture. The provider keeps its admission until closed settles.
 * This does not register a journal migration or advertise incremental sync. */
export function retainSnapshotJournalCapture(
  chain: Chain,
  resolveConfig: () => Promise<Knex.Config | undefined>,
  identity: string,
  input: SnapshotJournalCaptureRequest,
  options: RetainedReadSnapshotOptions = {},
  actualNativeRoot?: Knex
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
      let writer: Knex | undefined,
        borrowedWriter = false,
        failure: { error: unknown } | undefined
      try {
        const config = await resolveConfig()
        assertActive()
        if (config === undefined)
          throw new WERR_NOT_IMPLEMENTED('Snapshot journal capture requires file-backed SQLite WAL or static MySQL')
        const expected = await prepareSnapshotJournalCaptureBackend(config, actualNativeRoot)
        assertActive()
        if (actualNativeRoot !== undefined && isOwnedNativeSqlite(actualNativeRoot)) {
          if (ownedNativeRootIdentity(actualNativeRoot)?.slot !== 0) return invalid()
          writer = actualNativeRoot
          borrowedWriter = true
        } else writer = createKnex(ownedConfig(config))
        storage = new StorageKnex({
          ...StorageProvider.createStorageBaseOptions(chain),
          snapshotSync: false,
          knex: borrowedWriter ? createOwnedNativeReadDatabase(writer) : createKnex(ownedConfig(config))
        })
        await withSnapshotJournalConnections(
          writer,
          storage.knex,
          assertActive,
          async (write, read, releaseWriter) => {
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
              releaseWriter: borrowedWriter ? releaseWriter : undefined,
              hold: async (trx, value) => {
                captured = value
                await hold(trx)
              }
            })
          },
          async (owner, connection) => {
            if (borrowedWriter && owner === writer) await owner.client.releaseConnection(connection)
            else await closeSnapshotJournalCapturePool(owner, connection)
          }
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
      const settled = await Promise.allSettled([borrowedWriter ? undefined : writer?.destroy(), storage?.destroy()])
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
    const owned = captured
    let reading = false
    let identityWriter = false
    const source: SnapshotJournalReconciliationSource = {
      ...createKnexSnapshotArchiveSource(storage, view, captured.header),
      get isOpen() {
        return view.isOpen
      },
      receipt: { ...captured.receipt },
      receiptBinding: { ...captured.binding },
      primary: { ...captured.primary },
      hasChangesSince: async since => {
        snapshotJournalRevision(since)
        if (!view.isOpen || reading || compareSnapshotJournalRevisions(since, owned.receipt.highWater) > 0)
          return invalid()
        if (compareSnapshotJournalRevisions(since, owned.receipt.floor) < 0) return true
        reading = true
        try {
          const streams = [
            ...Array.from({ length: 13 }, (_, tableId) => ({ stream: 'scope' as const, tableId })),
            { stream: 'physical' as const, tableId: 8 },
            { stream: 'physical' as const, tableId: 9 }
          ]
          for (const stream of streams) {
            let after: SnapshotJournalPosition | undefined
            for (;;) {
              const result = await view.read(async token => {
                await owned.verifyLive()
                const trx = storage!.toDb(token)
                const interval: SnapshotJournalInterval = {
                  ...stream,
                  userId: owned.binding.userId,
                  floor: owned.receipt.floor,
                  low: since,
                  high: owned.receipt.highWater,
                  after,
                  limit: 256
                }
                const page = await readSnapshotJournalMetadataPage(trx, interval)
                if (stream.stream === 'scope') return { page, changed: page.rows.length !== 0 }
                for (const row of page.rows) {
                  if (
                    await snapshotJournalPhysicalMember(
                      trx,
                      interval,
                      row,
                      ['mysql', 'mysql2'].includes(String(trx.client.config.client))
                    )
                  )
                    return { page, changed: true }
                }
                return { page, changed: false }
              })
              if (result.changed) return true
              if (result.page.complete) break
              if (result.page.after === undefined) return invalid()
              after = result.page.after
              await new Promise<void>(resolve => setTimeout(resolve, 0))
            }
          }
          return false
        } finally {
          reading = false
        }
      },
      withCurrentDataFence: async (since, commit) => {
        if (!view.isOpen || reading || typeof commit !== 'function') return invalid()
        reading = true
        try {
          return await view.read(async () => await owned.withCurrentDataFence(since, commit))
        } finally {
          reading = false
        }
      },
      withCommitFence: async commit => {
        if (!view.isOpen || typeof commit !== 'function') return invalid()
        // Identity prefixes are awaited by the already-owned readDeltaPage
        // flight. All other fences register their complete destination flight
        // with the retained view, so expiry cannot release source locks while
        // a destination transaction is still physically closing.
        if (reading) {
          if (!identityWriter) return invalid()
          return await owned.withCommitFence(commit)
        }
        reading = true
        try {
          return await view.read(async () => await owned.withCommitFence(commit))
        } finally {
          reading = false
        }
      },
      verifyLive: async () => {
        if (reading) return invalid()
        reading = true
        try {
          await view.read(async () => {
            await owned.verifyLive()
          })
        } finally {
          reading = false
        }
      },
      readDeltaPage: async (input, captureIdentities) => {
        if (reading || typeof captureIdentities !== 'function') return invalid()
        const request = { ...input, ...(input.after === undefined ? {} : { after: { ...input.after } }) }
        if (request.bootstrap !== undefined && request.bootstrap !== true) return invalid()
        reading = true
        try {
          return await view.read(async token => {
            await owned.verifyLive()
            const trx = storage!.toDb(token)
            const header = await readKnexSnapshotArchiveHeader(storage!, identityKey, trx)
            const indexes = {
              profile: header.profileIndexes,
              relation: header.relationIndexes,
              certificate: header.certificateIndexes,
              global: header.globalIndexes
            }
            // The full physical scans cover both shared global tables with
            // current profile membership. Replaying their older scope events
            // in a full scan would mislabel current payloads with old revisions.
            const fullGlobalScope =
              request.bootstrap === true &&
              request.stream === 'scope' &&
              (request.tableId === 8 || request.tableId === 9)
            const page: SnapshotJournalDeltaPage = fullGlobalScope
              ? {
                  table: request.tableId === 8 ? 'provenTxs' : 'provenTxReqs',
                  changes: [],
                  examined: 0,
                  payloadBytes: 0,
                  complete: true
                }
              : await readSnapshotJournalDeltaPage(
                  trx,
                  {
                    ...(request.bootstrap === true ? { bootstrap: true as const } : {}),
                    stream: request.stream,
                    tableId: request.tableId,
                    userId: owned.binding.userId,
                    floor: owned.receipt.floor,
                    low: snapshotJournalRevision(request.low),
                    high: owned.receipt.highWater,
                    after: request.after,
                    limit: request.maximumRows
                  },
                  request.maximumBytes,
                  indexes
                )
            const frame = encodeSnapshotJournalDeltaFrame(page, { stream: request.stream, tableId: request.tableId })
            const frameDigest = createHash('sha256').update(frame).digest('hex')
            // Provenance stays in its staged raw frame; it is not promoted.
            if (request.tableId !== 7) {
              for (let index = 0; index < page.changes.length; index++) {
                for await (const identities of readSnapshotJournalRowSourceIdentities(
                  trx,
                  owned.binding.userId,
                  owned.receipt.highWater,
                  request.tableId,
                  page.changes[index],
                  indexes
                )) {
                  if (!view.isOpen) return invalid()
                  identityWriter = true
                  try {
                    await captureIdentities(frameDigest, index, identities)
                  } finally {
                    identityWriter = false
                  }
                }
              }
            }
            await owned.verifyLive()
            return { page, frameDigest }
          })
        } finally {
          reading = false
        }
      }
    }
    return source
  })
  void opened.catch(() => undefined)
  return { opened, closed: lifetime.closed, close: lifetime.close }
}
