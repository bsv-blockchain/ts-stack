import { PRIMARY_HANDOFF_MIGRATION, dropPrimaryHandoffForDataDeletion } from './schema/primaryHandoffMigration'
import { KnexWalletWriteAdmission } from './KnexWalletWriteAdmission'
import { parseSnapshotJournalDataCheckpoint } from './snapshot/journal/SnapshotJournalDataProtocol'
import {
  assertKnexPrimaryDataWrite,
  primarySelectionFromKnexSync,
  hasKnexPrimaryEnrollment
} from './KnexPrimaryHandoffAdmission'
import { createKnexPrimaryHandoffControl } from './KnexPrimaryHandoffControl'
import type { PrimaryHandoffControl, PrimaryHandoffControlOptions } from './PrimaryHandoffControl'
import { SNAPSHOT_SYNC_MIGRATION, verifySnapshotSyncPrimaryFence } from './schema/snapshotSyncMigration'
import { captureKnexActiveWrite } from './KnexActiveWriteFence'
import type { StorageActiveWrite, StorageStatusReviewArgs, StorageWriterAdmission } from './StorageActiveWrite'
import {
  parseSnapshotJournalFieldArchiveReference,
  type SnapshotJournalFieldArchiveReference
} from './snapshot/journal/SnapshotJournalReceiptData'
import { KnexSnapshotJournalDataContentReceipts } from './snapshot/journal/KnexSnapshotJournalDataContentReceipts'
import { KnexSnapshotJournalDataDestination } from './snapshot/journal/KnexSnapshotJournalDataDestination'
import type {
  SnapshotJournalFieldOptions,
  SnapshotJournalFieldReadOptions,
  SnapshotJournalFieldStatus,
  SnapshotJournalDataOptions
} from './snapshot/journal/SnapshotJournalDataProvider'
import type { SnapshotJournalDataStatus } from './snapshot/journal/SnapshotJournalDataProtocol'
import type { SnapshotJournalArchiveBinding } from './snapshot/journal/SnapshotJournalArchiveBinding'
import { journalCopyLimits } from './snapshot/journal/SnapshotJournalCopyLimits'
import {
  parseSnapshotSyncContentPosition,
  parseSnapshotSyncContentRevision,
  type SnapshotSyncContentPosition
} from './snapshot/SnapshotSyncContentRevision'
import { closeSnapshotJournalSource } from './snapshot/journal/closeSnapshotJournalSource'
import { forSnapshotSqlDialect, SNAPSHOT_JOURNAL_FIELD_CACHE_MIGRATION } from './schema/snapshotSqlMigration'
import {
  withBrc38NativeLocalPackedWalletMutation,
  withBrc38NativeLocalPackedWalletTransaction,
  prepareBrc38NativeLocalPackedWalletWrite,
  finishBrc38NativeLocalPackedWalletWrite,
  releaseBrc38NativeLocalPackedWalletWrite,
  hydrateBrc38NativeLocalPackedWalletRows,
  brc38NativeLocalPackedWalletLength,
  applyBrc38NativeLocalPackedTextWhere,
  type Brc38NativeLocalPackedWalletTable
} from './portable/Brc38NativeLocalPackedWalletNode'
import { applyBrc38NativeManagedChangeText } from './portable/Brc38NativeManagedChangeTextNode'
import { brc38NativePackedLength, collectBrc38NativePackedGarbage } from './portable/Brc38NativePackedFieldsNode'
import {
  withBrc38NativePackedWalletTransaction,
  hydrateBrc38NativePackedWalletRows,
  prepareBrc38NativePackedWalletWrite,
  finishBrc38NativePackedWalletWrite,
  matchesBrc38NativePackedWalletBytes,
  readBrc38NativePackedWalletRawSlice,
  isBrc38NativePackedWalletTable,
  type Brc38NativePackedWalletTable
} from './portable/Brc38NativePackedWalletNode'
import { isOwnedNativeSqlite } from './schema/ownedNativeSqliteRuntimeNode'
import { hasBrc38NativePackedTextSchema } from './portable/Brc38NativePackedTextSchemaNode'
import { collectBrc38NativePackedContent } from './portable/Brc38NativePackedTextFieldsNode'
import {
  prepareBrc38NativePackedTextWalletWrite,
  finishBrc38NativePackedTextWalletWrite,
  hydrateBrc38NativePackedTextWalletRows,
  prechargeBrc38NativePackedTextWalletRows,
  prechargeBrc38NativePackedTextWalletWrite,
  applyBrc38NativePackedTextWhere,
  isBrc38NativePackedTextWalletTable,
  brc38NativePackedTextWalletFields,
  type Brc38NativePackedTextWalletTable
} from './portable/Brc38NativePackedTextWalletNode'
import {
  createOwnedNativeReadDatabase,
  ownedNativeRootIdentity,
  nativeOwnedRootCloseState
} from './schema/ownedNativeSqliteConnectionsNode'
import {
  assertPreparedPackedNativeSnapshotField,
  type PreparedPackedNativeSnapshotField
} from './snapshot/preparePackedNativeSnapshotFieldNode'
import {
  SnapshotJournalAutomaticRetention,
  snapshotJournalAutomaticRetentionPolicy,
  type SnapshotJournalAutomaticRetentionPolicy
} from './snapshot/journal/SnapshotJournalAutomaticRetention'
import { readSnapshotJournalMaintenanceConfiguration } from './snapshot/journal/SnapshotJournalLifecycle'
import { knexDatabaseSystem } from './schema/knexDatabaseSystem'
import {
  maintainSnapshotJournal as startSnapshotJournalMaintenance,
  type SnapshotJournalMaintenanceRequest,
  type SnapshotJournalMaintenanceResult
} from './snapshot/journal/SnapshotJournalMaintenance'
import type {
  SnapshotJournalMaintenanceTask,
  SnapshotJournalMaintenanceOptions
} from './snapshot/journal/SnapshotJournalMaintenanceTask'
import {
  retainSnapshotJournalCapture,
  type SnapshotJournalCaptureRequest,
  type SnapshotJournalCaptureLifetime,
  type SnapshotJournalReconciliationSource
} from './snapshot/journal/SnapshotJournalCapture'
import { SnapshotJournalConnectionCleanupError } from './snapshot/journal/SnapshotJournalConnections'
import { withSnapshotJournalOwnedWriter } from './snapshot/journal/SnapshotJournalOwnedWriter'
import {
  KnexSnapshotJournalDestination,
  type SnapshotJournalDestinationLimits,
  type SnapshotJournalWriterAdmission
} from './snapshot/journal/KnexSnapshotJournalDestination'
import type { SnapshotJournalRevision } from './snapshot/journal/SnapshotJournalRevision'
import type { SnapshotJournalDestinationCheckpoint } from './snapshot/journal/SnapshotJournalDestinationWindow'
import {
  dropSnapshotJournalSourceForDataDeletion,
  readSnapshotJournalCaptureConfiguration,
  SNAPSHOT_JOURNAL_SOURCE_MIGRATION
} from './snapshot/journal/SnapshotJournalLifecycle'
import {
  dropSnapshotJournalDestinationForDataDeletion,
  SNAPSHOT_JOURNAL_DESTINATION_MIGRATION,
  verifySnapshotJournalDestinationSchema
} from './snapshot/journal/SnapshotJournalDestinationSchema'
import { dropGenerationForDataDeletion } from './schema/snapshotSqliteIndexMigration'
import { assertSnapshotJournalOrdinaryDataDeletion } from './snapshot/journal/SnapshotJournalNativeDestinationSchema'
import { migration as SNAPSHOT_SQLITE_INDEX_MIGRATION } from './schema/snapshotSqliteIndexState'
import { SnapshotResourceLimitError } from './snapshot/SnapshotResourceLimitError'
import { readGuardedSnapshotArchive, recoverSnapshotArchiveGuards } from './snapshot/archive/SnapshotArchiveGuard'
import type { SnapshotArchiveRequestOwner } from './snapshot/archive/SnapshotArchiveRequest'
import { SnapshotCancelledError } from './snapshot/SnapshotCancelledError'
import type { SnapshotSyncStorage, SnapshotSyncCheckpoint, SnapshotSyncTable } from './snapshot/SnapshotSync'
import { KnexSnapshotSyncDestination } from './snapshot/KnexSnapshotSyncDestination'
import type {
  WalletReadSnapshot,
  WalletReadSnapshotOptions,
  WalletSnapshotFieldMetadataPage
} from './snapshot/WalletReadSnapshot'
import { openKnexWalletReadSnapshot } from './snapshot/KnexWalletReadSnapshot'
import {
  openKnexSnapshotArchiveSource,
  SnapshotArchiveSourceCleanupError,
  type SnapshotArchiveSource
} from './snapshot/archive/KnexSnapshotArchiveSource'
import {
  retainReadSnapshot,
  type RetainedReadSnapshot,
  type RetainedReadSnapshotLifetime,
  type RetainedReadSnapshotOptions
} from './snapshot/RetainedReadSnapshot'
import { recoveredProofUpdate } from './methods/validateSyncProof'
import {
  type ValidListActionsArgs,
  type ValidListOutputsArgs,
  validateInternalizeActionArgs
} from '@bsv/sdk/wallet/validationHelpers'
import { InternalizeActionArgs, ListActionsResult, ListOutputsResult, TelemetrySpan } from '@bsv/sdk'
import {
  outputColumnsWithoutLockingScript,
  TableCertificate,
  TableCertificateField,
  TableCertificateX,
  TableCommission,
  TableMonitorEvent,
  TableOutput,
  TableOutputBasket,
  TableOutputTag,
  TableOutputTagMap,
  TableProvenTx,
  TableProvenTxReq,
  TableSettings,
  TableSyncState,
  TableTransaction,
  TableTxLabel,
  TableTxLabelMap,
  TableUser,
  transactionColumnsWithoutRawTx
} from './schema/tables'
import { TableActionBatch, TableActionBatchBlob, TableActionBatchOutput } from './schema/tables/TableActionBatch'
import { TablePreparedBeef } from './schema/tables/TablePreparedBeef.interfaces'
import { KnexMigrations } from './schema/KnexMigrations'
import { knex as createKnex, Knex } from 'knex'
import { AdminStatsResult, StorageProvider, StorageProviderOptions } from './StorageProvider'
import { purgeData } from './methods/purgeData'
import { listActions } from './methods/listActionsKnex'
import { listOutputs } from './methods/listOutputsKnex'
import { DBType } from './StorageReader'
import { reviewStatus } from './methods/reviewStatus'
import { ServicesCallHistory, WalletServices } from '../sdk/WalletServices.interfaces'
import {
  AuthId,
  StorageInternalizeActionResult,
  FindCertificateFieldsArgs,
  FindCertificatesArgs,
  FindCommissionsArgs,
  FindForUserSincePagedArgs,
  FindMonitorEventsArgs,
  FindOutputBasketsArgs,
  FindOutputsArgs,
  FindOutputTagMapsArgs,
  FindOutputTagsArgs,
  FindPartialSincePagedArgs,
  FindProvenTxReqsArgs,
  FindProvenTxsArgs,
  FindStaleMerkleRootsArgs,
  FindSyncStatesArgs,
  FindTransactionsArgs,
  FindTxLabelMapsArgs,
  FindTxLabelsArgs,
  FindUsersArgs,
  ProvenOrRawTx,
  PurgeParams,
  PurgeResults,
  TrxToken,
  RequestSyncChunkArgs,
  SyncChunkTotals,
  WalletStorageProvider
} from '../sdk/WalletStorage.interfaces'
import {
  WERR_INTERNAL,
  WERR_INVALID_OPERATION,
  WERR_INVALID_PARAMETER,
  WERR_NOT_IMPLEMENTED,
  WERR_UNAUTHORIZED
} from '../sdk/WERR_errors'
import { randomBytesBase64, verifyId, verifyOne, verifyOneOrNone } from '../utility/utilityHelpers'
import { canonicalizeAtomicBeef } from '../utility/canonicalizeAtomicBeef'
import { internalizeAction, type InternalizeReceiptClaim } from './methods/internalizeAction'

import { EntityTimeStamp, TransactionStatus } from '../sdk/types'
import { managedChangeOutputFields } from './methods/managedChange'
import type { ManagedChangeInputCandidate } from './methods/availableManagedChange'
import {
  PreparedBeefCoordinator,
  PreparedBeefLookupResult,
  PreparedBeefOptions,
  PreparedBeefPolicy,
  PreparedBeefPreparation,
  PreparedBeefRoot,
  PREPARED_BEEF_FORMAT_VERSION,
  lookupPreparedBeefs,
  validatePreparedBeefPolicy
} from './methods/preparedBeef'
import type { Brc177NoSendExpiryState } from '../utility/brc177NoSendExpiry'

export interface StorageKnexOptions extends StorageProviderOptions {
  /**
   * Knex database interface initialized with valid connection configuration.
   */
  knex: Knex
  /** Optional prepared-BEEF (COOK) rollout controls. Disabled by default. */
  preparedBeef?: PreparedBeefOptions
  /** Default true. False keeps legacy sync scheduling while retaining the additive schema for forward rollback. */
  snapshotSync?: boolean
  /** Bounded automatic receipt/floor/tombstone upkeep before ordinary journal
   * capture. False requires caller-owned maintenance; no physical quota follows. */
  snapshotJournalRetention?: false | SnapshotJournalAutomaticRetentionPolicy
}

// Keep bulk statements below conservative SQLite/MySQL bind-parameter
// ceilings. The surrounding transaction still makes a complete pack atomic.
const ACTION_BATCH_BLOB_SQL_CHUNK = 500
const OUTPUT_INSERT_SQL_CHUNK = 500

// Only provider-owned snapshot callbacks can classify a transaction as a read
// view. Keep this private and shared across providers that use the same token.
const readSnapshotTransactions = new WeakSet<TrxToken>()

async function withinReadSnapshot<T>(trx: TrxToken, read: (trx: TrxToken) => Promise<T>): Promise<T> {
  const alreadyTracked = readSnapshotTransactions.has(trx)
  readSnapshotTransactions.add(trx)
  try {
    return await read(trx)
  } finally {
    if (!alreadyTracked) readSnapshotTransactions.delete(trx)
  }
}

interface KnexTelemetryQuery {
  __knexQueryUid?: string
  method?: string
}

interface PreparedBeefMetadata {
  preparedBeefMetadataId: number
  proofEpoch: number
}

export class StorageKnex extends StorageProvider implements WalletStorageProvider {
  knex: Knex
  private snapshotSyncEnabled: boolean
  private readonly snapshotSyncTelemetry: StorageKnexOptions['telemetry']
  private snapshotSyncSource?: StorageKnex
  private snapshotSyncOpening?: Promise<WalletReadSnapshot | undefined>
  private snapshotSyncBusy = false
  private snapshotJournalCapture?: SnapshotJournalCaptureLifetime
  private snapshotJournalCaptureFailure?: SnapshotJournalConnectionCleanupError
  private snapshotJournalMaintenance?: SnapshotJournalMaintenanceTask<SnapshotJournalMaintenanceResult>
  private snapshotJournalMaintenanceFailure?: SnapshotJournalConnectionCleanupError
  private snapshotArchiveRecovery?: Promise<void>
  private localJournalFieldArchives?: import('./snapshot/archive/KnexSnapshotArchiveRpc').KnexSnapshotArchiveRpc
  private readonly localJournalFieldArchiveOpenings = new Set<Promise<unknown>>()
  private readonly localJournalFieldArchiveReaders = new Set<
    import('./snapshot/journal/openRemoteSnapshotJournalFieldArchive').RemoteSnapshotJournalFieldArchive
  >()
  private guardedSnapshotFailure?: { error: unknown }
  private retainedReadSnapshot?: RetainedReadSnapshotLifetime
  private retainedReadSnapshotsStopped = false
  private snapshotDataDeletionRunning = false
  private readonly snapshotJournalWriters = new Set<Promise<unknown>>()
  private snapshotJournalWriterFailure?: SnapshotJournalConnectionCleanupError

  private get snapshotAdmissionStopped(): boolean {
    return this.retainedReadSnapshotsStopped || this.snapshotDataDeletionRunning
  }
  readonly preparedBeefPolicy: PreparedBeefPolicy
  private readonly preparedBeefCoordinator: PreparedBeefCoordinator
  private readonly preparedBeefReadSuspensions = new Set<number>()
  private nextPreparedBeefReadSuspension = 0
  private readonly querySpans = new Map<string, TelemetrySpan>()
  private readonly onQuery = (query: KnexTelemetryQuery): void => {
    if (!this.telemetry.enabled || query.__knexQueryUid == null) return
    const span = this.telemetry.startSpan('wallet.storage.db.query', {
      component: 'wallet-storage-knex',
      kind: 'client',
      attributes: {
        'db.system': this.databaseSystem(),
        'db.operation': query.method ?? 'unknown'
      }
    })
    this.querySpans.set(query.__knexQueryUid, span)
  }

  private readonly onQueryResponse = (_response: unknown, query: KnexTelemetryQuery): void => {
    this.endQuerySpan(query)
  }

  private readonly onQueryError = (error: unknown, query: KnexTelemetryQuery): void => {
    this.endQuerySpan(query, error)
  }

  private readonly snapshotJournalRetentionPolicy: Readonly<SnapshotJournalAutomaticRetentionPolicy> | false
  private readonly snapshotJournalAutomaticRetention = new SnapshotJournalAutomaticRetention()
  private snapshotJournalRetentionFlight?: { promise: Promise<void>; controller: AbortController }

  constructor(options: StorageKnexOptions) {
    super(options)
    if (options.knex == null) throw new WERR_INVALID_PARAMETER('options.knex', 'valid')
    this.knex = options.knex
    this.snapshotJournalRetentionPolicy = snapshotJournalAutomaticRetentionPolicy(options.snapshotJournalRetention)
    parsePostgresInt8AsNumber(this.knex)
    this.snapshotSyncEnabled = options.snapshotSync ?? true
    this.snapshotSyncTelemetry = options.telemetry
    if (typeof this.snapshotSyncEnabled !== 'boolean') throw new WERR_INVALID_PARAMETER('snapshotSync', 'a boolean')
    this.preparedBeefPolicy = validatePreparedBeefPolicy(options.preparedBeef)
    this.preparedBeefCoordinator = new PreparedBeefCoordinator(this)
    if (this.telemetry.enabled) {
      this.knex.on('query', this.onQuery)
      this.knex.on('query-response', this.onQueryResponse)
      this.knex.on('query-error', this.onQueryError)
    }
  }

  private receiptClockMs(): Knex.Raw<number> {
    switch (this.dbtype) {
      case 'MySQL':
        return this.knex.raw('CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000 AS UNSIGNED)')
      case 'Postgres':
        return this.knex.raw('CAST(EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS BIGINT)')
      case 'SQLite':
        return this.knex.raw("CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)")
      default:
        throw new WERR_INTERNAL('wallet receipt claim requires a ready SQL storage provider')
    }
  }

  private receiptLeaseMs(): Knex.Raw<number> {
    return this.knex.raw('(? + ?)', [this.receiptClockMs(), 120_000])
  }

