import { requireSyncTransferTransaction } from '../remoting/KnexSyncTransferStore'
import { nativeSnapshotSyncMappingMigration } from './NativeSnapshotSyncMappingSchemaNode'
import { hasBrc38NativePackedSchema } from '../portable/Brc38NativePackedSchemaNode'
import { hasBrc38NativePackedTextSchema } from '../portable/Brc38NativePackedTextSchemaNode'
import { hasBrc38NativePreparedFieldsSchema } from '../portable/Brc38NativePreparedFieldSchemaNode'
import { prepareNativeSnapshotSyncProvenTxReqs } from './NativeSnapshotSyncProvenTxReqsNode'
import { SNAPSHOT_SYNC_MIGRATION, verifySnapshotSyncPrimaryFence } from '../schema/snapshotSyncMigration'
import { Random, Utils } from '@bsv/sdk'
import type { StorageKnex } from '../StorageKnex'
import type { SyncChunk, TrxToken } from '../../sdk/WalletStorage.interfaces'
import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'
import { verifyOne } from '../../utility/utilityHelpers'
import { runInSeries } from '../../utility/runInSeries'
import type { TableProvenTx, TableUser } from '../schema/tables'
import { mergeSyncChunkEntities } from '../schema/entities/mergeSyncChunkEntities'
import { sameSyncProof } from '../methods/validateSyncProof'
import { detachSnapshotSyncPage, loadSnapshotIdMap, loadSnapshotFieldIdMap } from './SnapshotSyncRows'
import {
  snapshotSyncTables,
  type SnapshotSyncCheckpoint,
  type SnapshotSyncCommit,
  type SnapshotSyncSource,
  type SnapshotSyncTable
} from './SnapshotSync'
import type { WalletSnapshotPage } from './WalletReadSnapshot'
import { SnapshotResourceLimitError } from './SnapshotResourceLimitError'
import { copySnapshotCursor, sameSnapshotArchivePosition } from './SnapshotCursor'
import { ownedNativeRootIdentity, createOwnedNativeReadDatabase } from '../schema/ownedNativeSqliteConnectionsNode'
import { detachSnapshotSyncFieldPage } from './SnapshotSyncFieldRows'
import { snapshotSyncScalarChunk, snapshotSyncScalarPage } from './SnapshotSyncScalarFields'
import type { SnapshotSyncFieldPreparation } from './SnapshotSync'
import type { WalletReadSnapshot, WalletSnapshotFieldMetadataPage } from './WalletReadSnapshot'
import type { Knex } from 'knex'
import { createSyncMap } from '../schema/entities/EntityBase'
import { verifyNativeSnapshotSyncSchema } from './verifyNativeSnapshotSyncSchemaNode'
import { requireBrc38PackedWriter } from '../portable/Brc38NativePackedSchemaNode'
import { Brc38OwnedImportReads } from '../portable/Brc38OwnedImportReads'
import { Brc38StagingCleanupError } from '../portable/Brc38StagingCleanupError'
import { prepareNativeSnapshotSyncSimplePayload } from './NativeSnapshotSyncSimplePayloadNode'
import type { NativeSimplePayloadTable } from './writeNativeSnapshotSyncRowNode'
import { readSnapshotJournalMaintenanceConfiguration } from './journal/SnapshotJournalLifecycle'
import { prepareNativeSnapshotSyncProvenTxs } from './NativeSnapshotSyncProvenTxsNode'
import { prepareNativeSnapshotSyncActions } from './NativeSnapshotSyncActionsNode'

export interface KnexSnapshotSyncFieldWriter {
  readonly transaction: Knex.Transaction
  readonly user: Readonly<TableUser>
  readonly sourceUser: Readonly<TableUser>
  readonly sourceUserId: number
  readonly journalEpoch: string
  loadFieldMappings(
    table: SnapshotSyncTable,
    rows: readonly Readonly<Record<string, unknown>>[]
  ): ReturnType<typeof loadSnapshotFieldIdMap>
}
export interface KnexSnapshotSyncFieldRead {
  readonly transaction: Knex.Transaction
  readonly user: Readonly<TableUser>
  readonly sourceUserId: number
  readonly expiresAt: number
  readonly journalEpoch: string
  loadFieldMappings(
    table: SnapshotSyncTable,
    rows: readonly Readonly<Record<string, unknown>>[]
  ): Promise<Awaited<ReturnType<typeof loadSnapshotFieldIdMap>>['map']>
}

interface SessionRow {
  version: 1
  userId: number
  identityKey: string
  sourceStorageIdentityKey: string
  destinationStorageIdentityKey: string
  sessionId: string
  snapshotId: string
  sourceUserId: number
  chain: string
  primaryEpoch: number
  sourceActiveStorage: string | null
  sourceUserCreatedAt: string
  sourceUserUpdatedAt: string
  activeStorage: string | null
  expiresAt: number
  sequence: number
  tableIndex: number
  cursor: string | null
}

type ProofPreparation = (chunk: SyncChunk) => Promise<Map<string, TableProvenTx>>

function checkpoint(row: SessionRow): SnapshotSyncCheckpoint {
  return {
    version: row.version,
    sessionId: row.sessionId,
    identityKey: row.identityKey,
    sourceStorageIdentityKey: row.sourceStorageIdentityKey,
    destinationStorageIdentityKey: row.destinationStorageIdentityKey,
    snapshotId: row.snapshotId,
    tableIndex: row.tableIndex,
    sequence: row.sequence,
    cursor: row.cursor == null ? undefined : JSON.parse(row.cursor),
    done: row.tableIndex === snapshotSyncTables.length
  }
}

