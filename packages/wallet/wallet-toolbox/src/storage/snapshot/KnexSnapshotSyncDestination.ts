import { SNAPSHOT_SYNC_MIGRATION } from '../schema/snapshotSyncMigration'
import { Random, Utils } from '@bsv/sdk'
import type { StorageKnex } from '../StorageKnex'
import type { SyncChunk, TrxToken } from '../../sdk/WalletStorage.interfaces'
import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'
import { verifyOne } from '../../utility/utilityHelpers'
import { runInSeries } from '../../utility/runInSeries'
import type { TableProvenTx, TableUser } from '../schema/tables'
import { mergeSyncChunkEntities } from '../schema/entities/mergeSyncChunkEntities'
import { sameSyncProof } from '../methods/validateSyncProof'
import { detachSnapshotSyncPage, loadSnapshotIdMap } from './SnapshotSyncRows'
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

function requireLiveSource(expiresAt: number, stage: 'session admission' | 'destination commit'): void {
  if (Date.now() >= expiresAt) throw new SnapshotResourceLimitError(`Snapshot source expired before ${stage}`)
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
  constructor(
    private readonly storage: StorageKnex,
    private readonly prepareProofs: ProofPreparation
  ) {}

  async supportsDestination(): Promise<boolean> {
    const k = this.storage.knex
    if (!(await k.schema.hasTable('knex_migrations'))) return false
    return (await k('knex_migrations').select('name').where({ name: SNAPSHOT_SYNC_MIGRATION }).first()) !== undefined
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

  async checkpoint(identityKey: string, sourceStorageIdentityKey: string): Promise<SnapshotSyncCheckpoint | undefined> {
    const user = await this.storage.findUserByIdentityKey(identityKey)
    if (user === undefined) return undefined
    const row: SessionRow | undefined = await this.storage
      .knex('snapshot_sync_sessions')
      .where({ userId: user.userId, sourceStorageIdentityKey })
      .first()
    return row === undefined ? undefined : checkpoint(row)
  }

  async begin(input: SnapshotSyncSource, activeStorage: string | undefined): Promise<SnapshotSyncCheckpoint> {
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
    await this.storage.findOrInsertUser(source.user.identityKey)
    return await this.storage.transaction(async trx => {
      const user = await this.lockUser(source.user.identityKey, trx)
      const k = this.storage.toDb(trx)
      const scope = { userId: user.userId, sourceStorageIdentityKey: source.sourceStorage.storageIdentityKey }
      const previous: SessionRow | undefined = await k('snapshot_sync_sessions').where(scope).first()
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
      return checkpoint(row)
    })
  }

  async prepare(
    input: SnapshotSyncCheckpoint,
    page: WalletSnapshotPage<SnapshotSyncTable>
  ): Promise<() => Promise<SnapshotSyncCommit>> {
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
    let consumed = false
    return async () => {
      if (consumed)
        throw new WERR_INVALID_OPERATION('Prepared snapshot page already consumed; read its durable checkpoint')
      consumed = true
      return await this.storage.transaction(async trx => {
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
        return { checkpoint: checkpoint(row), inserts: result.inserts, updates: result.updates }
      })
    }
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