  private async acquireInternalizeReceipt(
    userId: number,
    txid: string
  ): Promise<{
    ownerToken: string
    claim: InternalizeReceiptClaim
    preserveComplete: boolean
  }> {
    const ownerToken = randomBytesBase64(18)
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      await this.knex('internalize_receipts')
        .insert({
          userId,
          txid,
          ownerToken,
          state: 'pending',
          leaseUntil: this.receiptLeaseMs(),
          needsNewReceipt: false
        })
        .onConflict(['userId', 'txid'])
        .ignore()

      const previous = await this.knex('internalize_receipts')
        .where({ userId, txid })
        .first<{ ownerToken: string; state: string; needsNewReceipt: boolean }>(
          'ownerToken',
          'state',
          'needsNewReceipt'
        )
      if (previous == null) continue

      const retryNew = Boolean(previous.needsNewReceipt)
      const preserveComplete = previous.state === 'complete'
      if (previous.ownerToken !== ownerToken) {
        const changed = await this.knex('internalize_receipts')
          .where({ userId, txid, ownerToken: previous.ownerToken })
          .where(builder =>
            builder.whereIn('state', ['retryable', 'complete']).orWhere('leaseUntil', '<=', this.receiptClockMs())
          )
          .update({ ownerToken, state: 'pending', leaseUntil: this.receiptLeaseMs() })
        if (changed !== 1) {
          await new Promise(resolve => setTimeout(resolve, 100))
          continue
        }
      }

      const activeRow = (trx: TrxToken) => {
        const query = (trx as Knex.Transaction)('internalize_receipts')
          .where({ userId, txid, ownerToken, state: 'pending' })
          .where('leaseUntil', '>', this.receiptClockMs())
        return this.dbtype === 'SQLite' ? query : query.forUpdate()
      }
      const claim: InternalizeReceiptClaim = {
        retryNew,
        assertActive: async trx => {
          const active = await activeRow(trx).first('ownerToken')
          if (active == null) throw new WERR_INTERNAL('wallet receipt claim expired or was superseded')
        },
        markNew: async trx => {
          const changed = await activeRow(trx).update({ needsNewReceipt: true })
          if (changed !== 1) throw new WERR_INTERNAL('wallet receipt claim expired or was superseded')
        },
        complete: async trx => {
          const changed = await activeRow(trx).update({
            state: 'complete',
            needsNewReceipt: false,
            leaseUntil: 0
          })
          if (changed !== 1) throw new WERR_INTERNAL('wallet receipt claim expired or was superseded')
        }
      }
      return { ownerToken, claim, preserveComplete }
    }
    throw new WERR_INTERNAL('wallet receipt is already being processed; retry after the active request finishes')
  }

  override async internalizeAction(auth: AuthId, args: InternalizeActionArgs): Promise<StorageInternalizeActionResult> {
    validateInternalizeActionArgs(args)
    const userId = auth.userId
    if (userId == null) throw new WERR_UNAUTHORIZED()
    const write = await this.activeWriteTransaction(auth)
    const txid = canonicalizeAtomicBeef(args.tx).atomicTxid
    if (txid == null) throw new WERR_INVALID_PARAMETER('tx', 'an AtomicBEEF transaction')
    const { ownerToken, claim, preserveComplete } = await this.acquireInternalizeReceipt(userId, txid)
    try {
      return await internalizeAction(this, auth, args, claim, write)
    } finally {
      // A successful writer marked its claim complete in the same transaction
      // as the output records. Preserve that durable key across later merges;
      // release an uncompleted key only when no new receipt header was marked.
      const noNewReceipt = this.knex('internalize_receipts').where({
        userId,
        txid,
        ownerToken,
        state: 'pending',
        needsNewReceipt: false
      })
      if (preserveComplete) await noNewReceipt.update({ state: 'complete', leaseUntil: 0 })
      else await noNewReceipt.delete()
      await this.knex('internalize_receipts')
        .where({ userId, txid, ownerToken, state: 'pending', needsNewReceipt: true })
        .update({ state: 'retryable', leaseUntil: 0 })
    }
  }

  private databaseSystem(): string {
    return knexDatabaseSystem(this.knex.client)
  }

  private endQuerySpan(query: KnexTelemetryQuery, error?: unknown): void {
    if (query.__knexQueryUid == null) return
    const span = this.querySpans.get(query.__knexQueryUid)
    if (span == null) return
    this.querySpans.delete(query.__knexQueryUid)
    span.end(error == null ? {} : { status: 'error', error })
  }

  protected override supportsActionBatchPersistence(): boolean {
    return true
  }

  protected override supportsStorageAccessScheduling(): boolean {
    return true
  }

  override supportsReadSnapshot(): boolean {
    return this.databaseSystem() === 'sqlite' || this.databaseSystem() === 'mysql'
  }

  override async readSnapshot<T>(read: (trx: TrxToken) => Promise<T>): Promise<T> {
    await this.makeAvailable()
    const database = this.databaseSystem()
    if (database === 'sqlite') {
      // SQLite establishes its read view on the first query. Do not request
      // Knex's unsupported SQLite isolation/readOnly options or write settings
      // into the shared connection. WAL writers may use another connection.
      return await this.knex.transaction(trx => withinReadSnapshot(trx, read))
    }
    if (database === 'mysql') {
      return await this.readMySQLSnapshot(trx => withinReadSnapshot(trx, read))
    }
    throw new WERR_NOT_IMPLEMENTED('Coherent wallet source snapshots require SQLite or MySQL isolation')
  }

  override supportsRetainedReadSnapshot(): boolean {
    return this.supportsReadSnapshot()
  }

  /** One retained local transaction per provider; it occupies one pool connection until physical cleanup. */
  override async openReadSnapshot(options: RetainedReadSnapshotOptions = {}): Promise<RetainedReadSnapshot> {
    return await this.openTrackedReadSnapshot(options, read => this.readSnapshot(read))
  }

  private async openTrackedReadSnapshot(
    options: RetainedReadSnapshotOptions,
    transaction: (read: (trx: TrxToken) => Promise<void>) => Promise<void>
  ): Promise<RetainedReadSnapshot> {
    if (this.snapshotAdmissionStopped) {
      throw new WERR_INVALID_OPERATION('Retained read snapshots are unavailable after provider destruction begins')
    }
    if (!this.supportsRetainedReadSnapshot()) return await super.openReadSnapshot(options)
    if (this.retainedReadSnapshot !== undefined) {
      throw new WERR_INVALID_OPERATION('This provider already has a retained read snapshot opening or active')
    }
    const lifetime = retainReadSnapshot(
      read => transaction(trx => withinReadSnapshot(trx, read)),
      async trx => {
        // Pin SQLite's deferred read view before opening resolves. MySQL also
        // establishes its repeatable-read snapshot on this first data read.
        await this.readSettings(trx)
      },
      options
    )
    this.retainedReadSnapshot = lifetime
    const release = (): void => {
      if (this.retainedReadSnapshot === lifetime) this.retainedReadSnapshot = undefined
    }
    void lifetime.closed.then(release, release)
    return await lifetime.opened
  }

  private async stopRetainedReadSnapshots(permanent = true): Promise<void> {
    // Fence admission before any asynchronous cleanup can yield. A view whose
    // close releases the capacity slot must not permit reopening during destroy.
    if (permanent) this.retainedReadSnapshotsStopped = true
    // Capture owned lifetimes before cleanup yields. A rejected opening may
    // release its admission slot while earlier dependencies are draining.
    const capture = this.snapshotJournalCapture,
      maintenance = this.snapshotJournalMaintenance,
      retained = this.retainedReadSnapshot
    const failures: unknown[] = []
    const drain = async (work: () => Promise<unknown>): Promise<void> => {
      try {
        await work()
      } catch (cause) {
        failures.push(cause)
      }
    }
    // Every dependency drains in ownership order even if an earlier one fails.
    // Retain all actual causes instead of overwriting them in nested finally.
    await drain(async () => await this.stopAutomaticSnapshotJournalRetention())
    await drain(async () => await this.snapshotArchiveRecovery)
    await Promise.allSettled(this.localJournalFieldArchiveOpenings)
    for (const archive of this.localJournalFieldArchiveReaders)
      await drain(async () => {
        await archive.close()
        await archive.closed
      })
    await drain(async () => await this.localJournalFieldArchives?.close())
    await drain(async () => await capture?.close())
    await drain(async () => await maintenance?.close())
    await this.snapshotSyncOpening?.catch(() => undefined)
    await drain(async () => await this.snapshotSyncSource?.destroy())
    await drain(async () => await retained?.close())
    await Promise.allSettled(this.snapshotJournalWriters)
    if (this.snapshotJournalWriterFailure !== undefined && !failures.includes(this.snapshotJournalWriterFailure))
      failures.push(this.snapshotJournalWriterFailure)
    if (failures.length === 1) throw failures[0]
    if (failures.length !== 0)
      throw new AggregateError(failures, 'Retained snapshot dependencies did not physically drain', {
        cause: failures[0]
      })
  }

  /** Internal writer after actual manager/authenticated provider admission.
   * The complete task includes native physical cleanup, so data erasure and
   * destruction cannot overtake a destination writer that is still closing. */
  runSnapshotJournalWriter<T>(
    apply: (trx: Knex, backend: string) => Promise<T>,
    expectedBackend?: string,
    signal?: AbortSignal
  ): Promise<T> {
    const assertActive = () => {
      signal?.throwIfAborted()
      if (this.snapshotAdmissionStopped)
        throw new WERR_INVALID_OPERATION(
          'Journal destination writers are unavailable during destruction or data erasure'
        )
    }
    assertActive()
    const task = Promise.resolve()
      .then(
        async () =>
          await withSnapshotJournalOwnedWriter(this.knex.client.config, assertActive, apply, expectedBackend, this.knex)
      )
      .catch((error: unknown) => {
        if (error instanceof SnapshotJournalConnectionCleanupError) {
          this.snapshotJournalWriterFailure = error
          this.retainedReadSnapshotsStopped = true
        }
        throw error
      })
      .finally(() => {
        this.snapshotJournalWriters.delete(task)
      })
    this.snapshotJournalWriters.add(task)
    return task
  }

  /** Internal receiver after actual authenticated owner/manager admission.
   * This method is deliberately absent from the RPC allowlist and capability
   * advertisement while the complete reconciliation/cutover program is built. */
  async openSnapshotJournalDestination(
    source: SnapshotJournalReconciliationSource,
    low: SnapshotJournalRevision,
    limits: SnapshotJournalDestinationLimits,
    admission: SnapshotJournalWriterAdmission,
    signal?: AbortSignal,
    bootstrap?: true,
    preferIncremental?: true
  ): Promise<{ destination: KnexSnapshotJournalDestination; checkpoint: SnapshotJournalDestinationCheckpoint }> {
    if (this.snapshotAdmissionStopped)
      throw new WERR_INVALID_OPERATION('Journal destinations are unavailable during destruction or erasure')
    return await KnexSnapshotJournalDestination.begin(
      this,
      source,
      low,
      limits,
      admission,
      signal,
      bootstrap,
      preferIncremental
    )
  }

  /** Actual SQL field source and receiver. The authenticated field RPC remains
   * a separate namespace from the original row protocol. */
  private async localJournalFieldArchiveRpc() {
    if (this.snapshotAdmissionStopped) throw new WERR_INVALID_OPERATION('Local field source admission stopped')
    const { KnexSnapshotArchiveRpc } = await import('./snapshot/archive/KnexSnapshotArchiveRpc')
    if (this.snapshotAdmissionStopped) throw new WERR_INVALID_OPERATION('Local field source admission stopped')
    return (this.localJournalFieldArchives ??= new KnexSnapshotArchiveRpc(this))
  }
  async supportsSnapshotJournalFieldArchive(): Promise<boolean> {
    return (await (await this.localJournalFieldArchiveRpc()).journalFieldCapabilities()) !== undefined
  }
  openSnapshotJournalFieldArchive(
    identityKey: string,
    position?: import('./snapshot/journal/SnapshotJournalReceiptData').SnapshotJournalArchivePosition,
    options: WalletReadSnapshotOptions = {}
  ) {
    const opening = this.openLocalSnapshotJournalFieldArchive(identityKey, position, options)
    this.localJournalFieldArchiveOpenings.add(opening)
    void opening.then(
      () => this.localJournalFieldArchiveOpenings.delete(opening),
      () => this.localJournalFieldArchiveOpenings.delete(opening)
    )
    return opening
  }
  async supportsSnapshotJournalFieldArchiveRecovery(): Promise<boolean> {
    return (await (await this.localJournalFieldArchiveRpc()).journalFieldRecoveryVersion()) === 1
  }
  resumeSnapshotJournalFieldArchive(
    identityKey: string,
    input: SnapshotJournalFieldArchiveReference,
    options: WalletReadSnapshotOptions = {}
  ) {
    const reference = parseSnapshotJournalFieldArchiveReference(input),
      opening = this.openLocalSnapshotJournalFieldArchive(identityKey, undefined, options, reference)
    this.localJournalFieldArchiveOpenings.add(opening)
    void opening.then(
      () => this.localJournalFieldArchiveOpenings.delete(opening),
      () => this.localJournalFieldArchiveOpenings.delete(opening)
    )
    return opening
  }
  async retireSnapshotJournalFieldArchive(
    identityKey: string,
    input: SnapshotJournalFieldArchiveReference
  ): Promise<void> {
    const reference = parseSnapshotJournalFieldArchiveReference(input),
      rpc = await this.localJournalFieldArchiveRpc()
    const { drainSnapshotArchiveRequest, validateSnapshotArchiveCancellation } =
      await import('./snapshot/archive/SnapshotArchiveCleanup')
    await drainSnapshotArchiveRequest(async () =>
      validateSnapshotArchiveCancellation(
        await rpc.dispatch('retireSnapshotJournalFieldArchive', [{ version: 1, identityKey, reference }], identityKey),
        reference.receipt.requestId
      )
    )
  }
  private async openLocalSnapshotJournalFieldArchive(
    identityKey: string,
    position?: import('./snapshot/journal/SnapshotJournalReceiptData').SnapshotJournalArchivePosition,
    options: WalletReadSnapshotOptions = {},
    reference?: SnapshotJournalFieldArchiveReference
  ) {
    const root = this.knex,
      rpc = await this.localJournalFieldArchiveRpc(),
      capabilities = await rpc.journalFieldCapabilities()
    if (capabilities === undefined) return undefined
    const { SnapshotJournalFieldArchiveTransport } =
        await import('./snapshot/journal/SnapshotJournalFieldArchiveTransport'),
      { openRemoteSnapshotJournalFieldArchive } =
        await import('./snapshot/journal/openRemoteSnapshotJournalFieldArchive'),
      settings = this.getSettings()
    if (this.knex !== root || this.snapshotAdmissionStopped || (settings.chain !== 'main' && settings.chain !== 'test'))
      throw new WERR_INVALID_OPERATION('Actual local field source changed')
    const transport = new SnapshotJournalFieldArchiveTransport(
      async (method, params, signal) => {
        signal?.throwIfAborted()
        if (
          this.knex !== root ||
          (this.snapshotAdmissionStopped && method !== 'cancelSnapshotJournalFieldArchiveRequest')
        )
          throw new WERR_INVALID_OPERATION('Actual local field source stopped or replaced')
        return await rpc.dispatch(method, params, identityKey)
      },
      identityKey,
      settings.storageIdentityKey,
      settings.chain,
      capabilities
    )
    const archive = await openRemoteSnapshotJournalFieldArchive(transport, position, options, reference)
    if (archive !== undefined) {
      if (this.snapshotAdmissionStopped || this.knex !== root) {
        await archive.close()
        await archive.closed
        throw new WERR_INVALID_OPERATION('Actual local field source stopped during opening')
      }
      this.localJournalFieldArchiveReaders.add(archive)
      void archive.closed.then(
        () => this.localJournalFieldArchiveReaders.delete(archive),
        () => this.localJournalFieldArchiveReaders.delete(archive)
      )
    }
    return archive
  }

  async supportsSnapshotJournalFieldSync(): Promise<boolean> {
    return await this.supportsSnapshotJournalSync()
  }
  private async resumeSnapshotJournalFieldDestination(
    identityKey: string,
    sourceStorageIdentity: string,
    options: SnapshotJournalFieldOptions
  ) {
    if (this.snapshotAdmissionStopped || options.admission === undefined)
      throw new WERR_INVALID_OPERATION('Journal field observation requires actual current manager admission')
    const { KnexSnapshotJournalFieldDestination } =
      await import('./snapshot/journal/KnexSnapshotJournalFieldDestination')
    return await KnexSnapshotJournalFieldDestination.resume(
      this,
      identityKey,
      sourceStorageIdentity,
      options.limits ?? journalCopyLimits(),
      options.admission,
      options.signal,
      true
    )
  }
  async resumeSnapshotJournalFieldWindow(
    identityKey: string,
    input: SnapshotJournalFieldArchiveReference,
    options: SnapshotJournalFieldOptions = {}
  ) {
    const reference = parseSnapshotJournalFieldArchiveReference(input)
    if (reference.source.identityKey !== identityKey)
      throw new WERR_INVALID_OPERATION('Field window recovery profile differs')
    const destination = await this.resumeSnapshotJournalFieldDestination(
      identityKey,
      reference.source.storageIdentity,
      options
    )
    if (destination === undefined) return undefined
    if (
      JSON.stringify(destination.binding.source) !== JSON.stringify(reference.source) ||
      JSON.stringify(destination.binding.receipt) !== JSON.stringify(reference.receipt)
    )
      throw new WERR_INVALID_OPERATION('Field window recovery cannot replace its original financial window')
    return destination
  }

  async getSnapshotJournalFieldStatus(
    identityKey: string,
    sourceStorageIdentity: string,
    options: SnapshotJournalFieldOptions = {}
  ): Promise<SnapshotJournalFieldStatus | undefined> {
    const destination = await this.resumeSnapshotJournalFieldDestination(identityKey, sourceStorageIdentity, options)
    return destination === undefined ? undefined : { binding: destination.binding, ...(await destination.status()) }
  }
  async getSnapshotJournalFieldContentReceipt(
    identityKey: string,
    sourceStorageIdentity: string,
    options: SnapshotJournalFieldOptions = {}
  ) {
    const destination = await this.resumeSnapshotJournalFieldDestination(identityKey, sourceStorageIdentity, options)
    return await destination?.previousContentReceipt()
  }
  async confirmSnapshotJournalFieldContentReceipt(
    identityKey: string,
    sourceStorageIdentity: string,
    revision: import('./snapshot/SnapshotSyncContentRevision').SnapshotSyncContentRevision,
    options: SnapshotJournalFieldOptions = {}
  ) {
    const destination = await this.resumeSnapshotJournalFieldDestination(identityKey, sourceStorageIdentity, options)
    return await destination?.confirmContentReceipt(revision)
  }
  async openSnapshotJournalFieldDestination(
    identityKey: string,
    source: import('./snapshot/journal/SnapshotJournalArchiveBinding').SnapshotJournalFieldArchiveBinding,
    options: SnapshotJournalFieldOptions = {}
  ) {
    if (this.snapshotAdmissionStopped || options.admission === undefined)
      throw new WERR_INVALID_OPERATION('Journal field writers require actual current manager admission')
    const { KnexSnapshotJournalFieldDestination } =
      await import('./snapshot/journal/KnexSnapshotJournalFieldDestination')
    return (
      await KnexSnapshotJournalFieldDestination.begin(
        this,
        identityKey,
        source,
        options.limits ?? journalCopyLimits(),
        options.admission,
        options.signal
      )
    ).destination
  }

  private async acknowledgedSnapshotJournalFieldRead(
    identityKey: string,
    sourceStorageIdentity: string,
    input: SnapshotJournalFieldReadOptions
  ) {
    const root = this.knex,
      limits = { ...(input.limits ?? journalCopyLimits()) },
      supplied = input.checkpoint === undefined ? undefined : parseSnapshotJournalDataCheckpoint(input.checkpoint),
      options = { ...input, checkpoint: supplied, limits, admission: input.admission, signal: input.signal },
      wanted = supplied,
      destination = await this.resumeSnapshotJournalFieldDestination(identityKey, sourceStorageIdentity, options)
    if (destination === undefined || options.admission === undefined || this.knex !== root)
      throw new WERR_INVALID_OPERATION('Acknowledged field provenance requires its actual current receiver')
    const status = await destination.status()
    if (
      status.checkpoint.phase !== 'acknowledged' ||
      (wanted !== undefined && JSON.stringify(wanted) !== JSON.stringify(status.checkpoint))
    )
      throw new WERR_INVALID_OPERATION('Field provenance checkpoint is not the actual completed window')
    return { options, root, destination, checkpoint: status.checkpoint }
  }
  async readSnapshotJournalFieldProvenance(
    identityKey: string,
    sourceStorageIdentity: string,
    input: SnapshotJournalFieldReadOptions = {}
  ): Promise<import('./snapshot/journal/SnapshotJournalDataProvider').SnapshotJournalFieldProvenanceRead> {
    const { options, root, destination, checkpoint } = await this.acknowledgedSnapshotJournalFieldRead(
        identityKey,
        sourceStorageIdentity,
        input
      ),
      admission = options.admission!,
      maximumBytes = Math.min(
        options.maximumMetadataBytes ?? 1048576,
        Math.floor((options.limits.maximumAllocationBytes - 131072) / 16)
      )
    if (maximumBytes < 1) throw new WERR_INVALID_OPERATION('Field provenance metadata allocation is too small')
    const { readSnapshotJournalFieldProvenancePage } = await import('./snapshot/journal/SnapshotJournalProvenance')
    const page = await admission(
      async () =>
        await this.runSnapshotJournalWriter(
          async (trx, backend) => {
            options.signal?.throwIfAborted()
            if (
              this.knex !== root ||
              backend !== destination.binding.destinationBackend ||
              this.snapshotAdmissionStopped
            )
              throw new WERR_INVALID_OPERATION('Field provenance target was replaced or stopped')
            await (
              await import('./snapshot/journal/SnapshotJournalDestinationSchema')
            ).verifySnapshotJournalDestinationSchema(trx)
            await (
              await import('./snapshot/journal/SnapshotJournalLifecycle')
            ).readSnapshotJournalCaptureConfiguration(trx)
            const page = await readSnapshotJournalFieldProvenancePage(
              trx,
              destination.binding,
              checkpoint,
              options.after,
              options.maximumRows ?? 32,
              maximumBytes
            )
            if (this.knex !== root) throw new WERR_INVALID_OPERATION('Field provenance target changed during its read')
            return page
          },
          destination.binding.destinationBackend,
          options.signal
        )
    )
    return { checkpoint, page }
  }
  async openSnapshotJournalProvenanceField(
    identityKey: string,
    sourceStorageIdentity: string,
    incomingId: number,
    fieldName: string,
    input: SnapshotJournalFieldReadOptions = {}
  ): Promise<import('./snapshot/journal/SnapshotJournalDataProvider').SnapshotJournalStoredFieldReader> {
    const { options, root, destination, checkpoint } = await this.acknowledgedSnapshotJournalFieldRead(
        identityKey,
        sourceStorageIdentity,
        input
      ),
      { SnapshotJournalProvenanceFieldReader } = await import('./snapshot/journal/SnapshotJournalProvenance')
    if (this.knex !== root) throw new WERR_INVALID_OPERATION('Field provenance target was replaced')
    return await SnapshotJournalProvenanceFieldReader.open(
      this,
      destination.binding,
      checkpoint,
      incomingId,
      fieldName,
      options.admission!,
      options.limits.maximumAllocationBytes,
      options.signal
    )
  }

  async supportsSnapshotJournalDataContent(): Promise<boolean> {
    return await new KnexSnapshotJournalDataContentReceipts(this).supports()
  }
  async getSnapshotJournalDataContentReceipt(
    identityKey: string,
    sourceStorageIdentity: string,
    options: SnapshotJournalDataOptions = {}
  ) {
    if (this.snapshotAdmissionStopped || options.admission === undefined)
      throw new WERR_INVALID_OPERATION('Journal DATA receipt observation requires actual admission')
    const destination = await KnexSnapshotJournalDataDestination.resume(
      this,
      identityKey,
      sourceStorageIdentity,
      journalCopyLimits(),
      options.admission
    )
    return await destination?.previousContentReceipt()
  }
  async confirmSnapshotJournalDataContentReceipt(
    identityKey: string,
    sourceStorageIdentity: string,
    revision: import('./snapshot/SnapshotSyncContentRevision').SnapshotSyncContentRevision,
    options: SnapshotJournalDataOptions = {}
  ) {
    if (this.snapshotAdmissionStopped || options.admission === undefined)
      throw new WERR_INVALID_OPERATION('Journal DATA receipt confirmation requires actual admission')
    const destination = await KnexSnapshotJournalDataDestination.resume(
      this,
      identityKey,
      sourceStorageIdentity,
      journalCopyLimits(),
      options.admission
    )
    return await destination?.confirmContentReceipt(revision)
  }
  /** Local comparison only. No primary is selected or authorized by this value;
   * the actual source fence and manager queue remain caller-owned CODE. */
  async confirmSnapshotJournalPrimaryContentReceipt(
    identityKey: string,
    sourceStorageIdentity: string,
    revision: import('./snapshot/SnapshotSyncContentRevision').SnapshotSyncContentRevision,
    activeStorage: string | null,
    options: SnapshotJournalDataOptions = {}
  ) {
    if (
      this.snapshotAdmissionStopped ||
      options.admission === undefined ||
      !(
        activeStorage === null ||
        (typeof activeStorage === 'string' &&
          Buffer.byteLength(activeStorage) > 0 &&
          Buffer.byteLength(activeStorage) <= 256)
      )
    )
      throw new WERR_INVALID_OPERATION('Primary-aware comparison requires actual local admission')
    const destination = await KnexSnapshotJournalDataDestination.resume(
      this,
      identityKey,
      sourceStorageIdentity,
      journalCopyLimits(),
      options.admission
    )
    return await destination?.confirmContentReceipt(revision, activeStorage)
  }
  async supportsSnapshotJournalDataSync(): Promise<boolean> {
    return await this.supportsSnapshotJournalSync()
  }

  async getSnapshotJournalDataStatus(
    identityKey: string,
    sourceStorageIdentity: string,
    options: SnapshotJournalDataOptions = {}
  ): Promise<SnapshotJournalDataStatus | undefined> {
    if (this.snapshotAdmissionStopped || options.admission === undefined)
      throw new WERR_INVALID_OPERATION('Journal DATA observation requires actual current manager/provider admission')
    const destination = await KnexSnapshotJournalDataDestination.resume(
      this,
      identityKey,
      sourceStorageIdentity,
      journalCopyLimits(),
      options.admission
    )
    return destination === undefined
      ? undefined
      : { version: 1, binding: destination.binding, ...(await destination.status()) }
  }

  async openSnapshotJournalDataDestination(
    identityKey: string,
    source: SnapshotJournalArchiveBinding,
    options: SnapshotJournalDataOptions = {}
  ): Promise<KnexSnapshotJournalDataDestination> {
    if (this.snapshotAdmissionStopped || options.admission === undefined)
      throw new WERR_INVALID_OPERATION('Journal DATA writers require actual current manager/provider admission')
    return (
      await KnexSnapshotJournalDataDestination.begin(
        this,
        identityKey,
        source,
        journalCopyLimits(),
        options.admission,
        options.signal
      )
    ).destination
  }

  /** Fresh local negotiation only. Absence on an older migrated store selects
   * its compatible copy path. Partial installation or changed definitions are
   * errors; they must never be disguised as an unsupported capability. */
  async supportsSnapshotJournalSync(): Promise<boolean> {
    if (this.snapshotAdmissionStopped) throw new WERR_INVALID_OPERATION('Journal admission is stopped')
    if (
      !this.snapshotSyncEnabled ||
      (!['better-sqlite3', 'mysql', 'mysql2'].includes(String(this.knex.client.config.client)) &&
        ownedNativeRootIdentity(this.knex)?.slot !== 0)
    )
      return false
    if ((await this.concurrentSnapshotReaderConfig()) === undefined) return false
    const table = this.knex.client.config.migrations?.tableName ?? 'knex_migrations'
    if (!(await this.knex.schema.hasTable(table))) return false
    const entries: Array<{ name: string }> = await this.knex(table)
      .whereIn('name', [SNAPSHOT_JOURNAL_SOURCE_MIGRATION, SNAPSHOT_JOURNAL_DESTINATION_MIGRATION])
      .select('name')
      .limit(3)
    if (entries.length === 0) return false
    if (entries.length !== 2 || new Set(entries.map(row => row.name)).size !== 2)
      throw new WERR_INVALID_OPERATION('Journal migration is incomplete')
    await readSnapshotJournalCaptureConfiguration(this.knex)
    await verifySnapshotJournalDestinationSchema(this.knex)
    return true
  }

  override supportsWalletReadSnapshot(): boolean {
    return this.supportsRetainedReadSnapshot()
  }

  override async openWalletReadSnapshot(
    identityKey: string,
    options: WalletReadSnapshotOptions = {}
  ): Promise<WalletReadSnapshot> {
    if (!this.supportsWalletReadSnapshot()) return await super.openWalletReadSnapshot(identityKey, options)
    return await openKnexWalletReadSnapshot(this, identityKey, options)
  }

  private async readMySQLSnapshot<T>(read: (trx: TrxToken) => Promise<T>): Promise<T> {
    const client = this.knex.client
    const connection = await client.acquireConnection()
    try {
      // MySQL requires a comma between transaction characteristics. Knex's
      // combined isolationLevel/readOnly options currently omit it. Reserve
      // one connection, set only its NEXT transaction, then let Knex own the
      // begin/commit/rollback lifecycle without changing pool session defaults.
      await this.knex.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY').connection(connection)
      return await this.knex.transaction(
        async trx => {
          if (trx.isCompleted()) throw new WERR_INTERNAL('MySQL snapshot transaction did not begin')
          return await read(trx)
        },
        { connection }
      )
    } catch (error) {
      // A setup/begin failure can leave pending transaction characteristics.
      // Closing before release prevents a later wallet write inheriting them.
      // Driver destroy also removes native mysql2 pooled connections; end()
      // may merely return those connections to their external pool.
      connection.destroy()
      throw error
    } finally {
      delete connection.__knexTxId
      await client.releaseConnection(connection)
    }
  }

  override getSnapshotSync(): SnapshotSyncStorage | undefined {
    if (!this.snapshotSyncEnabled || !this.supportsWalletReadSnapshot()) return undefined
    const destination = new KnexSnapshotSyncDestination(this, chunk => this.prepareSyncProofs(chunk))
    return {
      supportsDestination: () => destination.supportsDestination(),
      supportsContentDestination: () => destination.supportsContentDestination(),
      openContentSource: (identityKey, options) => this.openSnapshotSyncContentSource(identityKey, options),
      observeContentRevision: (identityKey, since, options) =>
        this.observeSnapshotSyncContentRevision(identityKey, since, options),
      previousContentReceipt: (identityKey, sourceIdentity) =>
        destination.previousContentReceipt(identityKey, sourceIdentity),
      confirmContentReceipt: (identityKey, sourceIdentity, revision) =>
        destination.confirmContentReceipt(identityKey, sourceIdentity, revision),
      beginContent: (source, activeStorage, revision, limits) =>
        destination.beginContent(source, activeStorage, revision, limits),
      openSource: (identityKey, options) =>
        this.openConcurrentSyncSource(identityKey, options ?? {}, (reader, identity, settings) =>
          reader.openWalletReadSnapshot(identity, settings)
        ),
      begin: (source, activeStorage, limits) => destination.begin(source, activeStorage, limits),
      checkpoint: (identityKey, sourceIdentity) => destination.checkpoint(identityKey, sourceIdentity),
      prepare: (checkpoint, page) => destination.prepare(checkpoint, page),
      ...(ownedNativeRootIdentity(this.knex)?.slot === 0
        ? {
            supportsFieldDestination: () => destination.supportsNativeFieldDestination(),
            prepareFields: (
              checkpoint: SnapshotSyncCheckpoint,
              page: WalletSnapshotFieldMetadataPage<SnapshotSyncTable>,
              source: WalletReadSnapshot,
              signal?: AbortSignal
            ) => destination.prepareNativeFields(checkpoint, page, source, signal),
            fieldPageLimits: destination.fieldPageLimits
          }
        : {})
    }
  }

  /** New negotiated comparison source. Maintenance has its own short bound;
   * the actual retained source keeps the caller's original copy deadline. */
  async openSnapshotSyncContentSource(
    identityKey: string,
    options: WalletReadSnapshotOptions = {},
    archiveOwner?: SnapshotArchiveRequestOwner
  ): Promise<SnapshotJournalReconciliationSource | undefined> {
    if (!(await this.supportsSnapshotJournalSync())) return undefined
    if (this.snapshotJournalRetentionPolicy !== false)
      await this.maintainCurrentSnapshotJournal({
        signal: options.signal,
        lifetimeMs: Math.min(options.lifetimeMs ?? 5000, 5000)
      })
    const configuration = await readSnapshotJournalCaptureConfiguration(this.knex)
    try {
      return await this.openSnapshotJournalSource(identityKey, configuration, options, archiveOwner)
    } catch (error) {
      await this.awaitSnapshotJournalCaptureCleanup()
      throw error
    }
  }

  /** A completed observation is DATA only. Its physical source is closed and
   * drained before the result can be returned or another source admitted. */
  async observeSnapshotSyncContentRevision(
    identityKey: string,
    input?: SnapshotSyncContentPosition,
    options: WalletReadSnapshotOptions = {}
  ) {
    const since = input === undefined ? undefined : parseSnapshotSyncContentPosition(input)
    const source = await this.openSnapshotSyncContentSource(identityKey, options)
    if (source === undefined) return undefined
    let failure: { error: unknown } | undefined
    let result: ReturnType<typeof parseSnapshotSyncContentRevision> | undefined
    try {
      if (source.readContentRevision === undefined)
        throw new WERR_INVALID_OPERATION('Actual content revision reader is unavailable')
      result = parseSnapshotSyncContentRevision(await source.readContentRevision(since))
    } catch (error) {
      failure = { error }
    }
    try {
      await closeSnapshotJournalSource(source, options.signal)
    } catch (error) {
      if (failure !== undefined && error !== failure.error)
        throw new AggregateError([failure.error, error], 'Content observation and physical cleanup failed', {
          cause: failure.error
        })
      throw error
    }
    if (failure !== undefined) throw failure.error
    return result
  }

  /** Internal original-controller transfer bridge. Absent from RPC and the
   * cross-platform provider capability; only the original SQL transfer store
   * invokes the returned callback inside its actual transaction. */
  async prepareSnapshotSyncPageInTransaction(
    checkpoint: SnapshotSyncCheckpoint,
    page: import('./snapshot/WalletReadSnapshot').WalletSnapshotPage<SnapshotSyncTable>
  ) {
    if (this.getSnapshotSync() === undefined) throw new WERR_INVALID_OPERATION('Snapshot destination is unavailable')
    return await new KnexSnapshotSyncDestination(this, chunk => this.prepareSyncProofs(chunk)).prepareInTransaction(
      checkpoint,
      page
    )
  }

  /** Internal lifecycle bridge for the actual published native profile. DELETE
   * activation keeps sync disabled. Only its durable WAL owner may enable the
   * coordinator; optional field support is still freshly probed for each page.
   * This is absent from the RPC allowlist and creates no native/profile grant. */
  async enableOwnedNativeSnapshotSync(
    profile: import('./portable/Brc38PublishedProfileNode').Brc38PublishedProfileNode,
    prepared?: import('./portable/Brc38PublishedProfileNode').Brc38PreparedNativeTarget
  ): Promise<void> {
    const root = this.knex,
      origin = ownedNativeRootIdentity(root),
      published =
        require('./portable/Brc38PublishedProfileNode') as typeof import('./portable/Brc38PublishedProfileNode')
    if (this.snapshotAdmissionStopped || origin?.slot !== 0)
      throw new WERR_INVALID_OPERATION('Native snapshot activation requires its current published writer')
    const assertProvider = async (): Promise<void> => {
      if (prepared === undefined) await published.Brc38PublishedProfileNode.assertNativeSnapshotProvider(profile, this)
      else await published.Brc38PublishedProfileNode.assertPreparedNativeSnapshotProvider(profile, this, prepared)
    }
    await assertProvider()
    const destination = new KnexSnapshotSyncDestination(this, chunk => this.prepareSyncProofs(chunk))
    if (!(await destination.supportsDestination()) || (await this.concurrentSnapshotReaderConfig()) === undefined)
      throw new WERR_INVALID_OPERATION('Native snapshot activation requires registered sync and retained WAL reads')
    // Absence is compatible with older profiles. A partial new field layout is
    // refused by this probe, rather than silently enabling the row fallback.
    await destination.supportsNativeFieldDestination()
    await assertProvider()
    if (
      this.snapshotAdmissionStopped ||
      this.knex !== root ||
      ownedNativeRootIdentity(root)?.token !== origin.token ||
      ownedNativeRootIdentity(root)?.slot !== 0
    )
      throw new WERR_INVALID_OPERATION('Native snapshot activation lost its original provider')
    this.snapshotSyncEnabled = true
  }

  /** Local capability probe; no reader pool is constructed. RPC probes opt out
   * of the native local path until its independent remote guard is supported. */
  async supportsSnapshotArchiveSource(allowOwnedNative = true): Promise<boolean> {
    if (this.snapshotAdmissionStopped) return false
    const config = await this.concurrentSnapshotReaderConfig()
    return (
      !this.snapshotAdmissionStopped &&
      config !== undefined &&
      (config.client === 'better-sqlite3' ||
        String(config.client).includes('mysql') ||
        (allowOwnedNative && ownedNativeRootIdentity(this.knex)?.slot === 0))
    )
  }

  /** Shares local sync's single owned reader slot and awaited physical cleanup. */
  async openSnapshotArchiveSource(
    identityKey: string,
    options: WalletReadSnapshotOptions = {},
    owner?: SnapshotArchiveRequestOwner
  ): Promise<SnapshotArchiveSource | undefined> {
    const claim = owner === undefined ? undefined : { ...owner }
    try {
      return await this.openConcurrentSyncSource(identityKey, options, async (reader, identity, settings) => {
        if (claim === undefined) return await openKnexSnapshotArchiveSource(reader, identity, settings)
        return await openKnexSnapshotArchiveSource(reader, identity, settings, () =>
          reader.openTrackedReadSnapshot(settings, async read => {
            try {
              await reader.makeAvailable()
              await readGuardedSnapshotArchive(this.knex, reader.knex, claim, read)
            } catch (error) {
              reader.guardedSnapshotFailure = { error }
              throw error
            }
          })
        )
      })
    } catch (error) {
      if (error instanceof SnapshotArchiveSourceCleanupError) throw error
      if (this.snapshotAdmissionStopped && this.snapshotSyncSource !== undefined)
        throw new SnapshotArchiveSourceCleanupError(error)
      throw error
    }
  }

  /** Internal complete-generation capture; no RPC or incremental capability is advertised.
   * The source shares sync/archive admission and retains it through physical cleanup.
   */
  async openSnapshotJournalSource(
    identityKey: string,
    request: SnapshotJournalCaptureRequest,
    options: RetainedReadSnapshotOptions = {},
    archiveOwner?: SnapshotArchiveRequestOwner
  ): Promise<SnapshotJournalReconciliationSource> {
    if (this.snapshotAdmissionStopped)
      throw new WERR_INVALID_OPERATION('Snapshot journal sources are unavailable after destruction begins')
    if (this.snapshotSyncBusy)
      throw new WERR_INVALID_OPERATION('This provider already has a snapshot sync source opening or active')
    this.snapshotSyncBusy = true
    let lifetime: SnapshotJournalCaptureLifetime
    try {
      lifetime = retainSnapshotJournalCapture(
        this.chain,
        async () => {
          if (this.snapshotAdmissionStopped)
            throw new WERR_INVALID_OPERATION('Snapshot journal sources are unavailable after destruction begins')
          // Preserve the explicit owned-generation capture contract. Capture
          // checks this request against actual physical/schema/policy data in
          // its coherent view; an installation stamp is not that authority.
          // Ordinary negotiated sources use openCurrentSnapshotJournalSource,
          // which independently requires the registered complete lifecycle.
          return await this.concurrentSnapshotReaderConfig()
        },
        identityKey,
        request,
        options,
        this.knex,
        archiveOwner === undefined ? undefined : { control: this.knex, owner: { ...archiveOwner } }
      )
    } catch (error) {
      this.snapshotSyncBusy = false
      throw error
    }
    this.snapshotJournalCapture = lifetime
    const release = (error?: unknown): void => {
      if (error instanceof SnapshotJournalConnectionCleanupError) {
        this.snapshotJournalCaptureFailure = error
        this.retainedReadSnapshotsStopped = true
        return
      }
      if (this.snapshotJournalCapture === lifetime) {
        this.snapshotJournalCapture = undefined
        this.snapshotSyncBusy = false
      }
    }
    void lifetime.closed.then(() => release(), release)
    return await lifetime.opened
  }

  /** Current installed policy is read afresh; capture repeats its complete
   * physical/schema/profile checks in the retained view. No capability flag or
   * cached configuration can stand in for that source admission. */
  async openCurrentSnapshotJournalSource(
    identityKey: string,
    options: RetainedReadSnapshotOptions = {}
  ): Promise<SnapshotJournalReconciliationSource> {
    if (this.snapshotJournalRetentionPolicy !== false) await this.maintainCurrentSnapshotJournal(options)
    const configuration = await readSnapshotJournalCaptureConfiguration(this.knex)
    try {
      return await this.openSnapshotJournalSource(identityKey, configuration, options)
    } catch (error) {
      await this.awaitSnapshotJournalCaptureCleanup()
      throw error
    }
  }

  /** One demand-driven finite pass; no unattended timer or retained SQL pool.
   * Source capture follows only after every maintenance owner physically drains.
   * Explicit owned-generation capture keeps its historical caller-owned policy. */
  async maintainCurrentSnapshotJournal(options: RetainedReadSnapshotOptions = {}): Promise<void> {
    if (this.snapshotJournalRetentionPolicy === false) return
    if (this.snapshotAdmissionStopped) throw new WERR_INVALID_OPERATION('Automatic journal retention is stopped')
    if (this.snapshotJournalRetentionFlight !== undefined)
      throw new WERR_INVALID_OPERATION('Automatic journal retention already owns a pass')
    const requestedLifetime = options.lifetimeMs ?? 5000,
      signal = options.signal
    if (!Number.isSafeInteger(requestedLifetime) || requestedLifetime < 1 || requestedLifetime > 30000)
      throw new WERR_INVALID_PARAMETER('lifetimeMs', 'an integer from 1 to 30000')
    const lifetimeMs = Math.min(requestedLifetime, 5000),
      expiresAt = Date.now() + lifetimeMs,
      started = performance.now()
    const controller = new AbortController(),
      policy = this.snapshotJournalRetentionPolicy
    const abort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const promise = Promise.resolve().then(async () => {
      controller.signal.throwIfAborted()
      const current = await readSnapshotJournalMaintenanceConfiguration(this.knex)
      controller.signal.throwIfAborted()
      const remaining = Math.floor(Math.min(expiresAt - Date.now(), lifetimeMs - (performance.now() - started)))
      if (remaining < 1) throw new SnapshotResourceLimitError('Automatic journal retention admission expired')
      await this.snapshotJournalAutomaticRetention.run(
        current,
        policy,
        (request, selected) => this.maintainSnapshotJournal(request, selected),
        () => this.awaitSnapshotJournalMaintenanceCleanup(),
        { lifetimeMs: remaining, signal: controller.signal }
      )
    })
    const flight = { promise, controller }
    this.snapshotJournalRetentionFlight = flight
    try {
      await promise
    } finally {
      signal?.removeEventListener('abort', abort)
      if (this.snapshotJournalRetentionFlight === flight) this.snapshotJournalRetentionFlight = undefined
    }
  }

  private async stopAutomaticSnapshotJournalRetention(): Promise<void> {
    const flight = this.snapshotJournalRetentionFlight
    if (flight === undefined) return
    flight.controller.abort(new SnapshotCancelledError('Automatic journal retention stopped with its provider'))
    try {
      await flight.promise
    } catch (error) {
      // Only this owned logical cancellation is drained normally. Secondary
      // processing, authority or physical cleanup errors still reject destruction.
      if (
        !flight.controller.signal.aborted ||
        (!(error instanceof SnapshotCancelledError) && error !== flight.controller.signal.reason)
      )
        throw error
    }
  }

  /** One internal global floor/page operation; shares source admission until native cleanup drains. */
  async maintainSnapshotJournal(
    request: SnapshotJournalMaintenanceRequest,
    options: SnapshotJournalMaintenanceOptions = {}
  ): Promise<SnapshotJournalMaintenanceResult> {
    if (this.snapshotAdmissionStopped)
      throw new WERR_INVALID_OPERATION('Snapshot journal maintenance is unavailable after destruction begins')
    if (this.snapshotSyncBusy)
      throw new WERR_INVALID_OPERATION('This provider already has a snapshot source or maintenance opening or active')
    this.snapshotSyncBusy = true
    let lifetime: SnapshotJournalMaintenanceTask<SnapshotJournalMaintenanceResult>
    let admissionRefusal: WERR_INVALID_OPERATION | undefined
    try {
      lifetime = startSnapshotJournalMaintenance(
        async () => {
          if (this.snapshotAdmissionStopped) {
            admissionRefusal = new WERR_INVALID_OPERATION(
              'Snapshot journal maintenance is unavailable after destruction begins'
            )
            throw admissionRefusal
          }
          return await this.concurrentSnapshotReaderConfig()
        },
        request,
        options,
        isOwnedNativeSqlite(this.knex) ? this.knex : undefined
      )
    } catch (error) {
      this.snapshotSyncBusy = false
      throw error
    }
    const owner: SnapshotJournalMaintenanceTask<SnapshotJournalMaintenanceResult> = {
      result: lifetime.result,
      closed: lifetime.closed,
      async close() {
        try {
          await lifetime.close()
        } catch (error) {
          // This exact refusal precedes configuration and every native allocation.
          // Preserve it for the operation; destruction has no physical owner to
          // recover. All other causes, including aggregated cleanup errors, escape.
          if (admissionRefusal === undefined || error !== admissionRefusal) throw error
        }
      }
    }
    this.snapshotJournalMaintenance = owner
    const release = (error?: unknown): void => {
      if (error instanceof SnapshotJournalConnectionCleanupError) {
        this.snapshotJournalMaintenanceFailure = error
        this.retainedReadSnapshotsStopped = true
        return
      }
      if (this.snapshotJournalMaintenance === owner) {
        this.snapshotJournalMaintenance = undefined
        this.snapshotSyncBusy = false
      }
    }
    void lifetime.closed.then(() => release(), release)
    return await lifetime.result
  }

  /** Drain an already-stopping maintenance owner; a failed native cleanup remains observable. */
  awaitSnapshotJournalMaintenanceCleanup(): Promise<void> {
    if (this.snapshotJournalMaintenanceFailure !== undefined)
      return Promise.reject(this.snapshotJournalMaintenanceFailure)
    return this.snapshotJournalMaintenance?.closed ?? Promise.resolve()
  }

  /** Drain an already-stopping capture without admitting another source. */
  awaitSnapshotJournalCaptureCleanup(): Promise<void> {
    if (this.snapshotJournalCaptureFailure !== undefined) return Promise.reject(this.snapshotJournalCaptureFailure)
    return this.snapshotJournalCapture?.closed ?? Promise.resolve()
  }

  /** One bounded recovery flight per provider, drained by provider destruction. */
  recoverSnapshotArchiveSources(): Promise<void> {
    if (this.snapshotAdmissionStopped)
      return Promise.reject(new WERR_INVALID_OPERATION('Snapshot source recovery is unavailable after destruction'))
    if (this.snapshotArchiveRecovery !== undefined) return this.snapshotArchiveRecovery
    const recovery = Promise.resolve()
      .then(async () => {
        const config = await this.concurrentSnapshotReaderConfig()
        if (config === undefined) return
        await recoverSnapshotArchiveGuards(this.knex, config)
      })
      .finally(() => {
        if (this.snapshotArchiveRecovery === recovery) this.snapshotArchiveRecovery = undefined
      })
    this.snapshotArchiveRecovery = recovery
    return recovery
  }

  /** Drain an already-started recovery without admitting another one during service shutdown. */
  awaitSnapshotArchiveRecovery(): Promise<void> {
    return this.snapshotArchiveRecovery ?? Promise.resolve()
  }

  private async openConcurrentSyncSource<T extends WalletReadSnapshot>(
    identityKey: string,
    options: WalletReadSnapshotOptions,
    openSource: (reader: StorageKnex, identityKey: string, options: WalletReadSnapshotOptions) => Promise<T>
  ): Promise<T | undefined> {
    if (this.snapshotAdmissionStopped)
      throw new WERR_INVALID_OPERATION('Snapshot sync is unavailable after destruction begins')
    if (this.snapshotSyncBusy)
      throw new WERR_INVALID_OPERATION('This provider already has a snapshot sync source opening or active')
    const lifetimeMs = options.lifetimeMs ?? 300000
    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > 3600000) {
      throw new WERR_INVALID_PARAMETER('lifetimeMs', 'an integer from 1 to 3600000')
    }
    const deadline = {
      expiresAt: Date.now() + lifetimeMs,
      startedAt: performance.now(),
      lifetimeMs
    }
    this.snapshotSyncBusy = true
    const opening: Promise<T | undefined> = this.createConcurrentSyncSource(
      identityKey,
      { ...options },
      deadline,
      openSource
    )
      .then(
        view => {
          if (view === undefined) this.snapshotSyncBusy = false
          return view
        },
        error => {
          this.snapshotSyncBusy = false
          throw error
        }
      )
      .finally(() => {
        if (this.snapshotSyncOpening === opening) this.snapshotSyncOpening = undefined
      })
    this.snapshotSyncOpening = opening
    return await opening
  }

  private async createConcurrentSyncSource<T extends WalletReadSnapshot>(
    identityKey: string,
    options: WalletReadSnapshotOptions,
    deadline: { expiresAt: number; startedAt: number; lifetimeMs: number },
    openSource: (reader: StorageKnex, identityKey: string, options: WalletReadSnapshotOptions) => Promise<T>
  ): Promise<T | undefined> {
    if (options.signal?.aborted === true) throw new SnapshotCancelledError('Snapshot sync source was cancelled')
    const root = this.knex,
      origin = ownedNativeRootIdentity(root)
    if (nativeOwnedRootCloseState(root) !== undefined && origin?.slot !== 0)
      throw new WERR_INVALID_OPERATION('Concurrent snapshot requires its live original native writer root')
    const config = await this.concurrentSnapshotReaderConfig()
    if (config === undefined) return undefined
    if (this.snapshotAdmissionStopped)
      throw new WERR_INVALID_OPERATION('Snapshot sync is unavailable after destruction begins')
    const remaining = Math.floor(
      Math.min(deadline.expiresAt - Date.now(), deadline.lifetimeMs - (performance.now() - deadline.startedAt))
    )
    if (remaining < 1) throw new SnapshotResourceLimitError('Snapshot sync source expired during connection setup')
    if (
      this.knex !== root ||
      (origin !== undefined &&
        (origin.slot !== 0 ||
          ownedNativeRootIdentity(root)?.token !== origin.token ||
          ownedNativeRootIdentity(root)?.slot !== 0))
    )
      throw new WERR_INVALID_OPERATION('Concurrent snapshot source lost its original native writer root')
    const reader = new StorageKnex({
      ...StorageProvider.createStorageBaseOptions(this.chain),
      snapshotSync: false,
      telemetry: this.snapshotSyncTelemetry,
      knex: origin !== undefined ? createOwnedNativeReadDatabase(root) : createKnex(config)
    })
    this.snapshotSyncSource = reader
    try {
      const view = await openSource(reader, identityKey, { ...options, lifetimeMs: remaining })
      if (
        this.snapshotAdmissionStopped ||
        this.knex !== root ||
        (origin !== undefined &&
          (ownedNativeRootIdentity(root)?.token !== origin.token || ownedNativeRootIdentity(root)?.slot !== 0))
      ) {
        await view.close()
        throw new WERR_INVALID_OPERATION('Snapshot sync is unavailable after destruction begins')
      }
      const closed = view.closed.finally(() => this.releaseConcurrentSource(reader))
      void closed.catch(() => undefined)
      const copyDates = <V extends { created_at: Date; updated_at: Date }>(value: V): V => ({
        ...value,
        created_at: new Date(value.created_at),
        updated_at: new Date(value.updated_at)
      })
      return {
        ...view,
        get sourceStorage() {
          return copyDates(view.sourceStorage)
        },
        get user() {
          return copyDates(view.user)
        },
        get isOpen() {
          return view.isOpen
        },
        closed,
        close: async () => {
          await view.close().catch(() => undefined)
          await closed
        }
      }
    } catch (error) {
      try {
        await this.releaseConcurrentSource(reader)
      } catch (error_) {
        // One retained guarded failure remains the same error for opening and
        // later provider destruction; it already owns its concrete cleanup.
        if (error === error_ && error instanceof SnapshotArchiveSourceCleanupError) throw error
        throw new SnapshotArchiveSourceCleanupError(
          origin === undefined
            ? error_
            : new AggregateError(
                [error, error_],
                'Concurrent snapshot opening failed with retained native reader cleanup',
                { cause: error }
              ),
          async () => {
            if (error instanceof SnapshotArchiveSourceCleanupError) await error.retryCleanup()
            if (error_ instanceof SnapshotArchiveSourceCleanupError && error_ !== error) await error_.retryCleanup()
            await this.releaseConcurrentSource(reader)
          }
        )
      }
      throw error
    }
  }

  private async concurrentSnapshotReaderConfig(): Promise<Knex.Config | undefined> {
    const config = this.knex.client.config as Knex.Config
    const connection = config.connection
    // A function or external pool cannot promise an independent connection.
    // In-memory SQLite cannot share a coherent WAL view with a separate pool.
    if (
      connection === null ||
      typeof connection !== 'object' ||
      ('connectionPool' in config && config.connectionPool != null)
    )
      return undefined
    if (this.databaseSystem() === 'sqlite') {
      const filename = (connection as Knex.Sqlite3ConnectionConfig).filename
      if (
        typeof filename !== 'string' ||
        filename.length === 0 ||
        filename === ':memory:' ||
        filename.startsWith('file:')
      )
        return undefined
      const modes: Array<{ journal_mode: string }> = await this.knex.raw('PRAGMA journal_mode')
      if (modes[0]?.journal_mode.toLowerCase() !== 'wal') return undefined
    } else if (
      this.databaseSystem() !== 'mysql' ||
      !('database' in connection) ||
      typeof connection.database !== 'string'
    )
      return undefined
    return {
      ...config,
      // Preserve hidden credentials and accessors without making them log-visible.
      connection: Object.create(Object.getPrototypeOf(connection), Object.getOwnPropertyDescriptors(connection)),
      pool: { ...config.pool, min: 0, max: 1 }
    }
  }

  private async releaseConcurrentSource(reader: StorageKnex): Promise<void> {
    try {
      await reader.destroy()
    } catch (error) {
      // Failed physical cleanup must never reopen capacity for another view.
      this.retainedReadSnapshotsStopped = true
      throw error
    }
    if (this.snapshotSyncSource === reader) this.snapshotSyncSource = undefined
    this.snapshotSyncBusy = false
  }

  protected override supportsNoSendExpiryPersistence(): boolean {
    return true
  }
  protected override requiresActionBatchCleanupBeforeCreateAction(): boolean {
    return false
  }

  override async makeAvailable(): Promise<TableSettings> {
    const settings = await super.makeAvailable()
    this.startPreparedBeefBackfill()
    return settings
  }

  override setServices(services: WalletServices): void {
    super.setServices(services)
    this.startPreparedBeefBackfill()
  }

  async readSettings(trx?: TrxToken): Promise<TableSettings> {
    return this.validateEntity(verifyOne(await this.toDb(trx)<TableSettings>('settings')))
  }

  override async getProvenOrRawTx(txid: string, trx?: TrxToken): Promise<ProvenOrRawTx> {
    const r: ProvenOrRawTx = {
      proven: undefined,
      rawTx: undefined,
      inputBEEF: undefined
    }

    r.proven = verifyOneOrNone(await this.findProvenTxs({ partial: { txid }, trx }))
    if (r.proven == null) {
      const reqRawTx = verifyOneOrNone(
        await this.findProvenTxReqs({
          partial: { txid },
          status: ['unsent', 'unmined', 'unconfirmed', 'sending', 'nosend', 'completed'],
          trx
        })
      )
      if (reqRawTx != null) {
        r.rawTx = Array.from(reqRawTx.rawTx)
        r.inputBEEF = reqRawTx.inputBEEF == null ? undefined : Array.from(reqRawTx.inputBEEF)
      }
    }
    return r
  }

  override async getProvenOrRawTxs(txids: string[], trx?: TrxToken): Promise<Map<string, ProvenOrRawTx>> {
    const unique = [...new Set(txids)]
    const results = new Map<string, ProvenOrRawTx>()
    if (unique.length === 0) return results

    const proven = await this.findProvenTxs({ partial: {}, txids: unique, trx })
    const provenTxids = new Set(proven.map(transaction => transaction.txid))
    for (const transaction of proven) {
      results.set(transaction.txid, { proven: transaction, rawTx: undefined, inputBEEF: undefined })
    }

    const unresolved = unique.filter(txid => !provenTxids.has(txid))
    if (unresolved.length > 0) {
      const requests = await this.findProvenTxReqs({
        partial: {},
        txids: unresolved,
        status: ['unsent', 'unmined', 'unconfirmed', 'sending', 'nosend', 'completed'],
        trx
      })
      for (const request of requests) {
        results.set(request.txid, {
          proven: undefined,
          rawTx: Array.from(request.rawTx),
          inputBEEF: request.inputBEEF == null ? undefined : Array.from(request.inputBEEF)
        })
      }
    }

    for (const txid of unique) {
      if (!results.has(txid)) results.set(txid, { proven: undefined, rawTx: undefined, inputBEEF: undefined })
    }
    return results
  }

  async findPreparedBeefs(userId: number, rootTxids: string[], trx?: TrxToken): Promise<TablePreparedBeef[]> {
    const unique = [...new Set(rootTxids)]
    if (unique.length === 0) return []
    const rows = await this.readLocalPackedWalletRows<TablePreparedBeef>(
      'prepared_beefs',
      trx,
      async (db, packed) => {
        const query = db<TablePreparedBeef>('prepared_beefs')
            .where({ userId, state: 'ready', formatVersion: PREPARED_BEEF_FORMAT_VERSION })
            .whereIn('rootTxid', unique),
          length = packed
            ? brc38NativeLocalPackedWalletLength(db as Knex.Transaction, 'prepared_beefs', 'beef')
            : db.raw('length(??)', ['beef'])
        return await query.whereRaw('? >= 0 AND ? <= ?', [length, length, this.preparedBeefPolicy.maxArtifactBytes])
      },
      this.preparedBeefPolicy.maxArtifactBytes
    )
    return this.validateEntities(rows)
  }

  /** Metadata-only actual logical byte preflight on the same native view. */
  async readPreparedBeefLookupByteLength(userId: number, rootTxids: string[]): Promise<number> {
    const unique = [...new Set(rootTxids)]
    if (unique.length === 0) return 0
    return await withBrc38NativeLocalPackedWalletTransaction(this.knex, async (db, packed) => {
      const length = packed
          ? brc38NativeLocalPackedWalletLength(db as Knex.Transaction, 'prepared_beefs', 'beef')
          : db.raw('length(??)', ['beef']),
        row = (await db('prepared_beefs')
          .where({ userId, state: 'ready', formatVersion: PREPARED_BEEF_FORMAT_VERSION })
          .whereIn('rootTxid', unique)
          .first({
            byteLength: db.raw('CASE WHEN coalesce(min(?),0)<0 THEN -1 ELSE coalesce(sum(?),0) END', [length, length])
          })) as { byteLength: number } | undefined,
        bytes = Number(row?.byteLength ?? 0)
      if (!Number.isSafeInteger(bytes) || bytes < 0)
        throw new WERR_INVALID_OPERATION('Prepared BEEF lookup has an invalid actual logical field')
      return bytes
    })
  }

  async readPreparedBeefProofEpoch(trx?: TrxToken): Promise<number> {
    const row = await this.toDb(trx)<PreparedBeefMetadata>('prepared_beef_metadata')
      .where({ preparedBeefMetadataId: 1 })
      .first('proofEpoch')
    if (row == null || !Number.isSafeInteger(Number(row.proofEpoch))) {
      throw new WERR_INTERNAL('prepared BEEF proof epoch is unavailable')
    }
    return Number(row.proofEpoch)
  }

  /**
   * Cheap worker preflight. It prevents a large tenant-controlled no-send BEEF
   * from being loaded and parsed merely to discover that COOK will reject it.
   */
  async readPreparedBeefSourceByteLength(rootTxid: string): Promise<number | undefined> {
    return await withBrc38NativePackedWalletTransaction(this.knex, async (db, packed) => {
      const byteLength = (
        table: 'provenTxs' | 'provenTxReqs',
        ...columns: Array<'rawTx' | 'merklePath' | 'inputBEEF'>
      ): Knex.Raw<number> =>
        packed
          ? (() => {
              const lengths = columns.map(field => brc38NativePackedLength(db as Knex.Transaction, { table, field }))
              return db.raw(
                'CASE WHEN ' +
                  lengths.map(() => '?<0').join(' OR ') +
                  ' THEN -1 ELSE ' +
                  lengths.map(() => 'coalesce(?,0)').join('+') +
                  ' END',
                [...lengths, ...lengths]
              )
            })()
          : db.raw(columns.map(() => 'coalesce(length(??), 0)').join(' + '), columns)
      const proven = (await db('proven_txs')
        .where({ txid: rootTxid })
        .first({ byteLength: byteLength('provenTxs', 'rawTx', 'merklePath') })) as { byteLength: number } | undefined
      if (proven != null) {
        const bytes = Number(proven.byteLength)
        if (!Number.isSafeInteger(bytes) || bytes < 0)
          throw new WERR_INVALID_OPERATION('Prepared BEEF source has an invalid actual logical field')
        return bytes
      }
      const request = (await db('proven_tx_reqs')
        .where({ txid: rootTxid })
        .whereIn('status', ['unsent', 'unmined', 'unconfirmed', 'sending', 'nosend', 'completed'])
        .first({ byteLength: byteLength('provenTxReqs', 'rawTx', 'inputBEEF') })) as { byteLength: number } | undefined
      if (request == null) return undefined
      const bytes = Number(request.byteLength)
      if (!Number.isSafeInteger(bytes) || bytes < 0)
        throw new WERR_INVALID_OPERATION('Prepared BEEF source has an invalid actual logical field')
      return bytes
    })
  }

  async upsertPreparedBeef(artifact: TablePreparedBeef, expectedProofEpoch: number): Promise<boolean> {
    return await this.transaction(async trx => {
      let epochQuery = this.toDb(trx)<PreparedBeefMetadata>('prepared_beef_metadata').where({
        preparedBeefMetadataId: 1
      })
      // Serialize a worker commit with proof invalidation across MySQL and
      // Postgres server processes. SQLite serializes the subsequent write transaction.
      if (this.dbtype === 'MySQL' || this.dbtype === 'Postgres') epochQuery = epochQuery.forUpdate()
      const metadata = await epochQuery.first('proofEpoch')
      if (metadata == null || Number(metadata.proofEpoch) !== expectedProofEpoch) return false

      await withBrc38NativeLocalPackedWalletMutation(this.toDb(trx), async (db, packed) => {
        const prepared = packed ? prepareBrc38NativeLocalPackedWalletWrite('prepared_beefs', artifact) : undefined
        try {
          const row = await this.validateEntityForInsert((prepared?.row ?? artifact) as TablePreparedBeef, db)
          if (row.preparedBeefId === 0) delete row.preparedBeefId
          const update = {
            beef: row.beef,
            checksum: row.checksum,
            formatVersion: row.formatVersion,
            state: row.state,
            txCount: row.txCount,
            bumpCount: row.bumpCount,
            byteLength: row.byteLength,
            updated_at: row.updated_at
          }
          await db<TablePreparedBeef>('prepared_beefs').insert(row).onConflict(['userId', 'rootTxid']).merge(update)
          if (prepared !== undefined) {
            const saved = (await db('prepared_beefs')
              .where({ userId: row.userId, rootTxid: row.rootTxid })
              .select('preparedBeefId')
              .limit(2)) as Array<{ preparedBeefId: number }>
            if (saved.length !== 1)
              throw new WERR_INVALID_OPERATION('Prepared BEEF upsert lost its current physical row')
            await finishBrc38NativeLocalPackedWalletWrite(
              db as Knex.Transaction,
              'prepared_beefs',
              saved[0].preparedBeefId,
              prepared.fields
            )
          }
        } finally {
          if (prepared !== undefined) releaseBrc38NativeLocalPackedWalletWrite(prepared)
        }
      })
      return true
    })
  }

  async findPreparedBeefBackfillRoots(limit: number, formatVersion: number): Promise<PreparedBeefRoot[]> {
    return await withBrc38NativePackedWalletTransaction(this.knex, async db => {
      const query = db('outputs as o')
        .join('transactions as t', function () {
          this.on('t.transactionId', '=', 'o.transactionId').andOn('t.userId', '=', 'o.userId')
        })
        .leftJoin('prepared_beefs as pb', function () {
          this.on('pb.userId', '=', 'o.userId')
            .andOn('pb.rootTxid', '=', 'o.txid')
            .andOnVal('pb.formatVersion', '=', formatVersion)
        })
        .where('o.spendable', true)
        .whereNull('o.spentBy')
        .where('o.change', true)
        .where('o.providedBy', 'storage')
        .whereNotNull('o.derivationPrefix')
        .whereNotNull('o.derivationSuffix')
        .whereNotNull('o.txid')
        // Backfill only settled roots. Pending roots receive one organic
        // processAction attempt and can be retried after a canonical read; a
        // perpetual backfill loop must not poll an unconfirmed ancestry chain.
        .where('t.status', 'completed')
        .whereNotNull('t.provenTxId')
        .whereNull('pb.preparedBeefId')
        .select('o.userId', 'o.txid as rootTxid')
        .groupBy('o.userId', 'o.txid')
        // ?? quotes identifiers: Postgres lowercases unquoted names, so camelCase columns must be quoted.
        .orderByRaw('MIN(??)', ['o.outputId'])
        .limit(limit)
      if (isOwnedNativeSqlite(db) && (await hasBrc38NativePackedTextSchema(db as Knex.Transaction))) {
        applyBrc38NativePackedTextWhere(query, 'outputs', 'purpose', 'change', 'o')
        applyBrc38NativePackedTextWhere(query, 'outputs', 'type', 'P2PKH', 'o')
      } else query.where('o.purpose', 'change').where('o.type', 'P2PKH')
      return (await query) as PreparedBeefRoot[]
    })
  }

  async invalidatePreparedBeefs(trx?: TrxToken): Promise<number> {
    if (trx == null) {
      return await this.transaction(async transaction => await this.invalidatePreparedBeefs(transaction))
    }
    const metadataUpdates = await this.toDb(trx)('prepared_beef_metadata')
      .where({ preparedBeefMetadataId: 1 })
      .increment('proofEpoch', 1)
    if (metadataUpdates !== 1) throw new WERR_INTERNAL('prepared BEEF proof epoch update failed')
    return await this.toDb(trx)<TablePreparedBeef>('prepared_beefs')
      .where({ state: 'ready' })
      .update(
        this.validatePartialForUpdate<TablePreparedBeef>({
          state: 'stale',
          // A later backfill pass must not mistake an invalidated current-format
          // row for a completed artifact.
          formatVersion: 0
        })
      )
  }

  async lookupPreparedBeefs(
    userId: number,
    rootTxids: string[],
    parent?: TelemetrySpan
  ): Promise<PreparedBeefLookupResult> {
    return await lookupPreparedBeefs(this, userId, rootTxids, parent)
  }

  preparedBeefReadsEnabled(): boolean {
    return this.preparedBeefPolicy.readEnabled && this.preparedBeefReadSuspensions.size === 0
  }

  /**
   * Synchronously close the local prepared-read gate before asynchronous reorg
   * invalidation waits for manager/database locks. The returned release is
   * idempotent; callers release it only after invalidation commits.
   */
  suspendPreparedBeefReads(): () => void {
    const suspension = ++this.nextPreparedBeefReadSuspension
    this.preparedBeefReadSuspensions.add(suspension)
    let released = false
    return () => {
      if (released) return
      released = true
      // This committed invalidation covers every reorg observed before it,
      // including an earlier failed attempt. Do not clear a newer suspension
      // whose database invalidation may still be pending.
      for (const pending of this.preparedBeefReadSuspensions) {
        if (pending <= suspension) this.preparedBeefReadSuspensions.delete(pending)
      }
    }
  }

  preparedBeefWritesEnabled(): boolean {
    return this.preparedBeefPolicy.writeEnabled
  }

  /** Queue best-effort preparation after foreground action work has completed. */
  enqueuePreparedBeef(preparation: PreparedBeefPreparation): boolean {
    return this.preparedBeefCoordinator.enqueue(preparation)
  }

  /** Start the optional, rate-limited existing-wallet backfill. */
  startPreparedBeefBackfill(): void {
    if (!this.isAvailable() || this._services == null) return
    this.preparedBeefCoordinator.startBackfill()
  }

  /** Test/operator hook for waiting until currently queued work is complete. */
  async waitForPreparedBeefTasks(): Promise<void> {
    await this.preparedBeefCoordinator.waitForIdle()
  }

  /** Stop accepting background work and settle an active preparation before shutdown. */
  async stopPreparedBeefTasks(): Promise<void> {
    await this.preparedBeefCoordinator.stop()
  }

  private rawTxSliceExpression(offset: number, length: number, dbtype: DBType): Knex.Raw<Buffer> {
    const sql = dbtype === 'MySQL' ? 'substring(?? from ? for ?)' : 'substr(??, ?, ?)'
    return this.knex.raw(sql, ['rawTx', offset + 1, length])
  }

  private async getRawTxSlice(
    txid: string,
    offset: number,
    length: number,
    dbtype: DBType,
    trx?: TrxToken
  ): Promise<number[] | undefined> {
    const k = this.toDb(trx)
    if (isOwnedNativeSqlite(k))
      return await withBrc38NativePackedWalletTransaction(k, async (db, packed) => {
        if (packed) return await readBrc38NativePackedWalletRawSlice(db, txid, offset, length)
        return await this.getRawTxSliceLegacy(db, txid, offset, length, dbtype)
      })
    return await this.getRawTxSliceLegacy(k, txid, offset, length, dbtype)
  }

  private async getRawTxSliceLegacy(
    k: Knex,
    txid: string,
    offset: number,
    length: number,
    dbtype: DBType
  ): Promise<number[] | undefined> {
    const slice = this.rawTxSliceExpression(offset, length, dbtype)
    const proven = verifyOneOrNone(await k('proven_txs').select({ rawTx: slice }).where({ txid })) as
      { rawTx: Buffer | null } | undefined
    if (proven?.rawTx != null) return Array.from(proven.rawTx)
    const req = verifyOneOrNone(
      await k('proven_tx_reqs')
        .select({ rawTx: slice })
        .where({ txid })
        .whereIn('status', ['unsent', 'nosend', 'sending', 'unmined', 'completed', 'unfail'])
    ) as { rawTx: Buffer | null } | undefined
    return req?.rawTx != null ? Array.from(req.rawTx) : undefined
  }

  override async getRawTxOfKnownValidTransaction(
    txid?: string,
    offset?: number,
    length?: number,
    trx?: TrxToken
  ): Promise<number[] | undefined> {
    if (txid == null || txid === '') return undefined
    const hasOffset = offset !== undefined
    const hasLength = length !== undefined
    if (hasOffset !== hasLength) {
      throw new WERR_INVALID_PARAMETER('offset and length', 'both defined or both undefined')
    }
    if (
      hasOffset &&
      (!/^[0-9a-f]{64}$/i.test(txid) ||
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        (offset as number) < 0 ||
        (length as number) < 0 ||
        !Number.isSafeInteger((offset as number) + (length as number)))
    ) {
      throw new WERR_INVALID_PARAMETER(
        'txid, offset and length',
        'a hexadecimal transaction id and non-negative safe slice integers with a safe sum'
      )
    }
    // A cold caller may already own SQLite's only connection. Read settings
    // through that transaction without caching uncommitted state or starting
    // the background backfill before the caller commits.
    let settings: TableSettings
    if (this.isAvailable()) settings = this.getSettings()
    else if (trx != null) settings = await this.readSettings(trx)
    else settings = await this.makeAvailable()
    if (hasOffset) {
      return await this.getRawTxSlice(txid, offset as number, length as number, settings.dbtype, trx)
    }
    const r = await this.getProvenOrRawTx(txid, trx)
    return r.proven != null ? r.proven.rawTx : r.rawTx
  }

  getProvenTxsForUserQuery(args: FindForUserSincePagedArgs): Knex.QueryBuilder<TableProvenTx, TableProvenTx[]> {
    const k = this.toDb(args.trx)
    let q = k('proven_txs').where(function () {
      void this.whereExists(
        k
          .select('*')
          .from('transactions')
          // ?? quotes identifiers: Postgres lowercases unquoted names, so camelCase columns must be quoted.
          .whereRaw('?? = ?? and ?? = ?', [
            'proven_txs.provenTxId',
            'transactions.provenTxId',
            'transactions.userId',
            args.userId
          ])
      )
    })
    if (args.paged != null) {
      q = q.orderBy(pagingOrder('proven_txs'))
      q = q.limit(args.paged.limit)
      q = q.offset(args.paged.offset ?? 0)
    }
    if (args.since != null) q = q.where('updated_at', '>=', this.validateDateForWhere(args.since))
    return q
  }

  override async getProvenTxsForUser(args: FindForUserSincePagedArgs): Promise<TableProvenTx[]> {
    const rs = await this.readPackedWalletRows<TableProvenTx>(
      'proven_txs',
      args.trx,
      async db => await this.getProvenTxsForUserQuery({ ...args, trx: db })
    )
    return this.validateEntities(rs)
  }

  getProvenTxReqsForUserQuery(
    args: FindForUserSincePagedArgs
  ): Knex.QueryBuilder<TableProvenTxReq, TableProvenTxReq[]> {
    const k = this.toDb(args.trx)
    let q = k('proven_tx_reqs').where(function () {
      void this.whereExists(
        k
          .select('*')
          .from('transactions')
          // ?? quotes identifiers: Postgres lowercases unquoted names, so camelCase columns must be quoted.
          .whereRaw('proven_tx_reqs.txid = transactions.txid and ?? = ?', ['transactions.userId', args.userId])
      )
    })
    if (args.paged != null) {
      q = q.orderBy(pagingOrder('proven_tx_reqs'))
      q = q.limit(args.paged.limit)
      q = q.offset(args.paged.offset ?? 0)
    }
    if (args.since != null) q = q.where('updated_at', '>=', this.validateDateForWhere(args.since))
    return q
  }

  override async getProvenTxReqsForUser(args: FindForUserSincePagedArgs): Promise<TableProvenTxReq[]> {
    const rs = await this.readPackedWalletRows<TableProvenTxReq>(
      'proven_tx_reqs',
      args.trx,
      async db => await this.getProvenTxReqsForUserQuery({ ...args, trx: db })
    )
    return this.validateEntities(rs, undefined, ['notified'])
  }

  getTxLabelMapsForUserQuery(args: FindForUserSincePagedArgs): Knex.QueryBuilder {
    const k = this.toDb(args.trx)
    let q = k('tx_labels_map').whereExists(
      k
        .select('*')
        .from('tx_labels')
        // ?? quotes identifiers: Postgres lowercases unquoted names, so camelCase columns must be quoted.
        .whereRaw('?? = ?? and ?? = ?', [
          'tx_labels.txLabelId',
          'tx_labels_map.txLabelId',
          'tx_labels.userId',
          args.userId
        ])
    )
    if (args.since != null) q = q.where('updated_at', '>=', this.validateDateForWhere(args.since))
    if (args.paged != null) {
      q = q.orderBy(pagingOrder('tx_labels_map'))
      q = q.limit(args.paged.limit)
      q = q.offset(args.paged.offset ?? 0)
    }
    return q
  }

  override async getTxLabelMapsForUser(args: FindForUserSincePagedArgs): Promise<TableTxLabelMap[]> {
    const q = this.getTxLabelMapsForUserQuery(args)
    const rs = await q
    return this.validateEntities(rs, undefined, ['isDeleted'])
  }

  getOutputTagMapsForUserQuery(args: FindForUserSincePagedArgs): Knex.QueryBuilder {
    const k = this.toDb(args.trx)
    let q = k('output_tags_map').whereExists(
      k
        .select('*')
        .from('output_tags')
        // ?? quotes identifiers: Postgres lowercases unquoted names, so camelCase columns must be quoted.
        .whereRaw('?? = ?? and ?? = ?', [
          'output_tags.outputTagId',
          'output_tags_map.outputTagId',
          'output_tags.userId',
          args.userId
        ])
    )
    if (args.since != null) q = q.where('updated_at', '>=', this.validateDateForWhere(args.since))
    if (args.paged != null) {
      q = q.orderBy(pagingOrder('output_tags_map'))
      q = q.limit(args.paged.limit)
      q = q.offset(args.paged.offset ?? 0)
    }
    return q
  }

  override async getOutputTagMapsForUser(args: FindForUserSincePagedArgs): Promise<TableOutputTagMap[]> {
    const q = this.getOutputTagMapsForUserQuery(args)
    const rs = await q
    return this.validateEntities(rs, undefined, ['isDeleted'])
  }

  private async countSyncQuery(query: Knex.QueryBuilder): Promise<number> {
    const row = await query.count<{ count: string | number }>({ count: '*' }).first()
    return Number(row?.count ?? 0)
  }

  override async getSyncChunkTotals(args: RequestSyncChunkArgs, userId: number): Promise<SyncChunkTotals> {
    const since = args.since
    const [
      provenTxs,
      outputBaskets,
      outputTags,
      txLabels,
      transactions,
      outputs,
      txLabelMaps,
      outputTagMaps,
      certificates,
      certificateFields,
      commissions,
      provenTxReqs
    ] = await Promise.all([
      this.countSyncQuery(this.getProvenTxsForUserQuery({ userId, since })),
      this.countOutputBaskets({ partial: { userId }, since }),
      this.countOutputTags({ partial: { userId }, since }),
      this.countTxLabels({ partial: { userId }, since }),
      this.countTransactions({ partial: { userId }, since, noRawTx: true }),
      this.countOutputs({ partial: { userId }, since, noScript: true }),
      this.countSyncQuery(this.getTxLabelMapsForUserQuery({ userId, since })),
      this.countSyncQuery(this.getOutputTagMapsForUserQuery({ userId, since })),
      this.countCertificates({ partial: { userId }, since }),
      this.countCertificateFields({ partial: { userId }, since }),
      this.countCommissions({ partial: { userId }, since }),
      this.countSyncQuery(this.getProvenTxReqsForUserQuery({ userId, since }))
    ])
    const records = {
      provenTxs,
      outputBaskets,
      outputTags,
      txLabels,
      transactions,
      outputs,
      txLabelMaps,
      outputTagMaps,
      certificates,
      certificateFields,
      commissions,
      provenTxReqs
    }
    return {
      totalRecords: Object.values(records).reduce((total, count) => total + count, 0),
      records
    }
  }

  override async listActions(auth: AuthId, vargs: ValidListActionsArgs): Promise<ListActionsResult> {
    if (auth.userId == null) throw new WERR_UNAUTHORIZED()
    return await listActions(this, auth, vargs)
  }

  override async listOutputs(
    auth: AuthId,
    vargs: ValidListOutputsArgs,
    admission?: StorageWriterAdmission
  ): Promise<ListOutputsResult> {
    if (auth.userId == null) throw new WERR_UNAUTHORIZED()
    return await listOutputs(this, auth, vargs, undefined, admission)
  }

  /** The explicit native packed layout keeps metadata and logical bytes in
   * one current transaction; ordinary SQL providers retain their original path. */
  async writePreparedNativeSnapshotFields(
    table:
      | 'transactions'
      | 'provenTxs'
      | 'provenTxReqs'
      | 'outputs'
      | 'commissions'
      | 'syncStates'
      | 'certificates'
      | 'certificateFields',
    rowId: number,
    fields: Readonly<Record<string, PreparedPackedNativeSnapshotField>>,
    trx: Knex.Transaction
  ): Promise<void> {
    await this.verifyReadyForDatabaseAccess(trx)
    const root = ownedNativeRootIdentity(this.knex),
      writer = ownedNativeRootIdentity(trx),
      definitions = {
        transactions: ['transactions', 'transactionId'],
        provenTxs: ['proven_txs', 'provenTxId'],
        provenTxReqs: ['proven_tx_reqs', 'provenTxReqId'],
        outputs: ['outputs', 'outputId'],
        commissions: ['commissions', 'commissionId'],
        syncStates: ['sync_states', 'syncStateId'],
        certificates: ['certificates', 'certificateId'],
        certificateFields: ['certificate_fields', 'rowid']
      } as const
    if (
      root?.slot !== 0 ||
      writer?.slot !== 0 ||
      root.token !== writer.token ||
      !Number.isSafeInteger(rowId) ||
      rowId < 1 ||
      !Object.hasOwn(definitions, table) ||
      fields === null ||
      typeof fields !== 'object' ||
      Array.isArray(fields) ||
      Object.getOwnPropertySymbols(fields).length !== 0
    )
      throw new WERR_INVALID_OPERATION('Prepared native fields require this actual current row writer')
    const names = Object.getOwnPropertyNames(fields),
      markers: Record<string, string | Buffer> = Object.create(null),
      selected: Array<PreparedPackedNativeSnapshotField> = []
    if (names.length < 1 || names.length > 8) throw new WERR_INVALID_OPERATION('Prepared native field list differs')
    for (const name of names) {
      const property = Object.getOwnPropertyDescriptor(fields, name)
      if (property === undefined || !property.enumerable || !Object.hasOwn(property, 'value'))
        throw new WERR_INVALID_OPERATION('Prepared native fields must be concrete owned actors')
      const prepared = property.value as PreparedPackedNativeSnapshotField
      assertPreparedPackedNativeSnapshotField(this, table, name, prepared)
      markers[name] = prepared.descriptor.kind === 'binary' ? Buffer.alloc(0) : ''
      selected.push(prepared)
    }
    const [sqlTable, key] = definitions[table]
    // This is a marker/pointer operation, never a fabricated complete wallet
    // DTO. The enclosing entity component writes validated scalar metadata,
    // fresh policy/parents/maps/primary fence and checkpoint in this SAME trx.
    if (
      (await trx(sqlTable)
        .where({ [key]: rowId })
        .update(markers)) !== 1
    )
      throw new WERR_INVALID_OPERATION('Prepared native field lost its actual current metadata row')
    for (const prepared of selected) await prepared.attach(trx, rowId)
  }

  private async readLocalPackedWalletRows<T extends object>(
    table: Brc38NativeLocalPackedWalletTable,
    trx: TrxToken | undefined,
    read: (db: Knex, packed: boolean) => Promise<T[]>,
    maximumFieldBytes?: number
  ): Promise<T[]> {
    return await withBrc38NativeLocalPackedWalletTransaction(this.toDb(trx), async (db, packed) => {
      const rows = await read(db, packed)
      if (packed) await hydrateBrc38NativeLocalPackedWalletRows(db as Knex.Transaction, table, rows, maximumFieldBytes)
      return rows
    })
  }

  private async insertLocalPackedWalletRow(
    table: Brc38NativeLocalPackedWalletTable,
    idColumn: string,
    input: EntityTimeStamp,
    trx?: TrxToken,
    dateFields?: string[]
  ): Promise<number> {
    return await withBrc38NativeLocalPackedWalletMutation(this.toDb(trx), async (db, packed) => {
      const prepared = packed ? prepareBrc38NativeLocalPackedWalletWrite(table, input) : undefined
      try {
        const row = await this.validateEntityForInsert((prepared?.row ?? input) as EntityTimeStamp, db, dateFields)
        if (row[idColumn] === 0) delete row[idColumn]
        const id = await this.insertReturningId(table, idColumn, row, db)
        if (prepared !== undefined)
          await finishBrc38NativeLocalPackedWalletWrite(db as Knex.Transaction, table, id, prepared.fields)
        return id
      } finally {
        if (prepared !== undefined) releaseBrc38NativeLocalPackedWalletWrite(prepared)
      }
    })
  }

  private async updateLocalPackedWalletRow(
    table: Brc38NativeLocalPackedWalletTable,
    idColumn: string,
    id: number,
    input: object,
    trx?: TrxToken,
    dateFields?: string[]
  ): Promise<number> {
    return await withBrc38NativeLocalPackedWalletMutation(this.toDb(trx), async (db, packed) => {
      const prepared = packed ? prepareBrc38NativeLocalPackedWalletWrite(table, input) : undefined
      try {
        const result = await db(table)
          .where({ [idColumn]: id })
          .update(this.validatePartialForUpdate((prepared?.row ?? input) as Partial<EntityTimeStamp>, dateFields))
        if (prepared !== undefined && result !== 0)
          await finishBrc38NativeLocalPackedWalletWrite(db as Knex.Transaction, table, id, prepared.fields)
        return result
      } finally {
        if (prepared !== undefined) releaseBrc38NativeLocalPackedWalletWrite(prepared)
      }
    })
  }

  private async insertPackedWalletRow(
    table: Brc38NativePackedWalletTable | Brc38NativePackedTextWalletTable,
    idColumn: string,
    input: EntityTimeStamp,
    trx?: TrxToken,
    dateFields?: string[],
    booleanFields?: string[]
  ): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    return await withBrc38NativePackedWalletTransaction(this.toDb(trx), async (db, packed) => {
      const textTable = isBrc38NativePackedTextWalletTable(table) ? table : undefined,
        text = packed && textTable !== undefined && (await hasBrc38NativePackedTextSchema(db as Knex.Transaction))
      if (text) prechargeBrc38NativePackedTextWalletWrite(textTable!, input)
      const prepared =
          packed && isBrc38NativePackedWalletTable(table)
            ? prepareBrc38NativePackedWalletWrite(table, input)
            : undefined,
        json = text ? prepareBrc38NativePackedTextWalletWrite(textTable!, prepared?.row ?? input) : undefined,
        row = await this.validateEntityForInsert(
          (json?.row ?? prepared?.row ?? input) as EntityTimeStamp,
          db,
          dateFields,
          booleanFields
        )
      if (row[idColumn] === 0) delete row[idColumn]
      const id = await this.insertReturningId(table, idColumn, row, db)
      if (packed && (!Number.isSafeInteger(id) || id < 1))
        throw new WERR_INVALID_OPERATION('Packed native insert returned an invalid entity id')
      if (prepared !== undefined && isBrc38NativePackedWalletTable(table))
        await finishBrc38NativePackedWalletWrite(db, table, id, prepared.fields, json === undefined ? 16 : 0)
      if (json !== undefined) await finishBrc38NativePackedTextWalletWrite(db, textTable!, id, json.fields)
      return id
    })
  }

  private async updatePackedWalletRows(
    table: Brc38NativePackedWalletTable | Brc38NativePackedTextWalletTable,
    idColumn: string,
    ids: number | number[],
    update: Partial<EntityTimeStamp>,
    trx?: TrxToken,
    dateFields?: string[],
    booleanFields?: string[]
  ): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    if (table !== 'sync_states' && !Array.isArray(ids) && !Number.isInteger(ids))
      throw new WERR_INVALID_PARAMETER('id', 'entity id or array of entity ids')
    return await withBrc38NativePackedWalletTransaction(this.toDb(trx), async (db, packed) => {
      const query = () => (Array.isArray(ids) ? db(table).whereIn(idColumn, ids) : db(table).where(idColumn, ids))
      if (!packed) return await query().update(this.validatePartialForUpdate(update, dateFields, booleanFields))
      const textTable = isBrc38NativePackedTextWalletTable(table) ? table : undefined,
        text = textTable !== undefined && (await hasBrc38NativePackedTextSchema(db as Knex.Transaction))
      if (text && !Array.isArray(ids) && !Number.isInteger(ids))
        throw new WERR_INVALID_PARAMETER('id', 'entity id or array of entity ids')
      if (text) prechargeBrc38NativePackedTextWalletWrite(textTable!, update)
      const prepared = isBrc38NativePackedWalletTable(table)
          ? prepareBrc38NativePackedWalletWrite(table, update)
          : undefined,
        json = text ? prepareBrc38NativePackedTextWalletWrite(textTable!, prepared?.row ?? update) : undefined,
        metadata = this.validatePartialForUpdate(
          (json?.row ?? prepared?.row ?? update) as Partial<EntityTimeStamp>,
          dateFields,
          booleanFields
        ) as Partial<EntityTimeStamp> & Record<string, unknown>,
        finish = async (rowId: number) => {
          if (prepared !== undefined && isBrc38NativePackedWalletTable(table))
            await finishBrc38NativePackedWalletWrite(db, table, rowId, prepared.fields, json === undefined ? 16 : 0)
          if (json !== undefined) await finishBrc38NativePackedTextWalletWrite(db, textTable!, rowId, json.fields)
        }
      if ((prepared?.fields.length ?? 0) === 0 && (json?.fields.length ?? 0) === 0) {
        const changed = await query().update(metadata)
        // Nulling a binary field also withdraws its pointer. Run the same
        // bounded collector even when no replacement byte array was supplied.
        if (json !== undefined) await collectBrc38NativePackedContent(db as Knex.Transaction, 16)
        else await collectBrc38NativePackedGarbage(db as Knex.Transaction, 16)
        return changed
      }
      if (Object.hasOwn(metadata, idColumn) && metadata[idColumn] !== undefined) {
        // An actual PK move remains one original SQL mutation. Do not seek a
        // moved key again or attach logical bytes to its former numeric id.
        const rowId = metadata[idColumn]
        if (typeof rowId !== 'number' || !Number.isSafeInteger(rowId) || (table !== 'sync_states' && rowId < 1))
          throw new WERR_INVALID_PARAMETER('id', 'a safe native entity id in its original table domain')
        const changed = await query().update(metadata)
        if (changed > 1) throw new WERR_INVALID_OPERATION('Packed native key move affected multiple primary rows')
        if (changed === 1) await finish(rowId)
        return changed
      }
      let after: number | undefined,
        changed = 0
      for (;;) {
        const next = query()
        if (after !== undefined) void next.where(idColumn, '>', after)
        const rows = (await next.select(idColumn).orderBy(idColumn).limit(256)) as Array<Record<string, number>>
        if (rows.length === 0) return changed
        const keys = rows.map(row => row[idColumn])
        if (
          keys.some(
            id =>
              !Number.isSafeInteger(id) || (table !== 'sync_states' && id < 1) || (after !== undefined && id <= after)
          )
        )
          throw new WERR_INVALID_OPERATION('Packed native update has invalid actual row keys')
        const count = await db(table).whereIn(idColumn, keys).update(metadata)
        if (count !== keys.length) throw new WERR_INVALID_OPERATION('Packed native update lost its actual row prefix')
        for (const id of keys) await finish(id)
        changed += count
        after = keys[keys.length - 1]
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
    })
  }

  private async readPackedWalletRows<T extends object>(
    table: Brc38NativePackedWalletTable | Brc38NativePackedTextWalletTable,
    trx: TrxToken | undefined,
    query: (db: Knex) => Promise<T[]>,
    complete?: (rows: T[], database: Knex) => Promise<void>
  ): Promise<T[]> {
    return await withBrc38NativePackedWalletTransaction(this.toDb(trx), async (db, packed) => {
      const rows = await query(db)
      const textTable = isBrc38NativePackedTextWalletTable(table) ? table : undefined,
        text = packed && textTable !== undefined && (await hasBrc38NativePackedTextSchema(db as Knex.Transaction))
      if (text) await prechargeBrc38NativePackedTextWalletRows(db, textTable!, rows)
      if (packed && isBrc38NativePackedWalletTable(table))
        await hydrateBrc38NativePackedWalletRows(db, table, rows, table === 'outputs' && complete !== undefined)
      if (text) await hydrateBrc38NativePackedTextWalletRows(db, textTable!, rows)
      // Nullable script/raw fallback must use the SAME view as the metadata,
      // not a second live transaction after the coherent reader has closed.
      await complete?.(rows, db)
      return rows
    })
  }

  /**
   * Insert one row and return its auto-increment primary key. MySQL and SQLite
   * report the id as the insert result; Postgres requires a RETURNING clause.
   */
  private async insertReturningId(table: string, idColumn: string, row: object, trx?: TrxToken): Promise<number> {
    if (this.dbtype !== 'Postgres') {
      const [id] = await this.toDb(trx)(table).insert(row)
      return id
    }
    return await this.inSavepoint(trx, async db => {
      const [r] = await db(table).insert(row).returning(idColumn)
      return r[idColumn]
    })
  }

  /**
   * The findOrInsert helpers catch a failed insert and find the row again in
   * the same transaction. MySQL and SQLite allow that. Postgres aborts the
   * whole transaction on any statement error, so there the insert runs in a
   * savepoint that is rolled back on its own.
   */
  private async inSavepoint<R>(trx: TrxToken | undefined, run: (db: Knex) => Promise<R>): Promise<R> {
    if (trx == null || this.dbtype !== 'Postgres') return await run(this.toDb(trx))
    return await (trx as Knex.Transaction).transaction(async savepoint => await run(savepoint))
  }

  override async insertProvenTx(tx: TableProvenTx, trx?: TrxToken): Promise<number> {
    const id = await this.insertPackedWalletRow('proven_txs', 'provenTxId', tx, trx)
    tx.provenTxId = id
    return id
  }

  override async insertActionBatch(batch: TableActionBatch, trx?: TrxToken): Promise<number> {
    const id = await this.insertLocalPackedWalletRow('action_batches', 'actionBatchId', batch, trx, [
      'expiresAt',
      'hardExpiresAt'
    ])
    batch.actionBatchId = id
    return id
  }

  override async findActionBatch(
    userId: number,
    batchId: string,
    trx?: TrxToken
  ): Promise<TableActionBatch | undefined> {
    const row = (
      await this.readLocalPackedWalletRows<TableActionBatch>(
        'action_batches',
        trx,
        async db => await db<TableActionBatch>('action_batches').where({ userId, batchId }).limit(1)
      )
    )[0]
    return row == null ? undefined : this.validateEntity(row, ['expiresAt', 'hardExpiresAt'])
  }

  override async findActionBatchForUpdate(
    userId: number,
    batchId: string,
    trx: TrxToken,
    leaseOnly = false
  ): Promise<TableActionBatch | undefined> {
    if (leaseOnly) {
      const rows = await this.toDb(trx)<TableActionBatch>('action_batches')
        .where({ userId, batchId })
        .select(
          'actionBatchId',
          'userId',
          'batchId',
          'status',
          'expiresAt',
          'hardExpiresAt',
          'created_at',
          'updated_at'
        )
        .forUpdate()
        .limit(1)
      return rows[0] == null ? undefined : this.validateEntity(rows[0], ['expiresAt', 'hardExpiresAt'])
    }

    const row = (
      await this.readLocalPackedWalletRows<TableActionBatch>(
        'action_batches',
        trx,
        async db => await db<TableActionBatch>('action_batches').where({ userId, batchId }).forUpdate().limit(1)
      )
    )[0]
    return row == null ? undefined : this.validateEntity(row, ['expiresAt', 'hardExpiresAt'])
  }

  override async findExpiredActionBatches(now: Date, trx?: TrxToken): Promise<TableActionBatch[]> {
    const rows = await this.readLocalPackedWalletRows<TableActionBatch>(
      'action_batches',
      trx,
      async db =>
        await db<TableActionBatch>('action_batches')
          .whereIn('status', ['active', 'prepared'])
          .andWhere(builder => {
            void builder
              .where('expiresAt', '<=', this.validateDateForWhere(now))
              .orWhere('hardExpiresAt', '<=', this.validateDateForWhere(now))
          })
    )
    return this.validateEntities(rows, ['expiresAt', 'hardExpiresAt'])
  }

  override async *expiredActionBatchCandidates(now: Date): AsyncIterable<Pick<TableActionBatch, 'userId' | 'batchId'>> {
    let after = 0
    for (;;) {
      const rows: Array<Pick<TableActionBatch, 'actionBatchId' | 'userId' | 'batchId'>> = await this.knex(
        'action_batches'
      )
        .select('actionBatchId', 'userId', 'batchId')
        .where('actionBatchId', '>', after)
        .whereIn('status', ['active', 'prepared'])
        .andWhere(builder => {
          void builder
            .where('expiresAt', '<=', this.validateDateForWhere(now))
            .orWhere('hardExpiresAt', '<=', this.validateDateForWhere(now))
        })
        .orderBy('actionBatchId')
        .limit(100)
      if (!rows.length) return
      for (const row of rows) {
        after = row.actionBatchId
        yield { userId: row.userId, batchId: row.batchId }
      }
    }
  }

  override async updateActionBatch(
    actionBatchId: number,
    update: Partial<TableActionBatch>,
    trx?: TrxToken
  ): Promise<number> {
    return await this.updateLocalPackedWalletRow('action_batches', 'actionBatchId', actionBatchId, update, trx, [
      'expiresAt',
      'hardExpiresAt'
    ])
  }

  override async deleteActionBatch(actionBatchId: number, trx?: TrxToken): Promise<void> {
    await this.toDb(trx)<TableActionBatch>('action_batches').where({ actionBatchId }).delete()
  }

  override async reserveActionBatchOutputs(reservations: TableActionBatchOutput[], trx?: TrxToken): Promise<void> {
    if (reservations.length === 0) return
    const rows = await Promise.all(reservations.map(async r => await this.validateEntityForInsert(r, trx)))
    await this.toDb(trx)<TableActionBatchOutput>('action_batch_outputs').insert(rows)
  }

  override async findActionBatchOutputIds(actionBatchId: number, trx?: TrxToken): Promise<number[]> {
    const rows = await this.toDb(trx)<TableActionBatchOutput>('action_batch_outputs')
      .where({ actionBatchId })
      .select('outputId')
    return rows.map(r => r.outputId)
  }

  override async findReservedActionBatchOutputIds(outputIds: number[], trx?: TrxToken): Promise<number[]> {
    if (outputIds.length === 0) return []
    const now = new Date()
    const rows = await this.toDb(trx)<TableActionBatchOutput>('action_batch_outputs')
      .join('action_batches', 'action_batch_outputs.actionBatchId', 'action_batches.actionBatchId')
      .whereIn('outputId', outputIds)
      .whereIn('action_batches.status', ['active', 'prepared'])
      .where('action_batches.expiresAt', '>', now)
      .where('action_batches.hardExpiresAt', '>', now)
      .select('action_batch_outputs.outputId')
    return rows.map(r => r.outputId)
  }

  override async deleteActionBatchOutputReservations(actionBatchId: number, trx?: TrxToken): Promise<void> {
    await this.toDb(trx)<TableActionBatchOutput>('action_batch_outputs').where({ actionBatchId }).delete()
  }

  override async putActionBatchBlobRecord(blob: TableActionBatchBlob, trx?: TrxToken): Promise<void> {
    await withBrc38NativeLocalPackedWalletMutation(this.toDb(trx), async (db, packed) => {
      if (
        packed &&
        (await db('action_batch_blobs')
          .where({ actionBatchId: blob.actionBatchId, digest: blob.digest })
          .first('actionBatchBlobId')) !== undefined
      )
        return
      const prepared = packed ? prepareBrc38NativeLocalPackedWalletWrite('action_batch_blobs', blob) : undefined
      try {
        const e = await this.validateEntityForInsert((prepared?.row ?? blob) as TableActionBatchBlob, db)
        if (e.actionBatchBlobId === 0) delete e.actionBatchBlobId
        await db<TableActionBatchBlob>('action_batch_blobs').insert(e).onConflict(['actionBatchId', 'digest']).ignore()
        if (prepared !== undefined) {
          const saved = (await db('action_batch_blobs')
            .where({ actionBatchId: e.actionBatchId, digest: e.digest })
            .select('actionBatchBlobId')
            .limit(2)) as Array<{ actionBatchBlobId: number }>
          if (saved.length !== 1) throw new WERR_INVALID_OPERATION('Action blob insert lost its current physical row')
          await finishBrc38NativeLocalPackedWalletWrite(
            db as Knex.Transaction,
            'action_batch_blobs',
            saved[0].actionBatchBlobId,
            prepared.fields
          )
        }
      } finally {
        if (prepared !== undefined) releaseBrc38NativeLocalPackedWalletWrite(prepared)
      }
    })
  }

  override async findActionBatchBlobRecord(
    actionBatchId: number,
    digest: string,
    trx?: TrxToken
  ): Promise<TableActionBatchBlob | undefined> {
    const row = (
      await this.readLocalPackedWalletRows<TableActionBatchBlob>(
        'action_batch_blobs',
        trx,
        async db => await db<TableActionBatchBlob>('action_batch_blobs').where({ actionBatchId, digest }).limit(1)
      )
    )[0]
    if (row == null) return undefined
    if (Buffer.isBuffer(row.bytes)) {
      row.bytes = new Uint8Array(row.bytes.buffer, row.bytes.byteOffset, row.bytes.byteLength)
    }
    this.deserialiseFromKnex(row)
    return this.validateEntity(row)
  }

  override async findActionBatchBlobRecords(
    actionBatchId: number,
    digests: string[],
    trx?: TrxToken
  ): Promise<TableActionBatchBlob[]> {
    if (digests.length === 0) return []
    const uniqueDigests = [...new Set(digests)],
      rows = await this.readLocalPackedWalletRows<TableActionBatchBlob>('action_batch_blobs', trx, async db => {
        const selected: TableActionBatchBlob[] = []
        for (let offset = 0; offset < uniqueDigests.length; offset += ACTION_BATCH_BLOB_SQL_CHUNK)
          selected.push(
            ...(await db<TableActionBatchBlob>('action_batch_blobs')
              .where({ actionBatchId })
              .whereIn('digest', uniqueDigests.slice(offset, offset + ACTION_BATCH_BLOB_SQL_CHUNK)))
          )
        return selected
      })
    for (const row of rows) {
      if (Buffer.isBuffer(row.bytes)) {
        row.bytes = new Uint8Array(row.bytes.buffer, row.bytes.byteOffset, row.bytes.byteLength)
      }
      this.deserialiseFromKnex(row)
    }
    return this.validateEntities(rows)
  }

  override async putActionBatchBlobRecords(blobs: TableActionBatchBlob[], trx?: TrxToken): Promise<void> {
    if (blobs.length === 0) return
    await withBrc38NativeLocalPackedWalletTransaction(this.toDb(trx), async (db, packed) => {
      if (packed) {
        for (const blob of blobs) await this.putActionBatchBlobRecord(blob, db)
        return
      }
      const rows = await Promise.all(
        blobs.map(async blob => {
          const row = await this.validateEntityForInsert(blob, db)
          if (row.actionBatchBlobId === 0) delete row.actionBatchBlobId
          return row
        })
      )
      for (let offset = 0; offset < rows.length; offset += ACTION_BATCH_BLOB_SQL_CHUNK) {
        await db<TableActionBatchBlob>('action_batch_blobs')
          .insert(rows.slice(offset, offset + ACTION_BATCH_BLOB_SQL_CHUNK))
          .onConflict(['actionBatchId', 'digest'])
          .ignore()
      }
    })
  }

  override async deleteActionBatchBlobRecords(actionBatchId: number, trx?: TrxToken): Promise<void> {
    await this.toDb(trx)<TableActionBatchBlob>('action_batch_blobs').where({ actionBatchId }).delete()
  }

  override async insertProvenTxReq(tx: TableProvenTxReq, trx?: TrxToken): Promise<number> {
    const id = await this.insertPackedWalletRow('proven_tx_reqs', 'provenTxReqId', tx, trx)
    tx.provenTxReqId = id
    return id
  }

  override async insertUser(user: TableUser, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(user, trx)
    if (e.userId === 0) delete e.userId
    const id = await this.insertReturningId('users', 'userId', e, trx)
    user.userId = id
    return user.userId
  }

  override async insertCertificateAuth(auth: AuthId, certificate: TableCertificateX): Promise<number> {
    if (
      auth.userId == null ||
      (certificate.userId != null && certificate.userId !== 0 && certificate.userId !== auth.userId)
    )
      throw new WERR_UNAUTHORIZED()
    const write = await this.activeWriteTransaction(auth)
    certificate.userId = auth.userId
    return await write.transaction(async trx => await this.insertCertificate(certificate, trx))
  }

  override async insertCertificate(certificate: TableCertificateX, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(certificate, trx, undefined, ['isDeleted'])
    if (e.certificateId === 0) delete e.certificateId

    if (e.logger != null) delete e.logger

    const fields = e.fields
    if (e.fields != null) delete e.fields

    if (e.certificateId === undefined) e.certificateId = 0
    const id = await this.insertPackedWalletRow('certificates', 'certificateId', e, trx, undefined, ['isDeleted'])
    certificate.certificateId = id

    if (fields != null) {
      for (const field of fields) {
        field.certificateId = id
        field.userId = certificate.userId
        await this.insertCertificateField(field, trx)
      }
    }

    return certificate.certificateId
  }

  override async insertCertificateField(certificateField: TableCertificateField, trx?: TrxToken): Promise<void> {
    const captured = { ...certificateField }
    await this.verifyReadyForDatabaseAccess(trx)
    await withBrc38NativePackedWalletTransaction(this.toDb(trx), async (db, packed) => {
      const text = packed && (await hasBrc38NativePackedTextSchema(db as Knex.Transaction))
      if (text) prechargeBrc38NativePackedTextWalletWrite('certificate_fields', captured)
      const prepared = text ? prepareBrc38NativePackedTextWalletWrite('certificate_fields', captured) : undefined,
        normalized = await this.validateEntityForInsert(
          { ...(prepared?.row ?? captured), created_at: captured.created_at, updated_at: captured.updated_at },
          db
        )
      if (!text) {
        await db('certificate_fields').insert(normalized)
        return
      }
      const inserted: Array<{ rowid: number }> = await db('certificate_fields').insert(normalized).returning('rowid')
      if (inserted.length !== 1 || !Number.isSafeInteger(inserted[0].rowid) || inserted[0].rowid < 1)
        throw new WERR_INVALID_OPERATION('Packed certificate field has no actual physical row')
      await finishBrc38NativePackedTextWalletWrite(db, 'certificate_fields', inserted[0].rowid, prepared!.fields)
    })
  }

  override async insertOutputBasket(basket: TableOutputBasket, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(basket, trx, undefined, ['isDeleted'])
    if (e.basketId === 0) delete e.basketId
    const id = await this.insertReturningId('output_baskets', 'basketId', e, trx)
    basket.basketId = id
    return basket.basketId
  }

  override async insertTransaction(tx: TableTransaction, trx?: TrxToken): Promise<number> {
    const id = await this.insertPackedWalletRow('transactions', 'transactionId', tx, trx)
    tx.transactionId = id
    return id
  }

  override async insertCommission(commission: TableCommission, trx?: TrxToken): Promise<number> {
    const id = await this.insertPackedWalletRow('commissions', 'commissionId', commission, trx)
    commission.commissionId = id
    return id
  }

  override async insertOutput(output: TableOutput, trx?: TrxToken): Promise<number> {
    const id = await this.insertPackedWalletRow('outputs', 'outputId', output, trx)
    output.outputId = id
    return id
  }

  override async insertOutputs(outputs: TableOutput[], trx?: TrxToken): Promise<void> {
    if (outputs.length === 0) return
    if (isOwnedNativeSqlite(this.toDb(trx))) {
      await withBrc38NativePackedWalletTransaction(this.toDb(trx), async (db, packed) => {
        if (!packed) {
          for (const output of outputs) await this.insertOutput(output, db)
          return
        }
        for (const output of outputs) {
          await this.insertOutput(output, db)
          await new Promise<void>(resolve => setTimeout(resolve, 0))
        }
      })
      return
    }
    const rows = await Promise.all(
      outputs.map(async output => {
        const row = await this.validateEntityForInsert(output, trx)
        if (row.outputId === 0) delete row.outputId
        return row
      })
    )
    for (let offset = 0; offset < rows.length; offset += OUTPUT_INSERT_SQL_CHUNK) {
      await this.toDb(trx)<TableOutput>('outputs').insert(rows.slice(offset, offset + OUTPUT_INSERT_SQL_CHUNK))
    }
  }

  override async insertOutputTag(tag: TableOutputTag, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(tag, trx, undefined, ['isDeleted'])
    if (e.outputTagId === 0) delete e.outputTagId
    const id = await this.insertReturningId('output_tags', 'outputTagId', e, trx)
    tag.outputTagId = id
    return tag.outputTagId
  }

  override async insertOutputTagMap(tagMap: TableOutputTagMap, trx?: TrxToken): Promise<void> {
    const e = await this.validateEntityForInsert(tagMap, trx, undefined, ['isDeleted'])
    await this.inSavepoint(trx, async db => await db<TableOutputTagMap>('output_tags_map').insert(e))
  }

  override async insertTxLabel(label: TableTxLabel, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(label, trx, undefined, ['isDeleted'])
    if (e.txLabelId === 0) delete e.txLabelId
    const id = await this.insertReturningId('tx_labels', 'txLabelId', e, trx)
    label.txLabelId = id
    return label.txLabelId
  }

  override async insertTxLabelMap(labelMap: TableTxLabelMap, trx?: TrxToken): Promise<void> {
    const e = await this.validateEntityForInsert(labelMap, trx, undefined, ['isDeleted'])
    await this.inSavepoint(trx, async db => await db<TableTxLabelMap>('tx_labels_map').insert(e))
  }

  override async insertMonitorEvent(event: TableMonitorEvent, trx?: TrxToken): Promise<number> {
    const id = await this.insertLocalPackedWalletRow('monitor_events', 'id', event, trx)
    event.id = id
    return event.id
  }

  override async insertSyncState(syncState: TableSyncState, trx?: TrxToken): Promise<number> {
    const id = await this.insertPackedWalletRow('sync_states', 'syncStateId', syncState, trx, ['when'], ['init'])
    syncState.syncStateId = id
    return syncState.syncStateId
  }

  override async updateCertificateField(
    certificateId: number,
    fieldName: string,
    update: Partial<TableCertificateField>,
    trx?: TrxToken
  ): Promise<number> {
    const captured = { ...update }
    await this.verifyReadyForDatabaseAccess(trx)
    return await withBrc38NativePackedWalletTransaction(this.toDb(trx), async (db, packed) => {
      const query = () => db('certificate_fields').where({ certificateId, fieldName }),
        text = packed && (await hasBrc38NativePackedTextSchema(db as Knex.Transaction))
      if (!text) return await query().update(this.validatePartialForUpdate(captured))
      prechargeBrc38NativePackedTextWalletWrite('certificate_fields', captured)
      const prepared = prepareBrc38NativePackedTextWalletWrite('certificate_fields', captured),
        rows: Array<{ rowid: number }> = await query().select('rowid').limit(2)
      if (rows.length > 1) throw new WERR_INVALID_OPERATION('Packed certificate field identity is ambiguous')
      if (rows.length === 0) return 0
      if (!Number.isSafeInteger(rows[0].rowid) || rows[0].rowid < 1)
        throw new WERR_INVALID_OPERATION('Packed certificate field physical row differs')
      if ((await query().update(this.validatePartialForUpdate(prepared.row))) !== 1)
        throw new WERR_INVALID_OPERATION('Packed certificate field current row ended')
      await finishBrc38NativePackedTextWalletWrite(db, 'certificate_fields', rows[0].rowid, prepared.fields)
      return 1
    })
  }

  override async updateCertificate(id: number, update: Partial<TableCertificate>, trx?: TrxToken): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    return await this.updatePackedWalletRows('certificates', 'certificateId', id, update, trx, undefined, ['isDeleted'])
  }

  override async updateCommission(id: number, update: Partial<TableCommission>, trx?: TrxToken): Promise<number> {
    return await this.updatePackedWalletRows('commissions', 'commissionId', id, update, trx)
  }

  override async updateOutputBasket(id: number, update: Partial<TableOutputBasket>, trx?: TrxToken): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    return await this.toDb(trx)<TableOutputBasket>('output_baskets')
      .where({ basketId: id })
      .update(this.validatePartialForUpdate(update, undefined, ['isDeleted']))
  }

  override async updateOutput(id: number, update: Partial<TableOutput>, trx?: TrxToken): Promise<number> {
    return await this.updatePackedWalletRows('outputs', 'outputId', id, update, trx)
  }

  override async updateOutputTagMap(
    outputId: number,
    tagId: number,
    update: Partial<TableOutputTagMap>,
    trx?: TrxToken
  ): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    return await this.toDb(trx)<TableOutputTagMap>('output_tags_map')
      .where({ outputId, outputTagId: tagId })
      .update(this.validatePartialForUpdate(update, undefined, ['isDeleted']))
  }

  override async updateOutputTag(id: number, update: Partial<TableOutputTag>, trx?: TrxToken): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    return await this.toDb(trx)<TableOutputTag>('output_tags')
      .where({ outputTagId: id })
      .update(this.validatePartialForUpdate(update, undefined, ['isDeleted']))
  }

  override async updateProvenTxReq(
    id: number | number[],
    update: Partial<TableProvenTxReq>,
    trx?: TrxToken
  ): Promise<number> {
    return await this.updatePackedWalletRows('proven_tx_reqs', 'provenTxReqId', id, update, trx)
  }

  override async updateProvenTx(id: number, update: Partial<TableProvenTx>, trx?: TrxToken): Promise<number> {
    return await this.updatePackedWalletRows('proven_txs', 'provenTxId', id, update, trx)
  }

  override async compareAndSetProvenTxProof(
    expected: TableProvenTx,
    replacement: TableProvenTx,
    trx?: TrxToken
  ): Promise<boolean> {
    await this.verifyReadyForDatabaseAccess(trx)
    const update = recoveredProofUpdate(expected, replacement)
    return await withBrc38NativePackedWalletTransaction(this.toDb(trx), async (db, packed) => {
      const metadata = {
        provenTxId: expected.provenTxId,
        txid: expected.txid,
        height: expected.height,
        index: expected.index,
        merkleRoot: expected.merkleRoot,
        blockHash: expected.blockHash
      }
      if (!packed) {
        const where = { ...metadata, rawTx: Buffer.from(expected.rawTx), merklePath: Buffer.from(expected.merklePath) }
        return (await db('proven_txs').where(where).update(this.validatePartialForUpdate(update))) === 1
      }
      const rows = await db('proven_txs').where(metadata).select('provenTxId').limit(2)
      if (rows.length === 0) return false
      if (rows.length !== 1) throw new WERR_INVALID_OPERATION('Packed native proof CAS has duplicate actual rows')
      if (
        !(await matchesBrc38NativePackedWalletBytes(db, 'proven_txs', expected.provenTxId, {
          rawTx: expected.rawTx,
          merklePath: expected.merklePath
        }))
      )
        return false
      const prepared = prepareBrc38NativePackedWalletWrite('proven_txs', update),
        changed = await db('proven_txs')
          .where(metadata)
          .update(this.validatePartialForUpdate(prepared.row as Partial<TableProvenTx>))
      if (changed !== 1) return false
      await finishBrc38NativePackedWalletWrite(db, 'proven_txs', expected.provenTxId, prepared.fields)
      return true
    })
  }

  override async updateSyncState(id: number, update: Partial<TableSyncState>, trx?: TrxToken): Promise<number> {
    return await this.updatePackedWalletRows('sync_states', 'syncStateId', id, update, trx, ['when'], ['init'])
  }

  override async updateTransaction(
    id: number | number[],
    update: Partial<TableTransaction>,
    trx?: TrxToken
  ): Promise<number> {
    return await this.updatePackedWalletRows('transactions', 'transactionId', id, update, trx)
  }

  override async compareAndSetNoSendExpiryState(
    transactionId: number,
    expected: Brc177NoSendExpiryState,
    next: Brc177NoSendExpiryState,
    trx?: TrxToken
  ): Promise<boolean> {
    await this.verifyReadyForDatabaseAccess(trx)
    const updated = await this.toDb(trx)<TableTransaction>('transactions')
      .where({ transactionId, noSendExpiryState: expected })
      .update(this.validatePartialForUpdate({ noSendExpiryState: next } as Partial<TableTransaction>))
    return updated === 1
  }

  override async updateTxLabelMap(
    transactionId: number,
    txLabelId: number,
    update: Partial<TableTxLabelMap>,
    trx?: TrxToken
  ): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    return await this.toDb(trx)<TableTxLabelMap>('tx_labels_map')
      .where({ transactionId, txLabelId })
      .update(this.validatePartialForUpdate(update, undefined, ['isDeleted']))
  }

  override async updateTxLabel(id: number, update: Partial<TableTxLabel>, trx?: TrxToken): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    return await this.toDb(trx)<TableTxLabel>('tx_labels')
      .where({ txLabelId: id })
      .update(this.validatePartialForUpdate(update, undefined, ['isDeleted']))
  }

  override async updateUser(id: number, update: Partial<TableUser>, trx?: TrxToken): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    return await this.toDb(trx)<TableUser>('users').where({ userId: id }).update(this.validatePartialForUpdate(update))
  }

  override async updateMonitorEvent(id: number, update: Partial<TableMonitorEvent>, trx?: TrxToken): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    return await this.updateLocalPackedWalletRow('monitor_events', 'id', id, update, trx)
  }

  setupQuery<T extends object>(table: string, args: FindPartialSincePagedArgs<T>): Knex.QueryBuilder {
    const q = this.toDb(args.trx)<T>(table)
    if (args.partial != null && Object.keys(args.partial).length > 0) void q.where(args.partial)
    if (args.since != null) void q.where('updated_at', '>=', this.validateDateForWhere(args.since))
    if (args.orderDescending === true) {
      let sortColumn = ''
      switch (table) {
        case 'certificates':
          sortColumn = 'certificateId'
          break
        case 'commissions':
          sortColumn = 'commissionId'
          break
        case 'output_baskets':
          sortColumn = 'basketId'
          break
        case 'outputs':
          sortColumn = 'outputId'
          break
        case 'output_tags':
          sortColumn = 'outputTagId'
          break
        case 'proven_tx_reqs':
          sortColumn = 'provenTxReqId'
          break
        case 'proven_txs':
          sortColumn = 'provenTxId'
          break
        case 'sync_states':
          sortColumn = 'syncStateId'
          break
        case 'transactions':
          sortColumn = 'transactionId'
          break
        case 'tx_labels':
          sortColumn = 'txLabelId'
          break
        case 'users':
          sortColumn = 'userId'
          break
        case 'monitor_events':
          sortColumn = 'id'
          break
        default:
          break
      }
      if (sortColumn !== '') {
        void q.orderBy(sortColumn, 'desc')
      }
    }
    if (args.paged != null) {
      if (args.orderDescending !== true) void q.orderBy(pagingOrder(table))
      void q.limit(args.paged.limit)
      void q.offset(args.paged.offset ?? 0)
    }
    return q
  }

  findCertificateFieldsQuery(args: FindCertificateFieldsArgs): Knex.QueryBuilder {
    return this.setupQuery('certificate_fields', args)
  }

  findCertificatesQuery(args: FindCertificatesArgs): Knex.QueryBuilder {
    const q = this.setupQuery('certificates', args)
    if (args.certifiers != null && args.certifiers.length > 0) void q.whereIn('certifier', args.certifiers)
    if (args.types != null && args.types.length > 0) void q.whereIn('type', args.types)
    return q
  }

  findCommissionsQuery(args: FindCommissionsArgs): Knex.QueryBuilder {
    if (args.partial.lockingScript != null) {
      throw new WERR_INVALID_PARAMETER(
        'partial.lockingScript',
        'undefined. Commissions may not be found by lockingScript value.'
      )
    }
    return this.setupQuery('commissions', args)
  }

  findOutputBasketsQuery(args: FindOutputBasketsArgs): Knex.QueryBuilder {
    return this.setupQuery('output_baskets', args)
  }

  findOutputsQuery(args: FindOutputsArgs, count?: boolean): Knex.QueryBuilder {
    if (args.partial.lockingScript != null) {
      throw new WERR_INVALID_PARAMETER(
        'args.partial.lockingScript',
        'undefined. Outputs may not be found by lockingScript value.'
      )
    }
    const q = this.setupQuery('outputs', args)
    if (args.txStatus != null && args.txStatus.length > 0) {
      const allowedStatuses = new Set<TransactionStatus>([
        'completed',
        'failed',
        'unprocessed',
        'sending',
        'unproven',
        'unsigned',
        'nosend',
        'nonfinal',
        'unfail'
      ])
      if (args.txStatus.some(status => !allowedStatuses.has(status))) {
        throw new WERR_INVALID_PARAMETER('args.txStatus', 'supported transaction statuses')
      }
      const statuses = [...new Set(args.txStatus)]
      void q.whereExists(function () {
        void this.select(1)
          .from('transactions')
          .whereRaw('?? = ??', ['transactions.transactionId', 'outputs.transactionId'])
          .whereIn('transactions.status', statuses)
      })
    }
    if (args.noScript === true && count !== true) {
      const columns = outputColumnsWithoutLockingScript.map(c => `outputs.${c}`)
      void q.select(columns)
    }
    return q
  }

  findOutputTagMapsQuery(args: FindOutputTagMapsArgs): Knex.QueryBuilder {
    const q = this.setupQuery('output_tags_map', args)
    if (args.tagIds != null && args.tagIds.length > 0) void q.whereIn('outputTagId', args.tagIds)
    return q
  }

  findOutputTagsQuery(args: FindOutputTagsArgs): Knex.QueryBuilder {
    return this.setupQuery('output_tags', args)
  }

  findProvenTxReqsQuery(args: FindProvenTxReqsArgs): Knex.QueryBuilder<TableProvenTxReq, TableProvenTxReq[]> {
    if (args.partial.rawTx != null) {
      throw new WERR_INVALID_PARAMETER('args.partial.rawTx', 'undefined. ProvenTxReqs may not be found by rawTx value.')
    }
    if (args.partial.inputBEEF != null) {
      throw new WERR_INVALID_PARAMETER(
        'args.partial.inputBEEF',
        'undefined. ProvenTxReqs may not be found by inputBEEF value.'
      )
    }
    const q = this.setupQuery('proven_tx_reqs', args)
    if (args.status != null && args.status.length > 0) void q.whereIn('status', args.status)
    if (args.txids != null) {
      const txids = args.txids.filter(txid => txid !== undefined)
      if (txids.length > 0) void q.whereIn('txid', txids)
    }
    return q
  }

  findProvenTxsQuery(args: FindProvenTxsArgs): Knex.QueryBuilder<TableProvenTx, TableProvenTx[]> {
    if (args.partial.rawTx != null) {
      throw new WERR_INVALID_PARAMETER('args.partial.rawTx', 'undefined. ProvenTxs may not be found by rawTx value.')
    }
    if (args.partial.merklePath != null) {
      throw new WERR_INVALID_PARAMETER(
        'args.partial.merklePath',
        'undefined. ProvenTxs may not be found by merklePath value.'
      )
    }
    const q = this.setupQuery('proven_txs', args)
    if (args.txids != null) {
      const txids = [...new Set(args.txids.filter(txid => txid !== undefined))]
      if (txids.length > 0) void q.whereIn('txid', txids)
    }
    return q
  }

  findStaleMerkleRootsQuery(args: FindStaleMerkleRootsArgs): Knex.QueryBuilder {
    const q = this.toDb(args.trx)('proven_txs')
    void q.where('height', '=', args.height)
    void q.where('merkleRoot', '!=', args.merkleRoot)
    void q.select('merkleRoot')
    void q.distinct('merkleRoot')
    return q
  }

  findSyncStatesQuery(args: FindSyncStatesArgs): Knex.QueryBuilder {
    return this.setupQuery('sync_states', args)
  }

  /** Returned inside an object because QueryBuilder is thenable. Actual public
   * reads/counts retain this same admitted transaction through query execution;
   * no backend/schema result is retained for another operation. */
  private async packedTextQuery<T extends object>(
    db: Knex,
    table: Brc38NativePackedTextWalletTable,
    args: FindPartialSincePagedArgs<T>,
    build: (args: FindPartialSincePagedArgs<T>) => Knex.QueryBuilder<T, T[]>
  ): Promise<{ query: Knex.QueryBuilder<T, T[]> }> {
    const fixed = { ...args, partial: { ...args.partial }, trx: db },
      names = brc38NativePackedTextWalletFields(table),
      strings: Array<{
        field: import('./portable/Brc38NativeBlobProtocol').Brc38NativeTextRead['field']
        value: string
      }> = []
    // Copy all comparison strings before the first native/SQL await.
    for (const field of names) {
      const value = (fixed.partial as Record<string, unknown>)[field]
      if (typeof value === 'string') strings.push({ field: field as (typeof strings)[number]['field'], value })
    }
    if (!isOwnedNativeSqlite(db) || !(await hasBrc38NativePackedTextSchema(db as Knex.Transaction)))
      return { query: build(fixed) }
    prechargeBrc38NativePackedTextWalletWrite(
      table,
      Object.fromEntries(strings.map(value => [value.field, value.value]))
    )
    for (const { field } of strings) delete (fixed.partial as Record<string, unknown>)[field]
    const query = build(fixed)
    for (const { field, value } of strings) applyBrc38NativePackedTextWhere(query, table, field, value)
    return { query }
  }

  findTransactionsQuery(args: FindTransactionsArgs, count?: boolean): Knex.QueryBuilder {
    if (args.partial.rawTx != null) {
      throw new WERR_INVALID_PARAMETER('args.partial.rawTx', 'undefined. Transactions may not be found by rawTx value.')
    }
    if (args.partial.inputBEEF != null) {
      throw new WERR_INVALID_PARAMETER(
        'args.partial.inputBEEF',
        'undefined. Transactions may not be found by inputBEEF value.'
      )
    }
    const q = this.setupQuery('transactions', args)
    if (args.status != null && args.status.length > 0) void q.whereIn('status', args.status)
    if (args.from != null) void q.where('created_at', '>=', this.validateDateForWhere(args.from))
    if (args.to != null) void q.where('created_at', '<', this.validateDateForWhere(args.to))
    if (args.noRawTx === true && count !== true) {
      const columns = transactionColumnsWithoutRawTx.map(c => `transactions.${c}`)
      void q.select(columns)
    }
    return q
  }

  findTxLabelMapsQuery(args: FindTxLabelMapsArgs): Knex.QueryBuilder {
    const q = this.setupQuery('tx_labels_map', args)
    if (args.labelIds != null && args.labelIds.length > 0) void q.whereIn('txLabelId', args.labelIds)
    return q
  }

  findTxLabelsQuery(args: FindTxLabelsArgs): Knex.QueryBuilder {
    return this.setupQuery('tx_labels', args)
  }

  findUsersQuery(args: FindUsersArgs): Knex.QueryBuilder {
    return this.setupQuery('users', args)
  }

  findMonitorEventsQuery(args: FindMonitorEventsArgs): Knex.QueryBuilder {
    return this.setupQuery('monitor_events', args)
  }

  override async findCertificatesAuth(auth: AuthId, args: FindCertificatesArgs): Promise<TableCertificateX[]> {
    if (
      auth.userId == null ||
      (args.partial.userId != null && args.partial.userId !== 0 && args.partial.userId !== auth.userId)
    )
      throw new WERR_UNAUTHORIZED()
    args.partial.userId = auth.userId
    return await this.findCertificates(args)
  }

  override async findProvenTxReqsAuth(auth: AuthId, args: FindProvenTxReqsArgs): Promise<TableProvenTxReq[]> {
    const userId = verifyId(auth.userId),
      fixed = { ...args, partial: { ...args.partial } }
    const rows = await this.readPackedWalletRows<TableProvenTxReq>('proven_tx_reqs', fixed.trx, async db => {
      const { query } = await this.packedTextQuery<TableProvenTxReq>(db, 'proven_tx_reqs', fixed, value =>
        this.findProvenTxReqsQuery({ ...fixed, ...value })
      )
      return await query.whereExists(
        db
          .select(1)
          .from('transactions')
          .whereRaw('proven_tx_reqs.txid = transactions.txid')
          .where('transactions.userId', userId)
      )
    })
    return this.validateEntities(rows, undefined, ['notified', 'wasBroadcast'])
  }

  override async findOutputBasketsAuth(auth: AuthId, args: FindOutputBasketsArgs): Promise<TableOutputBasket[]> {
    if (
      auth.userId == null ||
      (args.partial.userId != null && args.partial.userId !== 0 && args.partial.userId !== auth.userId)
    )
      throw new WERR_UNAUTHORIZED()
    args.partial.userId = auth.userId
    return await this.findOutputBaskets(args)
  }

  override async findOutputsAuth(auth: AuthId, args: FindOutputsArgs): Promise<TableOutput[]> {
    if (
      auth.userId == null ||
      (args.partial.userId != null && args.partial.userId !== 0 && args.partial.userId !== auth.userId)
    )
      throw new WERR_UNAUTHORIZED()
    args.partial.userId = auth.userId
    return await this.findOutputs(args)
  }

  override async findCertificateFields(args: FindCertificateFieldsArgs): Promise<TableCertificateField[]> {
    const fixed = { ...args, partial: { ...args.partial } },
      rows = await this.readPackedWalletRows<TableCertificateField>('certificate_fields', fixed.trx, async db => {
        const { query } = await this.packedTextQuery<TableCertificateField>(db, 'certificate_fields', fixed, value =>
          this.findCertificateFieldsQuery({ ...fixed, ...value })
        )
        return await query
      })
    return this.validateEntities(rows)
  }

  override async findCertificates(args: FindCertificatesArgs): Promise<TableCertificateX[]> {
    const fixed = { ...args, partial: { ...args.partial } },
      rows = await this.readPackedWalletRows<TableCertificateX>(
        'certificates',
        fixed.trx,
        async db => {
          const { query } = await this.packedTextQuery<TableCertificate>(db, 'certificates', fixed, value =>
            this.findCertificatesQuery({ ...fixed, ...value })
          )
          return await query
        },
        async (rows, db) => {
          if (fixed.includeFields === true)
            for (const certificate of rows)
              certificate.fields = await this.findCertificateFields({
                partial: { certificateId: certificate.certificateId, userId: certificate.userId },
                trx: db
              })
        }
      )
    return this.validateEntities(rows, undefined, ['isDeleted'])
  }

  override async findCommissions(args: FindCommissionsArgs): Promise<TableCommission[]> {
    const fixed = { ...args, partial: { ...args.partial } },
      rows = await this.readPackedWalletRows<TableCommission>('commissions', fixed.trx, async db => {
        const { query } = await this.packedTextQuery<TableCommission>(db, 'commissions', fixed, value =>
          this.findCommissionsQuery({ ...fixed, ...value })
        )
        return await query
      })
    return this.validateEntities(rows, undefined, ['isRedeemed'])
  }

  override async findOutputBaskets(args: FindOutputBasketsArgs): Promise<TableOutputBasket[]> {
    const q = this.findOutputBasketsQuery(args)
    const r = await q
    return this.validateEntities(r, undefined, ['isDeleted'])
  }

  override async findOutputs(args: FindOutputsArgs): Promise<TableOutput[]> {
    const r = await this.readPackedWalletRows<TableOutput>(
      'outputs',
      args.trx,
      async db => {
        const { query } = await this.packedTextQuery<TableOutput>(db, 'outputs', args, value =>
          this.findOutputsQuery({ ...args, ...value })
        )
        return await query
      },
      async (rows, db) => {
        if (args.noScript !== true) for (const row of rows) await this.validateOutputScript(row, db)
      }
    )
    return this.validateEntities(r, undefined, ['spendable', 'change'])
  }

  override async findOutputTagMaps(args: FindOutputTagMapsArgs): Promise<TableOutputTagMap[]> {
    const q = this.findOutputTagMapsQuery(args)
    const r = await q
    return this.validateEntities(r, undefined, ['isDeleted'])
  }

  override async findOutputTags(args: FindOutputTagsArgs): Promise<TableOutputTag[]> {
    const q = this.findOutputTagsQuery(args)
    const r = await q
    return this.validateEntities(r, undefined, ['isDeleted'])
  }

  override async findProvenTxReqs(args: FindProvenTxReqsArgs): Promise<TableProvenTxReq[]> {
    const fixed = { ...args, partial: { ...args.partial } }
    const r = await this.readPackedWalletRows<TableProvenTxReq>('proven_tx_reqs', fixed.trx, async db => {
      const { query } = await this.packedTextQuery<TableProvenTxReq>(db, 'proven_tx_reqs', fixed, value =>
        this.findProvenTxReqsQuery({ ...fixed, ...value })
      )
      // Shared request history/notifications are read/modify/write data across
      // profiles. Use a current locked read, not MySQL's earlier role snapshot.
      if (
        fixed.trx != null &&
        !readSnapshotTransactions.has(fixed.trx) &&
        (this.dbtype === 'MySQL' || this.dbtype === 'Postgres') &&
        (fixed.partial.provenTxReqId != null || fixed.partial.txid != null)
      )
        query.forUpdate()
      return await query
    })
    return this.validateEntities(r, undefined, ['notified', 'wasBroadcast'])
  }

  override async getProvenTxsReviewStartHeight(): Promise<number | undefined> {
    const [row] = await this.toDb()('proven_txs').min('height as minimum')
    return row.minimum == null ? undefined : Number(row.minimum)
  }

  override async findProvenTxs(args: FindProvenTxsArgs): Promise<TableProvenTx[]> {
    const q = this.findProvenTxsQuery(args)
    // Writable exact-proof lookups are read/modify/write authority checks.
    // Snapshot views use consistent reads; MySQL rejects FOR UPDATE in READ ONLY.
    if (
      args.trx != null &&
      !readSnapshotTransactions.has(args.trx) &&
      this.dbtype === 'MySQL' &&
      (args.partial.txid != null || args.partial.provenTxId != null)
    )
      q.forUpdate()
    const r = await this.readPackedWalletRows<TableProvenTx>('proven_txs', args.trx, async db => {
      if (db === this.toDb(args.trx)) return await q
      return await this.findProvenTxsQuery({ ...args, trx: db })
    })
    return this.validateEntities(r)
  }

  override async findStaleMerkleRoots(args: FindStaleMerkleRootsArgs): Promise<string[]> {
    const q = this.findStaleMerkleRootsQuery(args)
    const r = await q
    return r.map((row: { merkleRoot: string }) => row.merkleRoot)
  }

  override async findSyncStates(args: FindSyncStatesArgs): Promise<TableSyncState[]> {
    const fixed = { ...args, partial: { ...args.partial } }
    const r = await this.readPackedWalletRows<TableSyncState>('sync_states', fixed.trx, async db => {
      const { query } = await this.packedTextQuery<TableSyncState>(db, 'sync_states', fixed, value =>
        this.findSyncStatesQuery({ ...fixed, ...value })
      )
      // Preserve the original writable checkpoint serialization on SQL servers.
      if (
        fixed.trx != null &&
        !readSnapshotTransactions.has(fixed.trx) &&
        (this.dbtype === 'MySQL' || this.dbtype === 'Postgres') &&
        fixed.partial.userId != null &&
        (fixed.partial.syncStateId != null || fixed.partial.storageIdentityKey != null)
      )
        query.forUpdate()
      return await query
    })
    return this.validateEntities(r, ['when'], ['init'])
  }

  override async findTransactions(args: FindTransactionsArgs): Promise<TableTransaction[]> {
    const r = await this.readPackedWalletRows<TableTransaction>(
      'transactions',
      args.trx,
      async db => {
        const { query } = await this.packedTextQuery<TableTransaction>(db, 'transactions', args, value =>
          this.findTransactionsQuery({ ...args, ...value })
        )
        return await query
      },
      async (rows, db) => {
        if (args.noRawTx !== true) for (const row of rows) await this.validateRawTransaction(row, db)
      }
    )
    return this.validateEntities(r, undefined, ['isOutgoing'])
  }

  override async findTxLabelMaps(args: FindTxLabelMapsArgs): Promise<TableTxLabelMap[]> {
    const q = this.findTxLabelMapsQuery(args)
    const r = await q
    return this.validateEntities(r, undefined, ['isDeleted'])
  }

  override async findTxLabels(args: FindTxLabelsArgs): Promise<TableTxLabel[]> {
    const q = this.findTxLabelsQuery(args)
    const r = await q
    return this.validateEntities(r, undefined, ['isDeleted'])
  }

  override async findUsers(args: FindUsersArgs): Promise<TableUser[]> {
    const q = this.findUsersQuery(args)
    const r = await q
    return this.validateEntities(r)
  }

  override async recentlyActiveUsers(limit = 50, trx?: TrxToken): Promise<TableUser[]> {
    await this.verifyReadyForDatabaseAccess(trx)
    const latestOutputs = this.toDb(trx)('outputs as o')
      .select('o.userId')
      .max({ lastOutputCreatedAt: 'o.created_at' })
      .groupBy('o.userId')
      .as('latest_outputs')

    const rows = await this.toDb(trx)('users as u')
      .join(latestOutputs, 'u.userId', 'latest_outputs.userId')
      .select('u.*')
      .orderBy('latest_outputs.lastOutputCreatedAt', 'desc')
      .limit(limit)

    return this.validateEntities(rows as TableUser[])
  }

  private localMonitorQuery(db: Knex, packed: boolean, args: FindMonitorEventsArgs): Knex.QueryBuilder {
    const partial = { ...args.partial },
      details = partial.details
    if (packed && typeof details === 'string') delete partial.details
    const query = this.findMonitorEventsQuery({ ...args, partial, trx: db })
    if (packed && typeof details === 'string')
      applyBrc38NativeLocalPackedTextWhere(query, 'monitor_events', 'details', details)
    return query
  }

  override async findMonitorEvents(args: FindMonitorEventsArgs): Promise<TableMonitorEvent[]> {
    const fixed = { ...args, partial: { ...args.partial } },
      rows = await this.readLocalPackedWalletRows<TableMonitorEvent>(
        'monitor_events',
        fixed.trx,
        async (db, packed) => await this.localMonitorQuery(db, packed, fixed)
      )
    return this.validateEntities(rows, ['when'])
  }

  async getCount<T extends object>(q: Knex.QueryBuilder<T, T[]>): Promise<number> {
    // Alias the count: the default result key differs by dialect, and Postgres
    // returns count(*) as a bigint string.
    // A paged find query orders its rows; an aggregate cannot keep that order on Postgres.
    void q.clearOrder().count({ count: '*' })
    const r = await q
    return Number(r[0].count)
  }

  override async countCertificateFields(args: FindCertificateFieldsArgs): Promise<number> {
    const fixed = { ...args, partial: { ...args.partial } }
    return await withBrc38NativePackedWalletTransaction(this.toDb(fixed.trx), async db => {
      const { query } = await this.packedTextQuery<TableCertificateField>(db, 'certificate_fields', fixed, value =>
        this.findCertificateFieldsQuery({ ...fixed, ...value })
      )
      return await this.getCount(query)
    })
  }

  override async countCertificates(args: FindCertificatesArgs): Promise<number> {
    const fixed = { ...args, partial: { ...args.partial } }
    return await withBrc38NativePackedWalletTransaction(this.toDb(fixed.trx), async db => {
      const { query } = await this.packedTextQuery<TableCertificate>(db, 'certificates', fixed, value =>
        this.findCertificatesQuery({ ...fixed, ...value })
      )
      return await this.getCount(query)
    })
  }

  override async countCommissions(args: FindCommissionsArgs): Promise<number> {
    const fixed = { ...args, partial: { ...args.partial } }
    return await withBrc38NativePackedWalletTransaction(this.toDb(fixed.trx), async db => {
      const { query } = await this.packedTextQuery<TableCommission>(db, 'commissions', fixed, value =>
        this.findCommissionsQuery({ ...fixed, ...value })
      )
      return await this.getCount(query)
    })
  }

  override async countOutputBaskets(args: FindOutputBasketsArgs): Promise<number> {
    return await this.getCount(this.findOutputBasketsQuery(args))
  }

  override async countOutputs(args: FindOutputsArgs): Promise<number> {
    const fixed = { ...args, partial: { ...args.partial } }
    return await withBrc38NativePackedWalletTransaction(this.toDb(fixed.trx), async db => {
      const { query } = await this.packedTextQuery<TableOutput>(db, 'outputs', fixed, value =>
        this.findOutputsQuery({ ...fixed, ...value }, true)
      )
      return await this.getCount(query)
    })
  }

  override async countOutputTagMaps(args: FindOutputTagMapsArgs): Promise<number> {
    return await this.getCount(this.findOutputTagMapsQuery(args))
  }

  override async countOutputTags(args: FindOutputTagsArgs): Promise<number> {
    return await this.getCount(this.findOutputTagsQuery(args))
  }

  override async countProvenTxReqs(args: FindProvenTxReqsArgs): Promise<number> {
    const fixed = { ...args, partial: { ...args.partial } }
    return await withBrc38NativePackedWalletTransaction(this.toDb(fixed.trx), async db => {
      const { query } = await this.packedTextQuery<TableProvenTxReq>(db, 'proven_tx_reqs', fixed, value =>
        this.findProvenTxReqsQuery({ ...fixed, ...value })
      )
      return await this.getCount(query)
    })
  }

  override async countProvenTxs(args: FindProvenTxsArgs): Promise<number> {
    return await this.getCount(this.findProvenTxsQuery(args))
  }

  override async countSyncStates(args: FindSyncStatesArgs): Promise<number> {
    const fixed = { ...args, partial: { ...args.partial } }
    return await withBrc38NativePackedWalletTransaction(this.toDb(fixed.trx), async db => {
      const { query } = await this.packedTextQuery<TableSyncState>(db, 'sync_states', fixed, value =>
        this.findSyncStatesQuery({ ...fixed, ...value })
      )
      return await this.getCount(query)
    })
  }

  override async countTransactions(args: FindTransactionsArgs): Promise<number> {
    const fixed = { ...args, partial: { ...args.partial } }
    return await withBrc38NativePackedWalletTransaction(this.toDb(fixed.trx), async db => {
      const { query } = await this.packedTextQuery<TableTransaction>(db, 'transactions', fixed, value =>
        this.findTransactionsQuery({ ...fixed, ...value }, true)
      )
      return await this.getCount(query)
    })
  }

  override async countTxLabelMaps(args: FindTxLabelMapsArgs): Promise<number> {
    return await this.getCount(this.findTxLabelMapsQuery(args))
  }

  override async countTxLabels(args: FindTxLabelsArgs): Promise<number> {
    return await this.getCount(this.findTxLabelsQuery(args))
  }

  override async countUsers(args: FindUsersArgs): Promise<number> {
    return await this.getCount(this.findUsersQuery(args))
  }

  override async countMonitorEvents(args: FindMonitorEventsArgs): Promise<number> {
    const fixed = { ...args, partial: { ...args.partial } }
    return await withBrc38NativeLocalPackedWalletTransaction(
      this.toDb(fixed.trx),
      async (db, packed) => await this.getCount(this.localMonitorQuery(db, packed, fixed))
    )
  }

  override async destroy(): Promise<void> {
    try {
      await this.stopRetainedReadSnapshots()
    } catch (error) {
      // Preserve an ordinary read failure for its read consumer. A typed
      // cleanup failure remains observable after the pool destruction below.
      if (
        (this.guardedSnapshotFailure === undefined || this.guardedSnapshotFailure.error !== error) &&
        this.snapshotJournalCaptureFailure !== error &&
        this.snapshotJournalMaintenanceFailure !== error
      )
        throw error
    } finally {
      await this.stopPreparedBeefTasks()
      this.knex.off('query', this.onQuery)
      this.knex.off('query-response', this.onQueryResponse)
      this.knex.off('query-error', this.onQueryError)
      for (const span of this.querySpans.values()) span.end({ status: 'cancelled' })
      this.querySpans.clear()
      await this.knex?.destroy()
    }
    // The lifetime may have settled and cleared its slot before destroy runs.
    // A settled pool alone cannot prove that a failed native close succeeded.
    const failure = this.guardedSnapshotFailure?.error
    if (failure instanceof SnapshotArchiveSourceCleanupError) {
      if (!failure.cleanupCompleted) throw failure
      this.guardedSnapshotFailure = undefined
    }
    if (this.snapshotJournalCaptureFailure !== undefined) throw this.snapshotJournalCaptureFailure
    if (this.snapshotJournalMaintenanceFailure !== undefined) throw this.snapshotJournalMaintenanceFailure
    if (this.snapshotJournalWriterFailure !== undefined) throw this.snapshotJournalWriterFailure
  }

  override async migrate(storageName: string, storageIdentityKey: string): Promise<string> {
    // Check if this is a SQLite database by looking at the Knex client config
    const isSQLite = knexDatabaseSystem(this.knex.client) === 'sqlite'

    // For SQLite, turn foreign keys off for the duration of the migration.
    // PRAGMA foreign_keys is silently ignored *when executed inside* a
    // transaction (https://github.com/knex/knex/issues/4155), so it is issued
    // here, outside migrate.latest(). SQLite's single-connection pool means
    // knex's per-migration transaction runs on this same connection and
    // inherits the setting, and knex's own SQLite alter-table rebuild leaves an
    // ambient pragma alone while transacting (sqlite3/schema/ddl.js: alter()
    // uses `enforceForeignCheck = this.client.transacting ? null : false`).
    if (isSQLite) {
      await this.knex.raw('PRAGMA foreign_keys = OFF;')
    }
    try {
      const config = {
        migrationSource: new KnexMigrations(this.chain, storageName, storageIdentityKey, 1024),
        // Keep DDL and its migration journal entry in the same transaction.
        disableTransactions: false
      }
      await this.knex.migrate.latest(config)
      return await this.knex.migrate.currentVersion(config)
    } finally {
      // Leaving foreign-key enforcement disabled after a failed migration would
      // weaken every subsequent write on this connection.
      if (isSQLite) await this.knex.raw('PRAGMA foreign_keys = ON;')
    }
  }

  override async dropAllData(): Promise<void> {
    await assertSnapshotJournalOrdinaryDataDeletion(this.knex)
    if (this.snapshotAdmissionStopped)
      throw new WERR_INVALID_OPERATION('Storage data deletion is already active or source cleanup has failed')
    this.snapshotDataDeletionRunning = true
    try {
      await this.stopRetainedReadSnapshots(false)
      await this.stopPreparedBeefTasks()
      // Only using migrations to migrate down, don't need valid properties for settings table.
      const migrationSource = new KnexMigrations('test', '', '', 1024)
      migrationSource.migrations[PRIMARY_HANDOFF_MIGRATION].down = forSnapshotSqlDialect(
        dropPrimaryHandoffForDataDeletion
      )
      migrationSource.migrations[SNAPSHOT_SQLITE_INDEX_MIGRATION].down = dropGenerationForDataDeletion
      migrationSource.migrations[SNAPSHOT_JOURNAL_FIELD_CACHE_MIGRATION].down = forSnapshotSqlDialect(
        dropSnapshotJournalDestinationForDataDeletion
      )
      migrationSource.migrations[SNAPSHOT_JOURNAL_DESTINATION_MIGRATION].down = forSnapshotSqlDialect(
        dropSnapshotJournalDestinationForDataDeletion
      )
      migrationSource.migrations[SNAPSHOT_JOURNAL_SOURCE_MIGRATION].down = forSnapshotSqlDialect(
        dropSnapshotJournalSourceForDataDeletion
      )

      // Check if this is a SQLite database by looking at the Knex client config
      const isSQLite = knexDatabaseSystem(this.knex.client) === 'sqlite'

      // For SQLite, disable transactions during migrations and turn off foreign keys.
      // PRAGMA foreign_keys is silently ignored inside transactions, so we must
      // disable transactions for the migration to allow the PRAGMA to take effect.
      // See: https://github.com/knex/knex/issues/4155
      const config = {
        migrationSource,
        disableTransactions: isSQLite
      }
      const count = Object.keys(migrationSource.migrations).length

      // Disable foreign key checks for SQLite before dropping tables
      // This is necessary for better-sqlite3 which enforces FK constraints by default
      if (isSQLite) {
        await this.knex.raw('PRAGMA foreign_keys = OFF;')
      }

      try {
        // An interrupted, unpublished generation has no journal entry to roll back.
        // Explicit full deletion still removes its owned auxiliary schema first.
        // The journal migrations exist only on their supported SQL backends.
        // Preserve ordinary migration adapters and PostgreSQL cleanup without
        // routing them through SQLite/MySQL-specific journal DDL.
        const system = knexDatabaseSystem(this.knex.client)
        if (system === 'sqlite' || system === 'mysql') {
          await dropSnapshotJournalSourceForDataDeletion(this.knex)
          await dropSnapshotJournalDestinationForDataDeletion(this.knex)
        }
        await dropGenerationForDataDeletion(this.knex)
        for (let i = 0; i < count; i++) {
          const version = await this.knex.migrate.currentVersion(config)
          if (version === 'none') return
          const result = await this.knex.migrate.down(config)
          if (result == null) throw new WERR_INTERNAL('database migration rollback returned no result')
        }
        if ((await this.knex.migrate.currentVersion(config)) !== 'none') {
          throw new WERR_INTERNAL('database migration rollback did not reach the empty schema')
        }
      } finally {
        if (isSQLite) await this.knex.raw('PRAGMA foreign_keys = ON;')
      }
    } finally {
      this.snapshotDataDeletionRunning = false
    }
  }

  private readonly walletWriteAdmission = new KnexWalletWriteAdmission(this)
  override async supportsPreparedWalletWrites(): Promise<boolean> {
    return await this.supportsPrimaryWriteFences()
  }
  override async withPreparedWalletWrite<T>(
    auth: AuthId,
    admission: StorageWriterAdmission,
    operation: () => Promise<T>
  ): Promise<T> {
    return await this.walletWriteAdmission.run(auth, admission, operation)
  }

  private async primaryWriteFenceInstalled(): Promise<boolean> {
    if (this.snapshotAdmissionStopped) throw new WERR_INVALID_OPERATION('Active wallet writer admission is stopped')
    await this.makeAvailable()
    const client = String(this.knex.client.config.client)
    if (
      (!this.snapshotSyncEnabled && !(await hasKnexPrimaryEnrollment(this))) ||
      (!['sqlite3', 'better-sqlite3', 'mysql', 'mysql2'].includes(client) &&
        ownedNativeRootIdentity(this.knex)?.slot !== 0)
    )
      return false
    const table = this.knex.client.config.migrations?.tableName ?? 'knex_migrations'
    const installed = await this.knex.schema.hasTable('snapshot_sync_primary_epochs')
    const entries: Array<{ name: string }> = await this.knex(table)
      .where('name', SNAPSHOT_SYNC_MIGRATION)
      .select('name')
      .limit(2)
    if (!installed && entries.length === 0) return false
    if (!installed || entries.length !== 1)
      throw new WERR_INVALID_OPERATION('Active wallet primary fence migration is incomplete')
    return true
  }

  override async assertFinancialDataWriteAdmission(
    identityKey: string,
    sourceStorageIdentityKey: string | undefined,
    trx: TrxToken
  ): Promise<void> {
    await assertKnexPrimaryDataWrite(this, this.toDb(trx) as Knex.Transaction, identityKey, sourceStorageIdentityKey)
  }

  override async activeStorageFromSync(userId: number, proposed: string, trx?: TrxToken): Promise<string> {
    return await this.transaction(
      async token => await primarySelectionFromKnexSync(this, this.toDb(token) as Knex.Transaction, userId, proposed),
      trx
    )
  }

  override async getPrimaryHandoffControl(
    options: PrimaryHandoffControlOptions = {}
  ): Promise<PrimaryHandoffControl | undefined> {
    if (!(await this.supportsPrimaryWriteFences())) return undefined
    const control = await createKnexPrimaryHandoffControl(this, options)
    if (control === undefined) return undefined
    if (!(await this.supportsSnapshotJournalSync())) {
      if (await hasKnexPrimaryEnrollment(this))
        throw new WERR_INVALID_OPERATION('Enrolled primary control requires its actual journal backend')
      return undefined
    }
    return control
  }

  override async supportsPrimaryWriteFences(): Promise<boolean> {
    if (!(await this.primaryWriteFenceInstalled())) return false
    await verifySnapshotSyncPrimaryFence(this.knex)
    return true
  }

  override async activeWriteTransaction(auth: AuthId): Promise<StorageActiveWrite> {
    const admitted = this.walletWriteAdmission.captured(auth)
    if (admitted !== undefined) return admitted
    if (!(await this.primaryWriteFenceInstalled())) return await super.activeWriteTransaction(auth)
    return await captureKnexActiveWrite(this, auth, () => !this.snapshotAdmissionStopped)
  }

  protected override async *completedProofRequests(): AsyncIterable<TableProvenTxReq> {
    let after = 0
    for (;;) {
      const ids: Array<{ provenTxReqId: number }> = await this.knex('proven_tx_reqs')
        .select('provenTxReqId')
        .where({ status: 'completed', notified: false })
        .where('provenTxReqId', '>', after)
        .orderBy('provenTxReqId')
        .limit(100)
      if (!ids.length) return
      for (const { provenTxReqId } of ids) {
        const reqs = await this.findProvenTxReqs({ partial: { provenTxReqId } })
        const req = reqs[0]
        if (req?.status === 'completed' && req.notified === false) yield req
        after = provenTxReqId
      }
    }
  }

  override async transaction<T>(scope: (trx: TrxToken) => Promise<T>, trx?: TrxToken): Promise<T> {
    if (trx != null) return await scope(trx)

    return await this.knex.transaction<T>(async knextrx => {
      const trx = knextrx as TrxToken
      return await scope(trx)
    })
  }

  /**
   * Convert the standard optional `TrxToken` parameter into either a direct knex database instance,
   * or a Knex.Transaction as appropriate.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toDb(trx?: TrxToken): Knex | Knex.Transaction<any, any[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = trx == null ? this.knex : (trx as Knex.Transaction<any, any[]>)
    this.whenLastAccess = new Date()
    return db
  }

  async validateRawTransaction(t: TableTransaction, trx?: TrxToken): Promise<void> {
    // if there is no txid or there is a rawTransaction return what we have.
    if (t.rawTx != null || t.txid == null || t.txid === '') return

    // rawTransaction is missing, see if we moved it ...

    const rawTx = await this.getRawTxOfKnownValidTransaction(t.txid, undefined, undefined, trx)
    if (rawTx == null) return
    t.rawTx = rawTx
  }

  _verifiedReadyForDatabaseAccess: boolean = false

  /**
   * Make sure database is ready for access:
   *
   * - dateScheme is known
   * - foreign key constraints are enabled
   *
   * @param trx
   */
  async verifyReadyForDatabaseAccess(trx?: TrxToken): Promise<DBType> {
    this._settings ??= await this.readSettings(trx)

    // Always run the PRAGMA for SQLite to ensure foreign key constraints are enabled.
    // This is necessary because PRAGMA foreign_keys is a per-connection setting,
    // and connection pools may create new connections that don't have it set.
    // The performance impact is minimal as SQLite handles this efficiently.
    if (this._settings.dbtype === 'SQLite') {
      await this.toDb(trx).raw('PRAGMA foreign_keys = ON;')
    }

    this._verifiedReadyForDatabaseAccess = true

    return this._settings.dbtype
  }

  /** Convert every byte-array value to a Buffer and every undefined to null on an arbitrary object. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private serialiseForKnex(v: any): void {
    for (const key of Object.keys(v)) {
      const val = v[key]
      if (Array.isArray(val) && (val.length === 0 || typeof val[0] === 'number')) {
        v[key] = Buffer.from(val)
      } else if (val instanceof Uint8Array) {
        v[key] = Buffer.from(val.buffer, val.byteOffset, val.byteLength)
      } else if (val === undefined) {
        v[key] = null
      }
    }
  }

  /** Apply optional date-field coercion list in-place. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private coerceDateFields(v: any, dateFields?: string[]): void {
    if (dateFields == null) return
    for (const df of dateFields) {
      if (v[df] != null) v[df] = this.validateOptionalEntityDate(v[df])
    }
  }

  /** Apply optional boolean-field coercion list in-place. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private coerceBooleanFields(v: any, booleanFields?: string[]): void {
    if (booleanFields == null) return
    for (const df of booleanFields) {
      if (v[df] !== undefined) v[df] = (v[df] as unknown) != null && (v[df] as unknown) !== false ? 1 : 0
    }
  }

  /**
   * Helper to force uniform behavior across database engines.
   * Use to process the update template for entities being updated.
   */
  validatePartialForUpdate<T extends EntityTimeStamp>(
    update: Partial<T>,
    dateFields?: string[],
    booleanFields?: string[]
  ): Partial<T> {
    if (this.dbtype == null) throw new WERR_INTERNAL('must call verifyReadyForDatabaseAccess first')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v: any = update
    if (v.created_at != null) v.created_at = this.validateEntityDate(v.created_at)
    if (v.updated_at != null) v.updated_at = this.validateEntityDate(v.updated_at)
    if (v.created_at == null) delete v.created_at
    v.updated_at ??= this.validateEntityDate(new Date())
    this.coerceDateFields(v, dateFields)
    this.coerceBooleanFields(update, booleanFields)
    this.serialiseForKnex(v)
    this.isDirty = true
    return v
  }

  /**
   * Helper to force uniform behavior across database engines.
   * Use to process new entities being inserted into the database.
   */
  async validateEntityForInsert<T extends EntityTimeStamp>(
    entity: T,
    trx?: TrxToken,
    dateFields?: string[],
    booleanFields?: string[]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    await this.verifyReadyForDatabaseAccess(trx)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v: any = { ...entity }
    v.created_at = this.validateOptionalEntityDate(v.created_at, true) ?? new Date()
    v.updated_at = this.validateOptionalEntityDate(v.updated_at, true) ?? new Date()
    if (v.created_at == null) delete v.created_at
    if (v.updated_at == null) delete v.updated_at
    this.coerceDateFields(v, dateFields)
    this.coerceBooleanFields(entity, booleanFields)
    this.serialiseForKnex(v)
    this.isDirty = true
    return v
  }

  override async getLabelsForTransactionId(transactionId?: number, trx?: TrxToken): Promise<TableTxLabel[]> {
    if (transactionId === undefined) return []
    const labels = await this.toDb(trx)<TableTxLabel>('tx_labels')
      .join('tx_labels_map', 'tx_labels_map.txLabelId', 'tx_labels.txLabelId')
      .where('tx_labels_map.transactionId', transactionId)
      .whereNot('tx_labels_map.isDeleted', true)
      .whereNot('tx_labels.isDeleted', true)
    return this.validateEntities(labels, undefined, ['isDeleted'])
  }

  override async getTagsForOutputId(outputId: number, trx?: TrxToken): Promise<TableOutputTag[]> {
    const tags = await this.toDb(trx)<TableOutputTag>('output_tags')
      .join('output_tags_map', 'output_tags_map.outputTagId', 'output_tags.outputTagId')
      .where('output_tags_map.outputId', outputId)
      .whereNot('output_tags_map.isDeleted', true)
      .whereNot('output_tags.isDeleted', true)
    return this.validateEntities(tags, undefined, ['isDeleted'])
  }

  override async purgeData(params: PurgeParams, trx?: TrxToken): Promise<PurgeResults> {
    return await purgeData(this, params, trx)
  }

  override async reviewStatus(args: StorageStatusReviewArgs): Promise<{ log: string }> {
    return await reviewStatus(this, args)
  }

  /**
   * Counts wallet-managed BRC-29 change outputs for userId in basketId that
   * are currently eligible for automatic allocation
   * AND whose transaction status is one of:
   * - completed
   * - unproven
   * - sending (if excludeSending is false)
   */
  async countChangeInputs(userId: number, basketId: number, excludeSending: boolean): Promise<number> {
    const status: TransactionStatus[] = ['completed', 'unproven']
    if (!excludeSending) status.push('sending')
    const now = new Date()
    return await withBrc38NativePackedWalletTransaction(this.knex, async db => {
      const q = db<TableOutput>('outputs as o')
        .join('transactions as t', 'o.transactionId', 't.transactionId')
        .where({
          'o.userId': userId,
          'o.spendable': true,
          'o.basketId': basketId,
          'o.change': managedChangeOutputFields.change,
          'o.providedBy': managedChangeOutputFields.providedBy
        })
        .whereNull('o.spentBy')
        .whereNotExists(function () {
          void this.select(1)
            .from('action_batch_outputs as abo')
            .join('action_batches as ab', 'abo.actionBatchId', 'ab.actionBatchId')
            // ?? quotes identifiers: Postgres lowercases unquoted names, so camelCase columns must be quoted.
            .whereRaw('?? = ??', ['abo.outputId', 'o.outputId'])
            .whereIn('ab.status', ['active', 'prepared'])
            .where('ab.expiresAt', '>', now)
            .where('ab.hardExpiresAt', '>', now)
        })
        .whereIn('t.status', status)
      await applyBrc38NativeManagedChangeText(db, q)
      return await this.getCount(q)
    })
  }

  override async findAvailableManagedChangeInputs(
    userId: number,
    basketId: number,
    excludeSending: boolean,
    trx?: TrxToken
  ): Promise<TableOutput[]> {
    const statuses: TransactionStatus[] = ['completed', 'unproven']
    if (!excludeSending) statuses.push('sending')
    const now = new Date()
    const rows = await this.readPackedWalletRows<TableOutput>('outputs', trx, async db => {
      const query = db<TableOutput>('outputs as o')
        .join('transactions as t', 'o.transactionId', 't.transactionId')
        .where({
          'o.userId': userId,
          'o.basketId': basketId,
          'o.spendable': true,
          'o.change': managedChangeOutputFields.change,
          'o.providedBy': managedChangeOutputFields.providedBy
        })
        .whereNull('o.spentBy')
        .whereNotExists(function () {
          void this.select(1)
            .from('action_batch_outputs as abo')
            .join('action_batches as ab', 'abo.actionBatchId', 'ab.actionBatchId')
            // ?? quotes identifiers: Postgres lowercases unquoted names, so camelCase columns must be quoted.
            .whereRaw('?? = ??', ['abo.outputId', 'o.outputId'])
            .whereIn('ab.status', ['active', 'prepared'])
            .where('ab.expiresAt', '>', now)
            .where('ab.hardExpiresAt', '>', now)
        })
        .whereIn('t.status', statuses)
        .select(outputColumnsWithoutLockingScript.map(column => `o.${column}`))
      await applyBrc38NativeManagedChangeText(db, query)
      return await query
    })
    return this.validateEntities(rows, undefined, ['spendable', 'change'])
  }

  override async findAvailableManagedChangeInputCandidates(
    userId: number,
    basketId: number,
    excludeSending: boolean,
    trx?: TrxToken
  ): Promise<ManagedChangeInputCandidate[]> {
    const statuses: TransactionStatus[] = ['completed', 'unproven']
    if (!excludeSending) statuses.push('sending')
    const now = new Date()
    return await withBrc38NativePackedWalletTransaction(this.toDb(trx), async db => {
      const query = db<ManagedChangeInputCandidate>('outputs as o')
        .join('transactions as t', 'o.transactionId', 't.transactionId')
        .where({
          'o.userId': userId,
          'o.basketId': basketId,
          'o.spendable': true,
          'o.change': managedChangeOutputFields.change,
          'o.providedBy': managedChangeOutputFields.providedBy
        })
        .whereNull('o.spentBy')
        .whereNotExists(function () {
          void this.select(1)
            .from('action_batch_outputs as abo')
            .join('action_batches as ab', 'abo.actionBatchId', 'ab.actionBatchId')
            // ?? quotes identifiers: Postgres lowercases unquoted names, so camelCase columns must be quoted.
            .whereRaw('?? = ??', ['abo.outputId', 'o.outputId'])
            .whereIn('ab.status', ['active', 'prepared'])
            .where('ab.expiresAt', '>', now)
            .where('ab.hardExpiresAt', '>', now)
        })
        .whereIn('t.status', statuses)
        .select('o.outputId', 'o.transactionId', 'o.satoshis', 'o.txid', 'o.vout', 't.status as transactionStatus')
      await applyBrc38NativeManagedChangeText(db, query)
      return await query
    })
  }

  override async findOutputsByIds(outputIds: number[], trx?: TrxToken): Promise<Record<number, TableOutput>> {
    const byId: Record<number, TableOutput> = {}
    if (outputIds.length < 1) return byId
    const rows = await this.readPackedWalletRows<TableOutput>(
      'outputs',
      trx,
      async db => await db<TableOutput>('outputs').whereIn('outputId', outputIds).select('*'),
      async (rows, db) => {
        for (const row of rows) await this.validateOutputScript(row, db)
      }
    )
    const vrows = this.validateEntities(rows, undefined, ['spendable', 'change'])
    for (const row of vrows) {
      if (row.outputId !== undefined) byId[row.outputId] = row
    }
    return byId
  }

  override async findOutputsByOutpoints(
    userId: number,
    outpoints: Array<{ txid: string; vout: number }>,
    trx?: TrxToken
  ): Promise<Record<string, TableOutput>> {
    const byOutpoint: Record<string, TableOutput> = {}
    if (outpoints.length < 1) return byOutpoint
    const outpointSet = new Set(outpoints.map(o => `${o.txid}.${o.vout}`))
    const txids = [...new Set(outpoints.map(o => o.txid))]
    const vouts = [...new Set(outpoints.map(o => o.vout))]
    const rows = await this.readPackedWalletRows<TableOutput>(
      'outputs',
      trx,
      async db =>
        (
          await db<TableOutput>('outputs')
            .where('userId', userId)
            .whereIn('txid', txids)
            .whereIn('vout', vouts)
            .select('*')
        ).filter(row => outpointSet.has(`${String(row.txid)}.${String(row.vout)}`)),
      async (rows, db) => {
        for (const row of rows) await this.validateOutputScript(row, db)
      }
    )
    // Only return requested outpoints, vouts of one txid may end up matching another txid that was not requested.
    const filteredRows = rows.filter(r => outpointSet.has(`${String(r.txid)}.${String(r.vout)}`))
    const vrows = this.validateEntities(filteredRows, undefined, ['spendable', 'change'])
    for (const row of vrows) {
      byOutpoint[`${String(row.txid)}.${String(row.vout)}`] = row
    }
    return byOutpoint
  }

  override async findOutputsByOutpointsForUpdate(
    userId: number,
    outpoints: Array<{ txid: string; vout: number }>,
    trx: TrxToken,
    noScript = false
  ): Promise<Record<string, TableOutput>> {
    const byOutpoint: Record<string, TableOutput> = {}
    if (outpoints.length < 1) return byOutpoint
    const outpointSet = new Set(outpoints.map(o => `${o.txid}.${o.vout}`))
    const rows = await this.readPackedWalletRows<TableOutput>(
      'outputs',
      trx,
      async db =>
        (
          await db<TableOutput>('outputs')
            .where('userId', userId)
            .whereIn('txid', [...new Set(outpoints.map(o => o.txid))])
            .whereIn('vout', [...new Set(outpoints.map(o => o.vout))])
            .select<TableOutput[]>(noScript ? outputColumnsWithoutLockingScript : ['*'])
            .forUpdate()
        ).filter(row => outpointSet.has(`${String(row.txid)}.${String(row.vout)}`)),
      async (rows, db) => {
        if (!noScript) for (const row of rows) await this.validateOutputScript(row, db)
      }
    )
    const filteredRows = rows.filter(r => outpointSet.has(`${String(r.txid)}.${String(r.vout)}`))
    for (const row of this.validateEntities(filteredRows, undefined, ['spendable', 'change'])) {
      byOutpoint[`${String(row.txid)}.${String(row.vout)}`] = row
    }
    return byOutpoint
  }

  override async findTransactionStatusesByIds(
    userId: number,
    transactionIds: number[],
    trx?: TrxToken
  ): Promise<Map<number, TransactionStatus>> {
    const statuses = new Map<number, TransactionStatus>()
    if (transactionIds.length === 0) return statuses
    const rows = await this.toDb(trx)<Pick<TableTransaction, 'transactionId' | 'status'>>('transactions')
      .where('userId', userId)
      .whereIn('transactionId', [...new Set(transactionIds)])
      .select('transactionId', 'status')
    for (const row of rows) statuses.set(row.transactionId, row.status)
    return statuses
  }

  override async findFundingOutputsForUpdate(
    userId: number,
    outputIds: number[],
    statuses: TransactionStatus[],
    trx: TrxToken
  ): Promise<Record<number, TableOutput>> {
    const byId: Record<number, TableOutput> = {}
    if (outputIds.length === 0) return byId
    const uniqueOutputIds = [...new Set(outputIds)].sort((a, b) => a - b)
    // Lock source outputs through their primary key first. A single joined
    // SELECT ... FOR UPDATE caused PXC to lock one joined row at a time and
    // turned a 150-input claim into a ~220 ms statement. Transaction status
    // and action-batch reservations are then checked under the same database
    // transaction; action-batch reservation follows the same output-first lock
    // order, so a concurrent reserver cannot pass after this claim commits.
    const rows = await this.readPackedWalletRows<TableOutput>(
      'outputs',
      trx,
      async db =>
        await db<TableOutput>('outputs as o')
          .where('o.userId', userId)
          .whereIn('o.outputId', uniqueOutputIds)
          .select('o.*')
          .forUpdate()
    )
    const transactionIds = [...new Set(rows.map(output => output.transactionId))].sort((a, b) => a - b)
    const validTransactions =
      transactionIds.length === 0
        ? []
        : await this.toDb(trx)<Pick<TableTransaction, 'transactionId'>>('transactions')
            .where('userId', userId)
            .whereIn('transactionId', transactionIds)
            .whereIn('status', statuses)
            .select('transactionId')
            .forShare()
    const validTransactionIds = new Set(validTransactions.map(transaction => transaction.transactionId))
    const reservedOutputIds = new Set(await this.findReservedActionBatchOutputIds(uniqueOutputIds, trx))
    for (const output of this.validateEntities(rows, undefined, ['spendable', 'change'])) {
      if (!validTransactionIds.has(output.transactionId) || reservedOutputIds.has(output.outputId)) continue
      byId[output.outputId] = output
    }
    return byId
  }

  override async findOrInsertOutputBasketsBulk(
    userId: number,
    names: string[],
    trx?: TrxToken
  ): Promise<Record<string, TableOutputBasket>> {
    const byName: Record<string, TableOutputBasket> = {}
    if (names.length < 1) return byName
    const uniqueNames = [...new Set(names)]
    const existing = await this.toDb(trx)<TableOutputBasket>('output_baskets')
      .where('userId', userId)
      .whereIn('name', uniqueNames)
      .select('*')
    for (const basket of existing) {
      if (basket.isDeleted) await this.updateOutputBasket(verifyId(basket.basketId), { isDeleted: false }, trx)
      byName[basket.name] = basket
    }
    for (const name of uniqueNames) {
      byName[name] ??= await this.findOrInsertOutputBasket(userId, name, trx)
    }
    return byName
  }

  override async findOrInsertOutputTagsBulk(
    userId: number,
    tags: string[],
    trx?: TrxToken
  ): Promise<Record<string, TableOutputTag>> {
    const byTag: Record<string, TableOutputTag> = {}
    if (tags.length < 1) return byTag
    const uniqueTags = [...new Set(tags)]
    const existing = await this.toDb(trx)<TableOutputTag>('output_tags')
      .where('userId', userId)
      .whereIn('tag', uniqueTags)
      .select('*')
    for (const outputTag of existing) {
      if (outputTag.isDeleted) await this.updateOutputTag(verifyId(outputTag.outputTagId), { isDeleted: false }, trx)
      byTag[outputTag.tag] = outputTag
    }
    for (const tag of uniqueTags) {
      byTag[tag] ??= await this.findOrInsertOutputTag(userId, tag, trx)
    }
    return byTag
  }

  override async findOrInsertTxLabelsBulk(
    userId: number,
    labels: string[],
    trx?: TrxToken
  ): Promise<Record<string, TableTxLabel>> {
    const byLabel: Record<string, TableTxLabel> = {}
    if (labels.length < 1) return byLabel
    const uniqueLabels = [...new Set(labels)]
    const existing = await this.toDb(trx)<TableTxLabel>('tx_labels')
      .where('userId', userId)
      .whereIn('label', uniqueLabels)
      .select('*')
    for (const label of existing) {
      if (label.isDeleted) await this.updateTxLabel(verifyId(label.txLabelId), { isDeleted: false }, trx)
      byLabel[label.label] = label
    }
    for (const label of uniqueLabels) {
      byLabel[label] ??= await this.findOrInsertTxLabel(userId, label, trx)
    }
    return byLabel
  }

  override async sumSpendableSatoshisInBasket(
    userId: number,
    basketId: number,
    excludeSending: boolean,
    trx?: TrxToken
  ): Promise<number> {
    const status: TransactionStatus[] = ['completed', 'unproven']
    if (!excludeSending) status.push('sending')
    const row = await this.toDb(trx)<TableOutput>('outputs as o')
      .join('transactions as t', 'o.transactionId', 't.transactionId')
      .where({ 'o.userId': userId, 'o.spendable': true, 'o.basketId': basketId })
      .whereNull('o.spentBy')
      .whereIn('t.status', status)
      .sum({ totalSatoshis: 'o.satoshis' })
      .first()
    const total = row != null ? (row as Record<string, unknown>).totalSatoshis : undefined
    return Number(total ?? 0)
  }

  /**
   *  Finds closest matching available change output to use as input for new transaction.
   *
   * Transactionally allocate the output such that
   */
  async allocateChangeInput(
    userId: number,
    basketId: number,
    targetSatoshis: number,
    exactSatoshis: number | undefined,
    excludeSending: boolean,
    transactionId: number
  ): Promise<TableOutput | undefined> {
    const status: TransactionStatus[] = ['completed', 'unproven']
    if (!excludeSending) status.push('sending')

    let reservedConcurrently = false
    const r: TableOutput | undefined = await this.knex.transaction(async trx => {
      const baseQuery = (): Knex.QueryBuilder<TableOutput, TableOutput[]> =>
        trx<TableOutput>('outputs as o')
          .join('transactions as t', 'o.transactionId', 't.transactionId')
          .where('o.userId', userId)
          .where('o.spendable', true)
          .where('o.basketId', basketId)
          .where({
            'o.change': managedChangeOutputFields.change,
            'o.providedBy': managedChangeOutputFields.providedBy
          })
          .whereNull('o.spentBy')
          .whereNotExists(function () {
            // ?? quotes identifiers: Postgres lowercases unquoted names, so camelCase columns must be quoted.
            void this.select(1).from('action_batch_outputs as abo').whereRaw('?? = ??', ['abo.outputId', 'o.outputId'])
          })
          .whereIn('t.status', status)
          .select<TableOutput[]>('o.*')
          .forUpdate()

      const managedQuery = async (): Promise<{ query: Knex.QueryBuilder<TableOutput, TableOutput[]> }> => {
        const query = baseQuery()
        await applyBrc38NativeManagedChangeText(trx, query)
        return { query }
      }

      let output: TableOutput | undefined

      if (exactSatoshis !== undefined) {
        output = await (
          await managedQuery()
        ).query
          .where('o.satoshis', exactSatoshis)
          .orderBy('o.outputId', 'asc')
          .first()
      }

      output ??= await (
        await managedQuery()
      ).query
        .where('o.satoshis', '>=', targetSatoshis)
        .orderBy('o.satoshis', 'asc')
        .orderBy('o.outputId', 'asc')
        .first()

      output ??= await (
        await managedQuery()
      ).query
        .where('o.satoshis', '<', targetSatoshis)
        .orderBy('o.satoshis', 'desc')
        .orderBy('o.outputId', 'desc')
        .first()

      if (output == null) return undefined
      if (isOwnedNativeSqlite(trx))
        await withBrc38NativePackedWalletTransaction(trx, async (db, packed) => {
          if (packed) {
            const text = await hasBrc38NativePackedTextSchema(db as Knex.Transaction)
            if (text) await prechargeBrc38NativePackedTextWalletRows(db, 'outputs', [output!])
            await hydrateBrc38NativePackedWalletRows(db, 'outputs', [output!], true)
            if (text) await hydrateBrc38NativePackedTextWalletRows(db, 'outputs', [output!])
          }
        })

      // Under Postgres READ COMMITTED the NOT EXISTS above uses the statement's
      // snapshot, so an action batch reservation committed while the statement
      // waited for the row lock is not visible to it. Retry in a new transaction.
      if (
        this.dbtype === 'Postgres' &&
        (await this.findReservedActionBatchOutputIds([output.outputId], trx)).length > 0
      ) {
        reservedConcurrently = true
        return undefined
      }

      await this.updateOutput(
        output.outputId,
        {
          spendable: false,
          spentBy: transactionId
        },
        trx
      )

      // Keep behavior identical to the pre-optimization path: ensure lockingScript
      // is present even when it was offloaded from outputs into rawTx storage.
      await this.validateOutputScript(output, trx)

      output.spendable = false
      output.spentBy = transactionId
      return output
    })

    if (reservedConcurrently)
      return await this.allocateChangeInput(
        userId,
        basketId,
        targetSatoshis,
        exactSatoshis,
        excludeSending,
        transactionId
      )
    return r
  }

  override async markChangeInputsSpent(outputIds: number[], transactionId: number, trx: TrxToken): Promise<number> {
    if (outputIds.length === 0) return 0
    return await this.toDb(trx)<TableOutput>('outputs')
      .whereIn('outputId', outputIds)
      .where('spendable', true)
      .whereNull('spentBy')
      .update({ spendable: false, spentBy: transactionId })
  }

  /** Convert null→undefined and Buffer→number[] on a retrieved entity in-place. */
  private deserialiseFromKnex<T>(entity: T): void {
    for (const key of Object.keys(entity as object)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const val = (entity as any)[key]
      if (val === null) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(entity as any)[key] = undefined
      } else if (Buffer.isBuffer(val)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(entity as any)[key] = Array.from(val)
      }
    }
  }

  /**
   * Helper to force uniform behavior across database engines.
   * Use to process all individual records with time stamps retreived from database.
   */
  validateEntity<T extends EntityTimeStamp>(entity: T, dateFields?: string[], booleanFields?: string[]): T {
    entity.created_at = this.validateDate(entity.created_at)
    entity.updated_at = this.validateDate(entity.updated_at)
    if (dateFields != null) {
      for (const df of dateFields) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((entity as any)[df] != null) (entity as any)[df] = this.validateDate((entity as any)[df])
      }
    }
    if (booleanFields != null) {
      for (const df of booleanFields) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((entity as any)[df] !== undefined)
          (entity as any)[df] =
            (entity as any)[df] !== 0 && (entity as any)[df] != null && (entity as any)[df] !== false
      }
    }
    this.deserialiseFromKnex(entity)
    return entity
  }

  /**
   * Helper to force uniform behavior across database engines.
   * Use to process all arrays of records with time stamps retreived from database.
   * @returns input `entities` array with contained values validated.
   */
  validateEntities<T extends EntityTimeStamp>(entities: T[], dateFields?: string[], booleanFields?: string[]): T[] {
    for (let i = 0; i < entities.length; i++) {
      entities[i] = this.validateEntity(entities[i], dateFields, booleanFields)
    }
    return entities
  }

  async adminStats(adminIdentityKey: string): Promise<AdminStatsResult> {
    if (this.dbtype !== 'MySQL') throw new WERR_NOT_IMPLEMENTED('adminStats, only MySQL is supported')

    const monitorEvent = verifyOneOrNone(
      await this.findMonitorEvents({
        partial: { event: 'MonitorCallHistory' },
        orderDescending: true,
        paged: { limit: 1 }
      })
    )
    const monitorStats: ServicesCallHistory | undefined =
      monitorEvent != null ? JSON.parse(monitorEvent.details as string) : undefined
    const servicesStats = this.getServices().getServicesCallHistory(true)

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const oneMonthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

    const [
      [
        {
          usersDay,
          usersMonth,
          usersWeek,
          usersTotal,
          transactionsDay,
          transactionsMonth,
          transactionsWeek,
          transactionsTotal,
          txCompletedDay,
          txCompletedMonth,
          txCompletedWeek,
          txCompletedTotal,
          txFailedDay,
          txFailedMonth,
          txFailedWeek,
          txFailedTotal,
          txAbandonedDay,
          txAbandonedMonth,
          txAbandonedWeek,
          txAbandonedTotal,
          txUnprocessedDay,
          txUnprocessedMonth,
          txUnprocessedWeek,
          txUnprocessedTotal,
          txSendingDay,
          txSendingMonth,
          txSendingWeek,
          txSendingTotal,
          txUnprovenDay,
          txUnprovenMonth,
          txUnprovenWeek,
          txUnprovenTotal,
          txUnsignedDay,
          txUnsignedMonth,
          txUnsignedWeek,
          txUnsignedTotal,
          txNosendDay,
          txNosendMonth,
          txNosendWeek,
          txNosendTotal,
          txNonfinalDay,
          txNonfinalMonth,
          txNonfinalWeek,
          txNonfinalTotal,
          txUnfailDay,
          txUnfailMonth,
          txUnfailWeek,
          txUnfailTotal,
          satoshisDefaultDay,
          satoshisDefaultMonth,
          satoshisDefaultWeek,
          satoshisDefaultTotal,
          satoshisOtherDay,
          satoshisOtherMonth,
          satoshisOtherWeek,
          satoshisOtherTotal,
          basketsDay,
          basketsMonth,
          basketsWeek,
          basketsTotal,
          labelsDay,
          labelsMonth,
          labelsWeek,
          labelsTotal,
          tagsDay,
          tagsMonth,
          tagsWeek,
          tagsTotal
        }
      ]
    ] = await this.knex.raw(`
select
    (select count(*) from users where created_at > '${oneDayAgo}') as usersDay,
    (select count(*) from users where created_at > '${oneWeekAgo}') as usersWeek,
    (select count(*) from users where created_at > '${oneMonthAgo}') as usersMonth,
    (select count(*) from users) as usersTotal,
    (select count(*) from transactions where created_at > '${oneDayAgo}') as transactionsDay,
    (select count(*) from transactions where created_at > '${oneWeekAgo}') as transactionsWeek,
    (select count(*) from transactions where created_at > '${oneMonthAgo}') as transactionsMonth,
    (select count(*) from transactions) as transactionsTotal,
    (select count(*) from transactions where status = 'completed' and created_at > '${oneDayAgo}') as txCompletedDay,
    (select count(*) from transactions where status = 'completed' and created_at > '${oneWeekAgo}') as txCompletedWeek,
    (select count(*) from transactions where status = 'completed' and created_at > '${oneMonthAgo}') as txCompletedMonth,
    (select count(*) from transactions where status = 'completed') as txCompletedTotal,
    (select count(*) from transactions where status = 'failed' and not txid is null and created_at > '${oneDayAgo}') as txFailedDay,
    (select count(*) from transactions where status = 'failed' and not txid is null and created_at > '${oneWeekAgo}') as txFailedWeek,
    (select count(*) from transactions where status = 'failed' and not txid is null and created_at > '${oneMonthAgo}') as txFailedMonth,
    (select count(*) from transactions where status = 'failed' and not txid is null) as txFailedTotal,
    (select count(*) from transactions where status = 'failed' and txid is null and created_at > '${oneDayAgo}') as txAbandonedDay,
    (select count(*) from transactions where status = 'failed' and txid is null and created_at > '${oneWeekAgo}') as txAbandonedWeek,
    (select count(*) from transactions where status = 'failed' and txid is null and created_at > '${oneMonthAgo}') as txAbandonedMonth,
    (select count(*) from transactions where status = 'failed' and txid is null) as txAbandonedTotal,
    (select count(*) from transactions where status = 'unprocessed' and created_at > '${oneDayAgo}') as txUnprocessedDay,
    (select count(*) from transactions where status = 'unprocessed' and created_at > '${oneWeekAgo}') as txUnprocessedWeek,
    (select count(*) from transactions where status = 'unprocessed' and created_at > '${oneMonthAgo}') as txUnprocessedMonth,
    (select count(*) from transactions where status = 'unprocessed') as txUnprocessedTotal,
    (select count(*) from transactions where status = 'sending' and created_at > '${oneDayAgo}') as txSendingDay,
    (select count(*) from transactions where status = 'sending' and created_at > '${oneWeekAgo}') as txSendingWeek,
    (select count(*) from transactions where status = 'sending' and created_at > '${oneMonthAgo}') as txSendingMonth,
    (select count(*) from transactions where status = 'sending') as txSendingTotal,
    (select count(*) from transactions where status = 'unproven' and created_at > '${oneDayAgo}') as txUnprovenDay,
    (select count(*) from transactions where status = 'unproven' and created_at > '${oneWeekAgo}') as txUnprovenWeek,
    (select count(*) from transactions where status = 'unproven' and created_at > '${oneMonthAgo}') as txUnprovenMonth,
    (select count(*) from transactions where status = 'unproven') as txUnprovenTotal,
    (select count(*) from transactions where status = 'unsigned' and created_at > '${oneDayAgo}') as txUnsignedDay,
    (select count(*) from transactions where status = 'unsigned' and created_at > '${oneWeekAgo}') as txUnsignedWeek,
    (select count(*) from transactions where status = 'unsigned' and created_at > '${oneMonthAgo}') as txUnsignedMonth,
    (select count(*) from transactions where status = 'unsigned') as txUnsignedTotal,
    (select count(*) from transactions where status = 'nosend' and created_at > '${oneDayAgo}') as txNosendDay,
    (select count(*) from transactions where status = 'nosend' and created_at > '${oneWeekAgo}') as txNosendWeek,
    (select count(*) from transactions where status = 'nosend' and created_at > '${oneMonthAgo}') as txNosendMonth,
    (select count(*) from transactions where status = 'nosend') as txNosendTotal,
    (select count(*) from transactions where status = 'nonfinal' and created_at > '${oneDayAgo}') as txNonfinalDay,
    (select count(*) from transactions where status = 'nonfinal' and created_at > '${oneWeekAgo}') as txNonfinalWeek,
    (select count(*) from transactions where status = 'nonfinal' and created_at > '${oneMonthAgo}') as txNonfinalMonth,
    (select count(*) from transactions where status = 'nonfinal') as txNonfinalTotal,
    (select count(*) from transactions where status = 'unfail' and created_at > '${oneDayAgo}') as txUnfailDay,
    (select count(*) from transactions where status = 'unfail' and created_at > '${oneWeekAgo}') as txUnfailWeek,
    (select count(*) from transactions where status = 'unfail' and created_at > '${oneMonthAgo}') as txUnfailMonth,
    (select count(*) from transactions where status = 'unfail') as txUnfailTotal,
    (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 1 and o.created_at > '${oneDayAgo}') as satoshisDefaultDay,
    (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 1 and o.created_at > '${oneWeekAgo}') as satoshisDefaultWeek,
    (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 1 and o.created_at > '${oneMonthAgo}') as satoshisDefaultMonth,
    (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 1) as satoshisDefaultTotal,
    (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 0 and not o.basketId is null and o.created_at > '${oneDayAgo}') as satoshisOtherDay,
    (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 0 and not o.basketId is null and o.created_at > '${oneWeekAgo}') as satoshisOtherWeek,
    (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 0 and not o.basketId is null and o.created_at > '${oneMonthAgo}') as satoshisOtherMonth,
    (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 0 and not o.basketId is null) as satoshisOtherTotal,
    (select count(*) from output_baskets where created_at > '${oneDayAgo}') as basketsDay,
    (select count(*) from output_baskets where created_at > '${oneWeekAgo}') as basketsWeek,
    (select count(*) from output_baskets where created_at > '${oneMonthAgo}') as basketsMonth,
    (select count(*) from output_baskets) as basketsTotal,
    (select count(*) from tx_labels where created_at > '${oneDayAgo}') as labelsDay,
    (select count(*) from tx_labels where created_at > '${oneWeekAgo}') as labelsWeek,
    (select count(*) from tx_labels where created_at > '${oneMonthAgo}') as labelsMonth,
    (select count(*) from tx_labels) as labelsTotal,
    (select count(*) from output_tags where created_at > '${oneDayAgo}') as tagsDay,
    (select count(*) from output_tags where created_at > '${oneWeekAgo}') as tagsWeek,
    (select count(*) from output_tags where created_at > '${oneMonthAgo}') as tagsMonth,
    (select count(*) from output_tags) as tagsTotal
      `)
    const r: AdminStatsResult = {
      monitorStats,
      servicesStats,
      requestedBy: adminIdentityKey,
      when: new Date().toISOString(),
      usersDay,
      usersWeek,
      usersMonth,
      usersTotal,
      transactionsDay,
      transactionsWeek,
      transactionsMonth,
      transactionsTotal,
      txCompletedDay,
      txCompletedWeek,
      txCompletedMonth,
      txCompletedTotal,
      txFailedDay,
      txFailedWeek,
      txFailedMonth,
      txFailedTotal,
      txAbandonedDay,
      txAbandonedWeek,
      txAbandonedMonth,
      txAbandonedTotal,
      txUnprocessedDay,
      txUnprocessedWeek,
      txUnprocessedMonth,
      txUnprocessedTotal,
      txSendingDay,
      txSendingWeek,
      txSendingMonth,
      txSendingTotal,
      txUnprovenDay,
      txUnprovenWeek,
      txUnprovenMonth,
      txUnprovenTotal,
      txUnsignedDay,
      txUnsignedWeek,
      txUnsignedMonth,
      txUnsignedTotal,
      txNosendDay,
      txNosendWeek,
      txNosendMonth,
      txNosendTotal,
      txNonfinalDay,
      txNonfinalWeek,
      txNonfinalMonth,
      txNonfinalTotal,
      txUnfailDay,
      txUnfailWeek,
      txUnfailMonth,
      txUnfailTotal,
      satoshisDefaultDay: Number(satoshisDefaultDay),
      satoshisDefaultWeek: Number(satoshisDefaultWeek),
      satoshisDefaultMonth: Number(satoshisDefaultMonth),
      satoshisDefaultTotal: Number(satoshisDefaultTotal),
      satoshisOtherDay: Number(satoshisOtherDay),
      satoshisOtherWeek: Number(satoshisOtherWeek),
      satoshisOtherMonth: Number(satoshisOtherMonth),
      satoshisOtherTotal: Number(satoshisOtherTotal),
      basketsDay,
      basketsWeek,
      basketsMonth,
      basketsTotal,
      labelsDay,
      labelsWeek,
      labelsMonth,
      labelsTotal,
      tagsDay,
      tagsWeek,
      tagsMonth,
      tagsTotal
    }
    return r
  }
}