function notMatchingCheckpoint(actual: SnapshotSyncCheckpoint, expected: SnapshotSyncCheckpoint): boolean {
  return (
    actual.version !== expected.version ||
    actual.sessionId !== expected.sessionId ||
    actual.identityKey !== expected.identityKey ||
    actual.sourceStorageIdentityKey !== expected.sourceStorageIdentityKey ||
    actual.destinationStorageIdentityKey !== expected.destinationStorageIdentityKey ||
    actual.snapshotId !== expected.snapshotId ||
    actual.tableIndex !== expected.tableIndex ||
    actual.sequence !== expected.sequence ||
    actual.done !== expected.done ||
    actual.cursor?.version !== expected.cursor?.version ||
    actual.cursor?.snapshotId !== expected.cursor?.snapshotId ||
    actual.cursor?.table !== expected.cursor?.table ||
    JSON.stringify(actual.cursor?.after) !== JSON.stringify(expected.cursor?.after) ||
    !sameSnapshotArchivePosition(actual.cursor?.archivePosition, expected.cursor?.archivePosition)
  )
}

function requireLiveSource(
  expiresAt: number,
  stage: 'session admission' | 'session admission completion' | 'destination commit' | 'destination commit completion'
): void {
  if (Date.now() >= expiresAt) throw new SnapshotResourceLimitError(`Snapshot source expired before ${stage}`)
}

function detachNativeFieldPage(
  expected: SnapshotSyncCheckpoint,
  page: WalletSnapshotFieldMetadataPage<SnapshotSyncTable>
) {
  const rows = Object.getOwnPropertyDescriptor(page, 'rows'),
    bytes = Object.getOwnPropertyDescriptor(page, 'payloadBytes'),
    length =
      rows === undefined || !Object.hasOwn(rows, 'value') || !Array.isArray(rows.value)
        ? undefined
        : Object.getOwnPropertyDescriptor(rows.value, 'length')?.value
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > 128 ||
    bytes === undefined ||
    !Object.hasOwn(bytes, 'value') ||
    !Number.isSafeInteger(bytes.value) ||
    bytes.value < 0 ||
    bytes.value > 262144
  )
    throw new WERR_INVALID_OPERATION('Native field page exceeds its original row/metadata admission')
  return detachSnapshotSyncFieldPage(expected, page)
}

function validateSource(source: SnapshotSyncSource): void {
  if (
    source.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(source.snapshotId) ||
    !/^(02|03)[a-f0-9]{64}$/i.test(source.user.identityKey) ||
    !Number.isSafeInteger(source.user.userId) ||
    source.user.userId < 1 ||
    !Number.isSafeInteger(source.expiresAt) ||
    source.expiresAt > Date.now() + 3600000 ||
    typeof source.sourceStorage.storageIdentityKey !== 'string' ||
    source.sourceStorage.storageIdentityKey.length === 0 ||
    source.sourceStorage.storageIdentityKey.length > 130
  ) {
    throw new WERR_INVALID_PARAMETER('source', 'a live version-one wallet snapshot with a bound profile and source')
  }
  requireLiveSource(source.expiresAt, 'session admission')
}

/** Destination-authoritative state. Every session mutation locks the user before its session to preserve one lock order. */
export class KnexSnapshotSyncDestination {
  private readonly database: Knex
  constructor(
    private readonly storage: StorageKnex,
    private readonly prepareProofs: ProofPreparation
  ) {
    this.database = storage.knex
  }

  private assertOriginalRoot(): void {
    if (this.storage.knex !== this.database)
      throw new WERR_INVALID_OPERATION('Snapshot sync destination original database was replaced')
  }

  async supportsDestination(): Promise<boolean> {
    this.assertOriginalRoot()
    const k = this.database,
      migrationTable = k.client.config.migrations?.tableName ?? 'knex_migrations'
    if (!(await k.schema.hasTable(migrationTable))) return false
    const applied =
      (await k(migrationTable).select('name').where({ name: SNAPSHOT_SYNC_MIGRATION }).first()) !== undefined
    if (!applied) return false
    for (const table of ['snapshot_sync_sessions', 'snapshot_sync_ids', 'snapshot_sync_primary_epochs'])
      if (!(await k.schema.hasTable(table)))
        throw new WERR_INVALID_OPERATION('Snapshot sync destination migration is incomplete')
    await verifySnapshotSyncPrimaryFence(k)
    this.assertOriginalRoot()
    return true
  }

  readonly fieldPageLimits = Object.freeze({ maxRows: 128, maxBytes: 262144 })

  /** Fresh local capability decision, never a stored schema verdict. Absence
   * preserves ordinary migrated native wallets' legacy row path. A partial or
   * changed installation is an error; it cannot become fallback permission. */
  async supportsNativeFieldDestination(): Promise<boolean> {
    const root = this.storage.knex,
      origin = ownedNativeRootIdentity(root)
    if (origin?.slot !== 0) return false
    const database = createOwnedNativeReadDatabase(root)
    let result = false,
      failed = false,
      cause: unknown
    try {
      result = await database.transaction(async trx => {
        const check = (): void => {
          if (
            this.storage.knex !== root ||
            ownedNativeRootIdentity(root)?.token !== origin.token ||
            ownedNativeRootIdentity(trx)?.token !== origin.token ||
            ownedNativeRootIdentity(trx)?.slot !== 3
          )
            throw new WERR_INVALID_OPERATION('Native field negotiation lost its actual read producer')
        }
        check()
        const table = trx.client.config.migrations?.tableName ?? 'knex_migrations',
          named = await trx.schema.hasTable('brc38_native_sync_mapping_clock'),
          entries: Array<{ name: string }> = (await trx.schema.hasTable(table))
            ? await trx(table).where({ name: nativeSnapshotSyncMappingMigration }).select('name').limit(2)
            : []
        if (!named && entries.length === 0) return false
        if (!named || entries.length !== 1)
          throw new WERR_INVALID_OPERATION('Native field negotiation has an incomplete registered migration')
        await verifyNativeSnapshotSyncSchema(trx)
        if (
          !(await hasBrc38NativePackedSchema(trx)) ||
          !(await hasBrc38NativePackedTextSchema(trx)) ||
          !(await hasBrc38NativePreparedFieldsSchema(trx))
        )
          throw new WERR_INVALID_OPERATION('Native field negotiation current packed layout differs')
        await readSnapshotJournalMaintenanceConfiguration(trx)
        const abi = (await trx.raw('SELECT brc38_blob_protocol() AS version')) as Array<{ version: unknown }>
        if (abi.length !== 1 || abi[0].version !== 2)
          throw new WERR_INVALID_OPERATION('Native field negotiation requires the current source-owned ABI2 runtime')
        check()
        return true
      })
    } catch (error_) {
      failed = true
      cause = error_
    }
    try {
      await database.destroy()
    } catch (error_) {
      throw new Brc38StagingCleanupError(
        [...(failed ? [cause] : []), error_],
        'Native field negotiation retains its actual read pool',
        async () => {
          await database.destroy()
        }
      )
    }
    if (failed) throw cause
    return result
  }

