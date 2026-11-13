import { recordKnexPrimaryCopyMetadata, type PrimaryCopySourceMetadata } from '../../KnexPrimaryHandoffCopyMetadata'
import { snapshotJournalRevision } from './SnapshotJournalRevision'
import type { Knex } from 'knex'
import type { StorageKnex } from '../../StorageKnex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import {
  SNAPSHOT_JOURNAL_DATA_RECEIPT_MIGRATION,
  SNAPSHOT_JOURNAL_DATA_RECEIPTS,
  verifySnapshotJournalDataReceiptSchema
} from '../../schema/snapshotJournalDataReceiptMigration'
import {
  parseSnapshotSyncContentRevision,
  snapshotSyncContentSourceKey,
  snapshotSyncContentPosition,
  snapshotSyncContentConfirms,
  type SnapshotSyncContentRevision
} from '../SnapshotSyncContentRevision'
import { readCurrentSnapshotJournalContentRevision } from './SnapshotJournalCurrentContentRevision'
import { parseSnapshotJournalDataCheckpoint } from './SnapshotJournalDataProtocol'
import { readSnapshotJournalDestinationWindow } from './SnapshotJournalDestinationWindow'
import type { SnapshotJournalDestinationBinding, SnapshotJournalDestinationCheckpoint } from './SnapshotJournalTypes'
import type { SnapshotJournalDataContentReceipt } from './SnapshotJournalDataContentReceipt'

const textFields = {
  sourceStorageIdentityKey: 130,
  sessionId: 64,
  snapshotId: 64,
  sourceBinding: 64,
  sourceContent: 64,
  sourceMetadata: 64,
  sourceHighWater: 19,
  sourceFloor: 19,
  destinationBinding: 64,
  destinationContent: 64,
  destinationMetadata: 64,
  destinationHighWater: 19,
  destinationFloor: 19,
  primaryEpoch: 19,
  activeStorage: 256,
  checkpointJson: 4096
} as const
function invalid(): never {
  throw new WERR_INVALID_OPERATION('Journal DATA content receipt differs from actual destination custody')
}
function values(prefix: 'source' | 'destination', input: SnapshotSyncContentRevision): Record<string, string> {
  const revision = parseSnapshotSyncContentRevision(input)
  return {
    [prefix + 'Binding']: revision.binding,
    [prefix + 'Content']: revision.content,
    [prefix + 'Metadata']: revision.metadata,
    [prefix + 'HighWater']: revision.highWater,
    [prefix + 'Floor']: revision.floor
  }
}
function revision(
  row: Record<string, unknown>,
  prefix: 'source' | 'destination'
): Readonly<SnapshotSyncContentRevision> {
  return parseSnapshotSyncContentRevision({
    version: 1,
    binding: row[prefix + 'Binding'],
    content: row[prefix + 'Content'],
    metadata: row[prefix + 'Metadata'],
    highWater: row[prefix + 'HighWater'],
    floor: row[prefix + 'Floor']
  })
}
function same(left: SnapshotJournalDestinationCheckpoint, right: SnapshotJournalDestinationCheckpoint): boolean {
  return (
    JSON.stringify(parseSnapshotJournalDataCheckpoint(left)) ===
    JSON.stringify(parseSnapshotJournalDataCheckpoint(right))
  )
}

/** Bookkeeping DATA only, inside the caller's actual original physical writer.
 * Complete is written in the SAME transaction as the real final journal ACK. */