/**
 * Key columns that give paged queries a deterministic row order. Without an
 * ORDER BY, Postgres may return the rows of consecutive LIMIT/OFFSET pages in
 * different orders, so sync chunks could repeat some rows and skip others.
 */
function pagingOrder(table: string): string[] {
  return pagingKey(table).map(column => `${table}.${column}`)
}

function pagingKey(table: string): string[] {
  switch (table) {
    case 'certificate_fields':
      return ['certificateId', 'fieldName']
    case 'certificates':
      return ['certificateId']
    case 'commissions':
      return ['commissionId']
    case 'monitor_events':
      return ['id']
    case 'output_baskets':
      return ['basketId']
    case 'output_tags':
      return ['outputTagId']
    case 'output_tags_map':
      return ['outputTagId', 'outputId']
    case 'outputs':
      return ['outputId']
    case 'proven_tx_reqs':
      return ['provenTxReqId']
    case 'proven_txs':
      return ['provenTxId']
    case 'sync_states':
      return ['syncStateId']
    case 'transactions':
      return ['transactionId']
    case 'tx_labels':
      return ['txLabelId']
    case 'tx_labels_map':
      return ['txLabelId', 'transactionId']
    case 'users':
      return ['userId']
    default:
      return []
  }
}

const pgInt8Parsed = Symbol('pgInt8Parsed')

/**
 * node-postgres returns int8 values (bigint columns such as satoshis, `count(*)`)
 * as strings. Set a parser on each connection this knex acquires so they come
 * back as numbers, as with mysql2 and better-sqlite3. The process-wide `pg.types`
 * defaults are left unchanged.
 */
function parsePostgresInt8AsNumber(knex: Knex): void {
  const client = knex.client as (Knex.Client & { [pgInt8Parsed]?: true }) | undefined
  if (client?.dialect !== 'postgresql' || client[pgInt8Parsed] === true) return
  client[pgInt8Parsed] = true
  const acquireConnection = client.acquireConnection.bind(client)
  client.acquireConnection = async () => {
    const connection = await acquireConnection()
    connection.setTypeParser(20, (value: string) => Number.parseInt(value, 10))
    return connection
  }
}