  /** All twelve native replica policies dispatch explicitly. Components
   * detach and validate the complete metadata/descriptor envelope before their
   * first await; these casts narrow table DATA only, never wallet DTOs. */
  async prepareNativeFields(
    input: SnapshotSyncCheckpoint,
    page: WalletSnapshotFieldMetadataPage<SnapshotSyncTable>,
    source: WalletReadSnapshot,
    signal?: AbortSignal
  ): Promise<SnapshotSyncFieldPreparation> {
    const expected = { ...input, cursor: copySnapshotCursor(input.cursor) }
    switch (snapshotSyncTables[expected.tableIndex]) {
      case 'provenTxs':
        return await this.prepareNativeProofFields(
          expected,
          page as WalletSnapshotFieldMetadataPage<'provenTxs'>,
          source,
          signal
        )
      case 'transactions':
      case 'outputs':
        return await this.prepareNativeActionFields(
          expected,
          page as WalletSnapshotFieldMetadataPage<'transactions' | 'outputs'>,
          source,
          signal
        )
      case 'certificates':
      case 'certificateFields':
      case 'commissions':
        return await this.prepareNativeSimpleFields(
          expected,
          page as WalletSnapshotFieldMetadataPage<NativeSimplePayloadTable>,
          source,
          signal
        )
      case 'provenTxReqs':
        return await this.prepareNativeRequestFields(
          expected,
          page as WalletSnapshotFieldMetadataPage<'provenTxReqs'>,
          source,
          signal
        )
      case 'outputBaskets':
      case 'outputTags':
      case 'txLabels':
      case 'txLabelMaps':
      case 'outputTagMaps':
        return await this.prepareNativeScalarFields(expected, page, source, signal)
      default:
        throw new WERR_INVALID_OPERATION('Snapshot sync is already complete')
    }
  }

  private async lockUser(identityKey: string, trx: TrxToken): Promise<TableUser> {
    const k = this.storage.toDb(trx)
    // Acquire the write lock before reading on both SQLite (deferred transaction)
    // and MySQL. Primary-selection updates and sibling processes use this same row.
    await k('users')
      .where({ identityKey })
      .update({ userId: k.ref('userId') })
    return verifyOne(await this.storage.findUsers({ partial: { identityKey }, trx }))
  }

  private async primaryEpoch(userId: number, trx: TrxToken): Promise<number> {
    const row: { epoch: number } | undefined = await this.storage
      .toDb(trx)('snapshot_sync_primary_epochs')
      .where({ userId })
      .first()
    const epoch = Number(row?.epoch ?? 0)
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new WERR_INVALID_OPERATION('Invalid primary epoch')
    return epoch
  }

  /** Bounded native session metadata before loading any persisted TEXT. SQLite
   * VARCHAR declarations alone do not impose a physical allocation bound. */
  private async nativeSession(
    k: Knex.Transaction,
    scope: { userId: number; sourceStorageIdentityKey: string }
  ): Promise<SessionRow | undefined> {
    const columns = [
        'version',
        'userId',
        'identityKey',
        'sourceStorageIdentityKey',
        'destinationStorageIdentityKey',
        'sessionId',
        'snapshotId',
        'sourceUserId',
        'chain',
        'primaryEpoch',
        'sourceActiveStorage',
        'sourceUserCreatedAt',
        'sourceUserUpdatedAt',
        'activeStorage',
        'expiresAt',
        'sequence',
        'tableIndex',
        'cursor'
      ],
      charge = k.raw(columns.map(() => '2*coalesce(length(CAST(?? AS BLOB)),0)+64').join('+'), columns),
      admitted = (await k('snapshot_sync_sessions')
        .where(scope)
        .first(k.raw('CASE WHEN ?<=16384 THEN 1 ELSE 0 END AS admitted', [charge]))) as { admitted: number } | undefined
    if (admitted === undefined) return undefined
    if (admitted.admitted !== 1)
      throw new SnapshotResourceLimitError('Native snapshot session exceeds its bounded metadata allocation')
    const row = (await k('snapshot_sync_sessions')
      .where(scope)
      .first(...columns)) as SessionRow | undefined
    if (
      row === undefined ||
      row.version !== 1 ||
      !Number.isSafeInteger(row.sourceUserId) ||
      row.sourceUserId < 1 ||
      !Number.isSafeInteger(row.sequence) ||
      row.sequence < 0 ||
      !Number.isSafeInteger(row.tableIndex) ||
      row.tableIndex < 0 ||
      row.tableIndex > snapshotSyncTables.length ||
      !Number.isSafeInteger(row.expiresAt) ||
      !Number.isSafeInteger(row.primaryEpoch) ||
      row.primaryEpoch < 0 ||
      (row.cursor !== null && (typeof row.cursor !== 'string' || row.cursor.length > 8192))
    )
      throw new WERR_INVALID_OPERATION('Native snapshot session metadata differs from its current contract')
    return row
  }