export class KnexSnapshotJournalDataContentReceipts {
  private readonly root: Knex
  constructor(
    private readonly storage: StorageKnex,
    originalRoot: Knex = storage.knex
  ) {
    this.root = originalRoot
  }
  private current(k: Knex.Transaction): void {
    if (this.storage.knex !== this.root || !k.isTransaction || k.isCompleted() || this.storage.toDb(k) !== k) invalid()
  }
  async supports(k: Knex = this.root): Promise<boolean> {
    if (this.storage.knex !== this.root) invalid()
    const migrations = this.root.client.config.migrations?.tableName ?? 'knex_migrations'
    if (
      !(await k.schema.hasTable(migrations)) ||
      (await k(migrations).where('name', SNAPSHOT_JOURNAL_DATA_RECEIPT_MIGRATION).select('name').limit(1)).length === 0
    )
      return false
    await verifySnapshotJournalDataReceiptSchema(k)
    if (this.storage.knex !== this.root) invalid()
    return true
  }
  private key(binding: SnapshotJournalDestinationBinding) {
    return {
      userId: binding.destinationUserId,
      sourceKey: snapshotSyncContentSourceKey(binding.source.storageIdentity)
    }
  }
  private async read(
    k: Knex.Transaction,
    binding: SnapshotJournalDestinationBinding
  ): Promise<Record<string, unknown> | undefined> {
    this.current(k)
    const rows: Array<Record<string, unknown>> = await k(SNAPSHOT_JOURNAL_DATA_RECEIPTS)
      .where(this.key(binding))
      .select(
        'version',
        'complete',
        ...Object.entries(textFields).map(([key, bound]) => k.raw('substr(??,1,?) AS ??', [key, bound + 1, key]))
      )
      .limit(2)
    if (rows.length > 1) invalid()
    const row = rows[0]
    if (row === undefined) return undefined
    if (
      row.version !== 1 ||
      (row.complete !== 0 && row.complete !== 1) ||
      row.sourceStorageIdentityKey !== binding.source.storageIdentity ||
      Object.entries(textFields).some(
        ([name, maximum]) =>
          row[name] !== null && (typeof row[name] !== 'string' || Buffer.byteLength(row[name] as string) > maximum)
      )
    )
      invalid()
    revision(row, 'source')
    return row
  }
  async pending(
    k: Knex.Transaction,
    binding: SnapshotJournalDestinationBinding,
    checkpoint: SnapshotJournalDestinationCheckpoint,
    snapshotId: string,
    input: SnapshotSyncContentRevision | undefined,
    metadata?: PrimaryCopySourceMetadata
  ): Promise<void> {
    this.current(k)
    if (input === undefined || !(await this.supports(k))) return
    const source = parseSnapshotSyncContentRevision(input),
      prior = await this.read(k, binding)
    if (!/^[0-9a-f]{64}$/.test(snapshotId)) invalid()
    await recordKnexPrimaryCopyMetadata(this.storage, k, binding, checkpoint, source, metadata)
    if (prior?.sessionId === checkpoint.sessionId) {
      if (
        prior.snapshotId !== snapshotId ||
        JSON.stringify(revision(prior, 'source')) !==
          JSON.stringify(
            parseSnapshotSyncContentRevision({
              version: 1,
              binding: source.binding,
              content: source.content,
              metadata: source.metadata,
              highWater: source.highWater,
              floor: source.floor
            })
          )
      )
        invalid()
      return
    }
    const row = {
      ...this.key(binding),
      sourceStorageIdentityKey: binding.source.storageIdentity,
      version: 1,
      sessionId: checkpoint.sessionId,
      snapshotId,
      ...values('source', source),
      destinationBinding: null,
      destinationContent: null,
      destinationMetadata: null,
      destinationHighWater: null,
      destinationFloor: null,
      primaryEpoch: null,
      activeStorage: null,
      checkpointJson: null,
      complete: 0
    }
    await k(SNAPSHOT_JOURNAL_DATA_RECEIPTS).insert(row).onConflict(['userId', 'sourceKey']).merge(row)
  }
  async complete(
    k: Knex.Transaction,
    binding: SnapshotJournalDestinationBinding,
    input: SnapshotJournalDestinationCheckpoint
  ): Promise<void> {
    this.current(k)
    if (!(await this.supports(k))) return
    const checkpoint = parseSnapshotJournalDataCheckpoint(input),
      actual = await readSnapshotJournalDestinationWindow(k, binding),
      row = await this.read(k, binding)
    if (checkpoint.phase !== 'acknowledged' || actual === undefined || !same(actual, checkpoint)) invalid()
    if (row === undefined || row.sessionId !== checkpoint.sessionId) return
    if (row.complete !== 0) invalid()
    const destination = await readCurrentSnapshotJournalContentRevision(this.storage, k, binding.source.identityKey)
    if (destination === undefined) return
    const checkpointJson = JSON.stringify(checkpoint)
    if (Buffer.byteLength(checkpointJson) > 4096) invalid()
    if (
      (await k(SNAPSHOT_JOURNAL_DATA_RECEIPTS)
        .where({ ...this.key(binding), sessionId: checkpoint.sessionId, complete: 0 })
        .update({
          ...values('destination', destination),
          primaryEpoch: binding.primaryEpoch,
          activeStorage: binding.activeStorage,
          checkpointJson,
          complete: 1
        })) !== 1
    )
      invalid()
    this.current(k)
  }
  private async primary(k: Knex.Transaction, binding: SnapshotJournalDestinationBinding) {
    this.current(k)
    const users: Array<{ activeStorage: unknown }> = await k('users')
      .where({ userId: binding.destinationUserId, identityKey: binding.source.identityKey })
      .select(k.raw('substr(activeStorage,1,257) AS activeStorage'))
      .limit(2)
    const mysql = ['mysql', 'mysql2'].includes(String(k.client.config.client))
    const epochs: Array<{ epoch: unknown }> = await k('snapshot_sync_primary_epochs')
      .where('userId', binding.destinationUserId)
      .select(k.raw(mysql ? 'CAST(epoch AS CHAR) AS epoch' : 'CAST(epoch AS TEXT) AS epoch'))
      .limit(2)
    if (
      users.length !== 1 ||
      epochs.length > 1 ||
      !(users[0].activeStorage === null || typeof users[0].activeStorage === 'string') ||
      (typeof users[0].activeStorage === 'string' && Buffer.byteLength(users[0].activeStorage) > 256)
    )
      invalid()
    return { activeStorage: users[0].activeStorage, primaryEpoch: snapshotJournalRevision(epochs[0]?.epoch ?? '0') }
  }
  /** Called only AFTER actual primary selection, in its SAME physical writer.
   * The caller must first confirm the actual pre-selection postimage. No source
   * stamp or financial ACK is created or changed here. */
  async recordPrimarySelection(
    k: Knex.Transaction,
    binding: SnapshotJournalDestinationBinding,
    input: SnapshotJournalDestinationCheckpoint,
    activeStorage: string
  ): Promise<void> {
    this.current(k)
    if (!(await this.supports(k))) return
    const checkpoint = parseSnapshotJournalDataCheckpoint(input),
      actual = await readSnapshotJournalDestinationWindow(k, binding),
      row = await this.read(k, binding)
    if (checkpoint.phase !== 'acknowledged' || actual === undefined || !same(actual, checkpoint)) invalid()
    if (row === undefined) return
    if (
      row.complete !== 1 ||
      row.sessionId !== checkpoint.sessionId ||
      typeof row.checkpointJson !== 'string' ||
      !same(parseSnapshotJournalDataCheckpoint(JSON.parse(row.checkpointJson)), checkpoint) ||
      row.primaryEpoch !== binding.primaryEpoch ||
      row.activeStorage !== binding.activeStorage
    )
      invalid()
    const primary = await this.primary(k, binding)
    if (primary.activeStorage !== activeStorage) invalid()
    const destination = await readCurrentSnapshotJournalContentRevision(this.storage, k, binding.source.identityKey)
    if (destination === undefined) return
    if (
      (await k(SNAPSHOT_JOURNAL_DATA_RECEIPTS)
        .where({
          ...this.key(binding),
          complete: 1,
          sessionId: checkpoint.sessionId,
          primaryEpoch: row.primaryEpoch,
          activeStorage: row.activeStorage
        })
        .update({ ...values('destination', destination), ...primary })) !== 1
    )
      invalid()
    this.current(k)
  }
  async previous(
    k: Knex.Transaction,
    binding: SnapshotJournalDestinationBinding,
    input: SnapshotJournalDestinationCheckpoint
  ): Promise<Readonly<SnapshotJournalDataContentReceipt> | undefined> {
    this.current(k)
    if (!(await this.supports(k)) || input.phase !== 'acknowledged') return undefined
    const actual = await readSnapshotJournalDestinationWindow(k, binding),
      row = await this.read(k, binding)
    if (
      actual === undefined ||
      !same(actual, input) ||
      row?.complete !== 1 ||
      row.sessionId !== input.sessionId ||
      typeof row.checkpointJson !== 'string'
    )
      return undefined
    const checkpoint = parseSnapshotJournalDataCheckpoint(JSON.parse(row.checkpointJson))
    if (!same(checkpoint, actual)) return undefined
    // This is an observation of the OLD ACK, not current primary authority.
    // Fresh primary/postimage comparison belongs to confirmation below, so a
    // changed primary can trigger a new bootstrap without first recapturing a
    // known-stale incremental artifact.
    snapshotJournalRevision(row.primaryEpoch)
    revision(row, 'destination')
    return {
      version: 1,
      kind: 'journal-data',
      identityKey: binding.source.identityKey,
      sourceStorageIdentity: binding.source.storageIdentity,
      destinationStorageIdentity: binding.destinationStorageIdentity,
      checkpoint,
      source: revision(row, 'source')
    }
  }
  /** A new source delta cannot repair unrelated destination drift. This
   * comparison runs before successor admission in the same actual writer. */
  async destinationMatches(
    k: Knex.Transaction,
    binding: SnapshotJournalDestinationBinding,
    checkpoint: SnapshotJournalDestinationCheckpoint
  ): Promise<boolean | undefined> {
    const previous = await this.previous(k, binding, checkpoint)
    if (previous === undefined) return undefined
    const row = await this.read(k, binding)
    if (row === undefined) invalid()
    const oldDestination = revision(row, 'destination')
    const destination = await readCurrentSnapshotJournalContentRevision(
      this.storage,
      k,
      binding.source.identityKey,
      snapshotSyncContentPosition(oldDestination)
    )
    this.current(k)
    return destination !== undefined && snapshotSyncContentConfirms(oldDestination, destination)
  }
  async confirm(
    k: Knex.Transaction,
    binding: SnapshotJournalDestinationBinding,
    checkpoint: SnapshotJournalDestinationCheckpoint,
    input: SnapshotSyncContentRevision,
    expectedActiveStorage?: string | null
  ): Promise<Readonly<SnapshotJournalDataContentReceipt> | undefined> {
    const source = parseSnapshotSyncContentRevision(input),
      previous = await this.previous(k, binding, checkpoint)
    if (previous === undefined || !snapshotSyncContentConfirms(previous.source, source)) return undefined
    const row = await this.read(k, binding)
    if (row === undefined) invalid()
    const primary = await this.primary(k, binding)
    if (
      row.primaryEpoch !== primary.primaryEpoch ||
      row.activeStorage !== primary.activeStorage ||
      (expectedActiveStorage !== undefined && primary.activeStorage !== expectedActiveStorage)
    )
      return undefined
    const oldDestination = revision(row, 'destination'),
      destination = await readCurrentSnapshotJournalContentRevision(
        this.storage,
        k,
        binding.source.identityKey,
        snapshotSyncContentPosition(oldDestination)
      )
    if (destination === undefined || !snapshotSyncContentConfirms(oldDestination, destination)) return undefined
    const next = { ...values('source', source), ...values('destination', destination) }
    if (Object.entries(next).some(([key, value]) => row[key] !== value)) {
      if (
        (await k(SNAPSHOT_JOURNAL_DATA_RECEIPTS)
          .where({ ...this.key(binding), sessionId: checkpoint.sessionId, complete: 1 })
          .update(next)) !== 1
      )
        invalid()
    }
    this.current(k)
    return {
      version: 1,
      kind: 'journal-data',
      identityKey: binding.source.identityKey,
      sourceStorageIdentity: binding.source.storageIdentity,
      destinationStorageIdentity: binding.destinationStorageIdentity,
      checkpoint: previous.checkpoint,
      source
    }
  }
}