  /** Actual current session/profile read on this original producer's separate
   * query-only lease. The callback and each bounded mapping request drain
   * before pool release; neither its transaction nor a saved map can supply a
   * later writer verdict. Failure retains the concrete physical cleanup owner. */
  async inspectNativeFieldSession<T>(
    input: SnapshotSyncCheckpoint,
    signal: AbortSignal | undefined,
    work: (read: Readonly<KnexSnapshotSyncFieldRead>) => Promise<T>
  ): Promise<T> {
    const expected: SnapshotSyncCheckpoint = { ...input, cursor: copySnapshotCursor(input.cursor) },
      root = this.storage.knex,
      origin = ownedNativeRootIdentity(root)
    signal?.throwIfAborted()
    if (origin?.slot !== 0)
      throw new WERR_INVALID_OPERATION('Native field inspection requires the actual wallet producer')
    const database = createOwnedNativeReadDatabase(root)
    let result!: T,
      failed = false,
      cause: unknown
    try {
      result = await database.transaction(async trx => {
        const check = (): void => {
          signal?.throwIfAborted()
          if (
            this.storage.knex !== root ||
            ownedNativeRootIdentity(root)?.token !== origin.token ||
            ownedNativeRootIdentity(trx)?.token !== origin.token ||
            ownedNativeRootIdentity(trx)?.slot !== 3
          )
            throw new WERR_INVALID_OPERATION('Native field inspection original read producer ended')
        }
        check()
        await verifyNativeSnapshotSyncSchema(trx)
        const journal = await readSnapshotJournalMaintenanceConfiguration(trx)
        const user = verifyOne(await this.storage.findUsers({ partial: { identityKey: expected.identityKey }, trx })),
          scope = { userId: user.userId, sourceStorageIdentityKey: expected.sourceStorageIdentityKey },
          row = await this.nativeSession(trx, scope)
        if (
          row === undefined ||
          notMatchingCheckpoint(checkpoint(row), expected) ||
          row.activeStorage !== (user.activeStorage ?? null) ||
          row.primaryEpoch !== (await this.primaryEpoch(user.userId, trx)) ||
          row.chain !== this.storage.chain ||
          row.destinationStorageIdentityKey !== this.storage.getSettings().storageIdentityKey
        )
          throw new WERR_INVALID_OPERATION('Native field inspection session/profile/primary differs')
        requireLiveSource(row.expiresAt, 'session admission')
        const requests = new Brc38OwnedImportReads(),
          table = snapshotSyncTables[row.tableIndex],
          read: KnexSnapshotSyncFieldRead = {
            transaction: trx,
            user: Object.freeze({ ...user }),
            sourceUserId: row.sourceUserId,
            expiresAt: row.expiresAt,
            journalEpoch: journal.epoch,
            loadFieldMappings: (selectedTable, rows) =>
              requests.run(async () => {
                check()
                requireLiveSource(row.expiresAt, 'session admission')
                if (selectedTable !== table)
                  throw new WERR_INVALID_OPERATION('Native field mapping read belongs to another table')
                const mapping = await loadSnapshotFieldIdMap(trx, scope, row.sourceUserId, table, rows)
                check()
                return mapping.map
              })
          }
        const outcome = await requests.retain(async () => await work(Object.freeze(read)))
        check()
        requireLiveSource(row.expiresAt, 'session admission')
        return outcome
      })
    } catch (error_) {
      failed = true
      cause = error_
    }
    try {
      await database.destroy()
    } catch (error_) {
      throw new Brc38StagingCleanupError(
        [...(failed ? [cause] : []), error_],
        'Native field session retains its actual read-only pool',
        async () => {
          await database.destroy()
        }
      )
    }
    if (failed) throw cause
    return result
  }

  /** Shared current native writer for the payload entity components. The
   * page is freshly detached and every session/profile/primary/mapped parent
   * check precedes effects. Component callbacks only use prepared fields and
   * current scalar rows; no source, proof or large-field I/O belongs here.
   * All effects/maps and this ACK commit in the SAME transaction. This private
   * program building block does not advertise partial field capability. */
  async commitNativeFieldPage(
    input: SnapshotSyncCheckpoint,
    page: WalletSnapshotFieldMetadataPage<SnapshotSyncTable>,
    signal: AbortSignal | undefined,
    effect: (writer: Readonly<KnexSnapshotSyncFieldWriter>) => Promise<{ inserts: number; updates: number }>
  ): Promise<SnapshotSyncCommit> {
    const expected: SnapshotSyncCheckpoint = { ...input, cursor: copySnapshotCursor(input.cursor) },
      detached = detachNativeFieldPage(expected, page),
      root = this.storage.knex,
      origin = ownedNativeRootIdentity(root)
    if (origin?.slot !== 0)
      throw new WERR_INVALID_OPERATION('Native field commit requires the actual current wallet root')
    signal?.throwIfAborted()
    return await root.transaction(async trx => {
      const check = (): void => {
        signal?.throwIfAborted()
        requireBrc38PackedWriter(trx)
        if (
          this.storage.knex !== root ||
          ownedNativeRootIdentity(root)?.token !== origin.token ||
          ownedNativeRootIdentity(trx)?.token !== origin.token ||
          ownedNativeRootIdentity(trx)?.slot !== 0
        )
          throw new WERR_INVALID_OPERATION('Native field commit original producer ended')
      }
      check()
      await verifyNativeSnapshotSyncSchema(trx)
      const journal = await readSnapshotJournalMaintenanceConfiguration(trx)
      const user = await this.lockUser(expected.identityKey, trx),
        scope = { userId: user.userId, sourceStorageIdentityKey: expected.sourceStorageIdentityKey },
        row = await this.nativeSession(trx, scope)
      if (
        row === undefined ||
        notMatchingCheckpoint(checkpoint(row), expected) ||
        row.activeStorage !== (user.activeStorage ?? null) ||
        row.primaryEpoch !== (await this.primaryEpoch(user.userId, trx)) ||
        row.chain !== this.storage.chain ||
        row.destinationStorageIdentityKey !== this.storage.getSettings().storageIdentityKey
      )
        throw new WERR_INVALID_OPERATION('Native field session or primary changed; recover its durable checkpoint')
      requireLiveSource(row.expiresAt, 'destination commit')
      const table = snapshotSyncTables[row.tableIndex],
        sourceUser: TableUser = {
          userId: row.sourceUserId,
          identityKey: row.identityKey,
          created_at: new Date(row.sourceUserCreatedAt),
          updated_at: new Date(row.sourceUserUpdatedAt),
          activeStorage: (row.sourceActiveStorage ?? undefined) as string
        }
      let userUpdates = 0,
        live = true
      const requests = new Brc38OwnedImportReads()
      if (row.sequence === 0) {
        const result = await mergeSyncChunkEntities(
          this.storage,
          user.userId,
          undefined,
          {
            userIdentityKey: row.identityKey,
            fromStorageIdentityKey: row.sourceStorageIdentityKey,
            toStorageIdentityKey: row.destinationStorageIdentityKey,
            user: sourceUser
          },
          createSyncMap(),
          trx
        )
        userUpdates = result.updates
      }
      const current = verifyOne(await this.storage.findUsers({ partial: { identityKey: row.identityKey }, trx })),
        writer: KnexSnapshotSyncFieldWriter = {
          transaction: trx,
          user: Object.freeze({ ...current }),
          sourceUser: Object.freeze(sourceUser),
          sourceUserId: row.sourceUserId,
          journalEpoch: journal.epoch,
          loadFieldMappings: (selectedTable, rows) =>
            requests.run(async () => {
              check()
              if (!live || selectedTable !== table)
                throw new WERR_INVALID_OPERATION('Native field mapping escaped its current writer/table')
              const mappings = await loadSnapshotFieldIdMap(trx, scope, row.sourceUserId, table, rows)
              check()
              return {
                map: mappings.map,
                persist: () =>
                  requests.run(async () => {
                    check()
                    if (!live) throw new WERR_INVALID_OPERATION('Native field mapping persist escaped its writer')
                    await mappings.persist()
                    check()
                  })
              }
            })
        }
      let result: { inserts: number; updates: number }
      try {
        result = await requests.retain(async () => await effect(Object.freeze(writer)))
      } finally {
        live = false
      }
      check()
      requireLiveSource(row.expiresAt, 'destination commit')
      if (
        !Number.isSafeInteger(result.inserts) ||
        result.inserts < 0 ||
        !Number.isSafeInteger(result.updates) ||
        result.updates < 0 ||
        result.inserts + result.updates > detached.rows.length
      )
        throw new WERR_INVALID_OPERATION('Native field component effect counts exceed its actual page')
      const finalUser = verifyOne(await this.storage.findUsers({ partial: { identityKey: row.identityKey }, trx }))
      row.primaryEpoch = await this.primaryEpoch(user.userId, trx)
      row.activeStorage = finalUser.activeStorage ?? null
      row.sequence++
      row.tableIndex = detached.nextTable
      row.cursor = detached.nextCursor
      if (
        !Number.isSafeInteger(row.sequence) ||
        (await trx('snapshot_sync_sessions').where(scope).update({
          sequence: row.sequence,
          tableIndex: row.tableIndex,
          cursor: row.cursor,
          primaryEpoch: row.primaryEpoch,
          activeStorage: row.activeStorage
        })) !== 1
      )
        throw new WERR_INVALID_OPERATION('Native field checkpoint did not update its exact current session')
      check()
      return { checkpoint: checkpoint(row), inserts: result.inserts, updates: result.updates + userUpdates }
    })
  }

  async checkpoint(identityKey: string, sourceStorageIdentityKey: string): Promise<SnapshotSyncCheckpoint | undefined> {
    this.assertOriginalRoot()
    const user = await this.storage.findUserByIdentityKey(identityKey)
    if (user === undefined) return undefined
    const row: SessionRow | undefined = await this.storage
      .knex('snapshot_sync_sessions')
      .where({ userId: user.userId, sourceStorageIdentityKey })
      .first()
    this.assertOriginalRoot()
    return row === undefined ? undefined : checkpoint(row)
  }

  async begin(
    input: SnapshotSyncSource,
    activeStorage: string | undefined,
    limits?: Readonly<{ maximumSourceScopes: number }>
  ): Promise<SnapshotSyncCheckpoint> {
    this.assertOriginalRoot()
    const maximumSourceScopes = limits?.maximumSourceScopes
    if (
      maximumSourceScopes !== undefined &&
      (!Number.isSafeInteger(maximumSourceScopes) || maximumSourceScopes < 1 || maximumSourceScopes > 128)
    )
      throw new WERR_INVALID_PARAMETER('maximumSourceScopes', 'an integer from 1 to 128')
    // Snapshot all caller-controlled values before the first asynchronous boundary.
    validateSource(input)
    const source = {
      ...input,
      sourceStorage: { ...input.sourceStorage },
      user: {
        ...input.user,
        created_at: new Date(input.user.created_at),
        updated_at: new Date(input.user.updated_at),
        activeStorage
      }
    }
    const sourceUserCreatedAt = source.user.created_at.toISOString()
    const sourceUserUpdatedAt = source.user.updated_at.toISOString()
    if (!(await this.supportsDestination()))
      throw new WERR_INVALID_OPERATION('Snapshot sync destination requires the version-one migration')
    const settings = await this.storage.makeAvailable()
    if (
      source.sourceStorage.chain !== settings.chain ||
      source.sourceStorage.storageIdentityKey === settings.storageIdentityKey
    ) {
      throw new WERR_INVALID_PARAMETER('source', 'a different storage on the destination network')
    }
    this.assertOriginalRoot()
    return await this.database.transaction(async nativeTransaction => {
      this.assertOriginalRoot()
      const trx = nativeTransaction as TrxToken
      const k = this.storage.toDb(trx)
      await verifySnapshotSyncPrimaryFence(k)
      requireLiveSource(source.expiresAt, 'session admission')
      const created = await this.storage.findOrInsertUser(source.user.identityKey, trx)
      // Creating a backup profile must not temporarily select the backup as a
      // second writable primary before its first data page. Existing users'
      // selection remains untouched until the atomic first-page merge.
      if (created.isNew)
        await k('users')
          .where({ userId: created.user.userId })
          .update({ activeStorage: activeStorage ?? null })
      const user = await this.lockUser(source.user.identityKey, trx)
      const scope = { userId: user.userId, sourceStorageIdentityKey: source.sourceStorage.storageIdentityKey }
      const previous: SessionRow | undefined = await k('snapshot_sync_sessions').where(scope).first()
      if (previous === undefined && maximumSourceScopes !== undefined) {
        const existing = await k('snapshot_sync_sessions')
          .where({ userId: user.userId })
          .select('sourceStorageIdentityKey')
          .limit(maximumSourceScopes)
        if (existing.length >= maximumSourceScopes)
          throw new SnapshotResourceLimitError('Snapshot destination original source-scope quota reached')
      }
      if (previous?.snapshotId === source.snapshotId) {
        if (
          previous.sourceUserId !== source.user.userId ||
          previous.sourceActiveStorage !== (activeStorage ?? null) ||
          previous.sourceUserCreatedAt !== sourceUserCreatedAt ||
          previous.sourceUserUpdatedAt !== sourceUserUpdatedAt ||
          previous.chain !== settings.chain ||
          previous.destinationStorageIdentityKey !== settings.storageIdentityKey ||
          previous.version !== source.version ||
          previous.activeStorage !== (user.activeStorage ?? null) ||
          Number(previous.primaryEpoch) !== (await this.primaryEpoch(user.userId, trx)) ||
          Number(previous.expiresAt) !== source.expiresAt
        ) {
          throw new WERR_INVALID_OPERATION('Snapshot session binding changed or expired; open a new source view')
        }
        requireLiveSource(Number(previous.expiresAt), 'session admission')
        this.assertOriginalRoot()
        return checkpoint(previous)
      }
      requireLiveSource(source.expiresAt, 'session admission')
      // Profile metadata is merged with the first page, so cancellation before
      // any page leaves the selected primary untouched and update counts agree
      // with the durable merge outcome.
      const row: SessionRow = {
        ...scope,
        version: 1,
        sessionId: Utils.toHex(Random(32)),
        snapshotId: source.snapshotId,
        sourceUserId: source.user.userId,
        identityKey: source.user.identityKey,
        destinationStorageIdentityKey: settings.storageIdentityKey,
        chain: settings.chain,
        activeStorage: user.activeStorage ?? null,
        sourceActiveStorage: activeStorage ?? null,
        sourceUserCreatedAt,
        sourceUserUpdatedAt,
        primaryEpoch: await this.primaryEpoch(user.userId, trx),
        expiresAt: source.expiresAt,
        tableIndex: 0,
        sequence: 0,
        cursor: null
      }
      await k('snapshot_sync_sessions').insert(row).onConflict(['userId', 'sourceStorageIdentityKey']).merge(row)
      this.assertOriginalRoot()
      requireLiveSource(source.expiresAt, 'session admission completion')
      return checkpoint(row)
    })
  }

  async prepare(
    input: SnapshotSyncCheckpoint,
    page: WalletSnapshotPage<SnapshotSyncTable>
  ): Promise<() => Promise<SnapshotSyncCommit>> {
    const apply = await this.prepareAtomicPage(input, page)
    let consumed = false
    return async () => {
      if (consumed)
        throw new WERR_INVALID_OPERATION('Prepared snapshot page already consumed; read its durable checkpoint')
      consumed = true
      return await this.database.transaction(apply)
    }
  }

  /** Node-internal bridge used only by the original controller's durable
   * transfer store. Proof I/O finishes before its transaction begins; the
   * transfer result, entity effects and checkpoint share that one writer.
   * This callback is never exposed through the RPC/provider capability. */
  async prepareInTransaction(
    input: SnapshotSyncCheckpoint,
    page: WalletSnapshotPage<SnapshotSyncTable>
  ): Promise<(transaction: Knex.Transaction) => Promise<SnapshotSyncCommit>> {
    return await this.prepareAtomicPage(input, page, trx => requireSyncTransferTransaction(trx, this.database))
  }

  private async prepareAtomicPage(
    input: SnapshotSyncCheckpoint,
    page: WalletSnapshotPage<SnapshotSyncTable>,
    transactionFence?: (transaction: Knex.Transaction) => void
  ): Promise<(transaction: Knex.Transaction) => Promise<SnapshotSyncCommit>> {
    this.assertOriginalRoot()
    const expected: SnapshotSyncCheckpoint = {
      ...input,
      cursor: copySnapshotCursor(input.cursor)
    }
    if (
      expected.version !== 1 ||
      !/^[a-f0-9]{64}$/.test(expected.sessionId) ||
      !Number.isSafeInteger(expected.sequence) ||
      expected.sequence < 0 ||
      !Number.isSafeInteger(expected.tableIndex) ||
      expected.tableIndex < 0
    ) {
      throw new WERR_INVALID_PARAMETER('checkpoint', 'a version-one durable snapshot checkpoint')
    }
    const detached = detachSnapshotSyncPage(expected, page)
    const proofs = await this.prepareProofs(detached.chunk)
    this.assertOriginalRoot()
    let consumed = false
    return async nativeTransaction => {
      if (consumed)
        throw new WERR_INVALID_OPERATION('Prepared snapshot page already consumed; read its durable checkpoint')
      consumed = true
      this.assertOriginalRoot()
      transactionFence?.(nativeTransaction)
      const trx = nativeTransaction as TrxToken
      await verifySnapshotSyncPrimaryFence(nativeTransaction)
      const user = await this.lockUser(expected.identityKey, trx)
      const k = this.storage.toDb(trx)
      const scope = { userId: user.userId, sourceStorageIdentityKey: expected.sourceStorageIdentityKey }
      const row: SessionRow | undefined = await k('snapshot_sync_sessions').where(scope).first()
      if (
        row === undefined ||
        notMatchingCheckpoint(checkpoint(row), expected) ||
        row.activeStorage !== (user.activeStorage ?? null) ||
        Number(row.primaryEpoch) !== (await this.primaryEpoch(user.userId, trx)) ||
        row.chain !== this.storage.chain ||
        row.destinationStorageIdentityKey !== this.storage.getSettings().storageIdentityKey
      ) {
        throw new WERR_INVALID_OPERATION('Snapshot session changed or expired; resume from its durable checkpoint')
      }
      requireLiveSource(Number(row.expiresAt), 'destination commit')
      await this.verifyProofs(proofs, trx)
      this.assertOriginalRoot()
      const mappings = await loadSnapshotIdMap(
        k,
        scope,
        row.sourceUserId,
        snapshotSyncTables[row.tableIndex],
        detached.chunk
      )
      if (row.sequence === 0)
        detached.chunk.user = {
          userId: row.sourceUserId,
          identityKey: row.identityKey,
          created_at: new Date(row.sourceUserCreatedAt),
          updated_at: new Date(row.sourceUserUpdatedAt),
          // TableUser retains its legacy declaration although an unselected
          // primary is represented as undefined by storage adapters.
          activeStorage: (row.sourceActiveStorage ?? undefined) as string
        }
      const result = await mergeSyncChunkEntities(
        this.storage,
        user.userId,
        undefined,
        detached.chunk,
        mappings.map,
        trx
      )
      await mappings.persist()
      const currentUser = verifyOne(await this.storage.findUsers({ partial: { identityKey: row.identityKey }, trx }))
      row.primaryEpoch = await this.primaryEpoch(user.userId, trx)
      row.activeStorage = currentUser.activeStorage ?? null
      row.sequence++
      row.tableIndex = detached.nextTable
      row.cursor = detached.nextCursor
      await k('snapshot_sync_sessions').where(scope).update({
        sequence: row.sequence,
        tableIndex: row.tableIndex,
        cursor: row.cursor,
        primaryEpoch: row.primaryEpoch,
        activeStorage: row.activeStorage
      })
      this.assertOriginalRoot()
      requireLiveSource(Number(row.expiresAt), 'destination commit completion')
      transactionFence?.(nativeTransaction)
      return { checkpoint: checkpoint(row), inserts: result.inserts, updates: result.updates }
    }
  }

  /** Five complete native scalar entity components. The selected scalar rows
   * are complete public rows, not fake payload DTOs. The original entity and
   * current SQL session/user/primary/ID-map/checkpoint transaction own effects.
   * The complete dispatcher and fresh capability probe select this component;
   * an earlier schema or mapping read never authorizes its final writer. */
  async prepareNativeScalarFields(
    input: SnapshotSyncCheckpoint,
    page: WalletSnapshotFieldMetadataPage<SnapshotSyncTable>,
    source: WalletReadSnapshot,
    signal?: AbortSignal
  ): Promise<SnapshotSyncFieldPreparation> {
    const expected: SnapshotSyncCheckpoint = { ...input, cursor: copySnapshotCursor(input.cursor) },
      detached = detachNativeFieldPage(expected, page),
      scalar = snapshotSyncScalarChunk(expected, detached.rows),
      root = this.storage.knex,
      origin = ownedNativeRootIdentity(root),
      binding = Object.freeze({
        snapshotId: source.snapshotId,
        sourceUserId: source.user.userId,
        identityKey: source.user.identityKey,
        sourceStorageIdentityKey: source.sourceStorage.storageIdentityKey,
        chain: source.sourceStorage.chain,
        expiresAt: source.expiresAt
      }),
      deadline = performance.now() + Math.max(0, binding.expiresAt - Date.now())
    let closed = false,
      consumed = false,
      running: Promise<SnapshotSyncCommit> | undefined,
      closing: Promise<void> | undefined
    const check = (): void => {
      signal?.throwIfAborted()
      if (closed || !source.isOpen || Date.now() >= binding.expiresAt || performance.now() >= deadline)
        throw new SnapshotResourceLimitError('Native scalar preparation original source admission ended')
      if (
        origin?.slot !== 0 ||
        this.storage.knex !== root ||
        ownedNativeRootIdentity(root)?.token !== origin.token ||
        source.snapshotId !== binding.snapshotId ||
        source.user.userId !== binding.sourceUserId ||
        source.user.identityKey !== binding.identityKey ||
        source.sourceStorage.storageIdentityKey !== binding.sourceStorageIdentityKey ||
        source.sourceStorage.chain !== binding.chain ||
        source.expiresAt !== binding.expiresAt ||
        binding.snapshotId !== expected.snapshotId ||
        binding.identityKey !== expected.identityKey ||
        binding.sourceStorageIdentityKey !== expected.sourceStorageIdentityKey ||
        binding.chain !== this.storage.chain ||
        !Number.isSafeInteger(binding.expiresAt) ||
        binding.expiresAt > Date.now() + 3600000
      )
        throw new WERR_INVALID_OPERATION('Native scalar preparation differs from its actual original provider/source')
    }
    check()
    const completePage = snapshotSyncScalarPage(
        expected,
        scalar,
        detached.allocationBytes,
        detached.nextTable !== expected.tableIndex,
        detached.rows.length === 0 ? expected.cursor : detached.rows[detached.rows.length - 1].cursor
      ),
      fieldPage: WalletSnapshotFieldMetadataPage<SnapshotSyncTable> = {
        rows: completePage.rows.map((row, index) => ({
          fields: row,
          extents: {},
          cursor: detached.rows[index].cursor
        })),
        payloadBytes: detached.allocationBytes,
        done: completePage.done,
        cursor: completePage.cursor
      }
    await this.inspectNativeFieldSession(expected, signal, async read => {
      if (read.sourceUserId !== binding.sourceUserId)
        throw new WERR_INVALID_OPERATION('Native scalar source profile differs')
      await read.loadFieldMappings(
        snapshotSyncTables[expected.tableIndex],
        detached.rows.map(row => row.fields)
      )
    })
    check()
    return Object.freeze({
      apply: async () => {
        check()
        if (consumed) throw new WERR_INVALID_OPERATION('Native scalar preparation already consumed')
        consumed = true
        // Preserve the detached complete page as DATA for the original entity
        // merger; the actual native field writer owns the current transaction.
        const chunk = detachSnapshotSyncPage(expected, completePage).chunk
        running = this.commitNativeFieldPage(expected, fieldPage, signal, async writer => {
          check()
          if (writer.sourceUserId !== binding.sourceUserId)
            throw new WERR_INVALID_OPERATION('Native scalar source profile changed')
          const mappings = await writer.loadFieldMappings(
              snapshotSyncTables[expected.tableIndex],
              detached.rows.map(row => row.fields)
            ),
            result = await mergeSyncChunkEntities(
              this.storage,
              writer.user.userId,
              undefined,
              chunk,
              mappings.map,
              writer.transaction
            )
          await mappings.persist()
          check()
          return { inserts: result.inserts, updates: result.updates }
        })
        try {
          const outcome = await running
          check()
          return outcome
        } finally {
          running = undefined
        }
      },
      close: () => {
        if (closing !== undefined) return closing
        closed = true
        closing = (async () => {
          if (running !== undefined) await running.catch(() => undefined)
        })()
        return closing
      }
    })
  }

  /** Native certificate/field/commission policies behind complete dispatch. */
  async prepareNativeSimpleFields(
    input: SnapshotSyncCheckpoint,
    page: WalletSnapshotFieldMetadataPage<NativeSimplePayloadTable>,
    source: WalletReadSnapshot,
    signal?: AbortSignal
  ): Promise<SnapshotSyncFieldPreparation> {
    const table = snapshotSyncTables[input.tableIndex]
    if (table !== 'certificates' && table !== 'certificateFields' && table !== 'commissions')
      throw new WERR_INVALID_OPERATION('Native simple field component belongs to another table')
    return await prepareNativeSnapshotSyncSimplePayload(this.storage, this, table, input, page, source, signal)
  }

  /** Original local-backup proof component with pre-writer streamed validation.
   * Current field negotiation independently checks the full native layout. */
  async prepareNativeProofFields(
    input: SnapshotSyncCheckpoint,
    page: WalletSnapshotFieldMetadataPage<'provenTxs'>,
    source: WalletReadSnapshot,
    signal?: AbortSignal
  ): Promise<SnapshotSyncFieldPreparation> {
    return await prepareNativeSnapshotSyncProvenTxs(this.storage, this, input, page, source, signal)
  }

  /** Native requests preserve original history/notify and occupied-row policy. */
  async prepareNativeRequestFields(
    input: SnapshotSyncCheckpoint,
    page: WalletSnapshotFieldMetadataPage<'provenTxReqs'>,
    source: WalletReadSnapshot,
    signal?: AbortSignal
  ): Promise<SnapshotSyncFieldPreparation> {
    return await prepareNativeSnapshotSyncProvenTxReqs(this.storage, this, input, page, source, signal)
  }

  /** Native transaction/output components retain original BRC-177 policies. */
  async prepareNativeActionFields(
    input: SnapshotSyncCheckpoint,
    page: WalletSnapshotFieldMetadataPage<'transactions' | 'outputs'>,
    source: WalletReadSnapshot,
    signal?: AbortSignal
  ): Promise<SnapshotSyncFieldPreparation> {
    return await prepareNativeSnapshotSyncActions(this.storage, this, input, page, source, signal)
  }

  private async verifyProofs(proofs: Map<string, TableProvenTx>, trx: TrxToken): Promise<void> {
    const ordered = [...proofs.values()].sort((left, right) => left.txid.localeCompare(right.txid))
    await runInSeries(ordered, async previous => {
      const rows = await this.storage.findProvenTxs({ partial: { txid: previous.txid }, trx })
      if (rows.length !== 1 || !sameSyncProof(rows[0], previous)) {
        throw new WERR_INVALID_OPERATION(
          'Proof changed during snapshot preparation; resume from its durable checkpoint'
        )
      }
    })
  }
}
