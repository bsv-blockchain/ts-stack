import type { Knex } from 'knex'
import type { StorageKnex } from './StorageKnex'
import type { TableSettings, TableUser } from './schema/tables'
import type {
  SnapshotJournalDestinationBinding,
  SnapshotJournalDestinationCheckpoint
} from './snapshot/journal/SnapshotJournalTypes'
import type { SnapshotSyncContentRevision } from './snapshot/SnapshotSyncContentRevision'
import { snapshotSyncContentMetadataDigest, snapshotSyncContentSourceKey } from './snapshot/SnapshotSyncContentRevision'
import { WERR_INVALID_OPERATION } from '../sdk/WERR_errors'
import {
  PRIMARY_HANDOFF_TABLE,
  PRIMARY_HANDOFF_KEY,
  PRIMARY_HANDOFF_COPIES,
  verifyPrimaryHandoffSchema
} from './schema/primaryHandoffMigration'
import { canonicalPrimaryHandoffPlan } from './PrimaryHandoffPlan'
import { snapshotJournalRevision } from './snapshot/journal/SnapshotJournalRevision'
export interface PrimaryCopySourceMetadata {
  sourceStorage: TableSettings
  user: Omit<TableUser, 'activeStorage'> & { activeStorage?: string | null }
  primary: Readonly<{ epoch: string; activeStorage: string | null }>
}
function invalid(): never {
  throw new WERR_INVALID_OPERATION(
    'Primary activation requires actual completed final source copies and a current destination postimage'
  )
}
/** Comparison metadata only, persisted by the ORIGINAL destination financial
 * writer. This does not create or complete any financial ACK or grant. */
export async function recordKnexPrimaryCopyMetadata(
  storage: StorageKnex,
  k: Knex.Transaction,
  binding: SnapshotJournalDestinationBinding,
  checkpoint: SnapshotJournalDestinationCheckpoint,
  content: SnapshotSyncContentRevision,
  metadata: PrimaryCopySourceMetadata | undefined
): Promise<void> {
  if (metadata === undefined) return
  if (!k.isTransaction || k.isCompleted() || storage.toDb(k) !== k) invalid()
  if (!(await k.schema.hasTable(PRIMARY_HANDOFF_TABLE))) return
  const controls: Array<{ operationId: string; plan: string; side: string; phase: string }> = await k(
    PRIMARY_HANDOFF_TABLE
  )
    .where({ userId: binding.destinationUserId, sourceKey: PRIMARY_HANDOFF_KEY })
    .select(k.raw('substr(operationId,1,33) AS operationId'), k.raw('substr(plan,1,8193) AS plan'), 'side', 'phase')
    .limit(2)
  if (controls.length > 1) invalid()
  const control = controls[0]
  if (control === undefined || control.side !== 'target' || control.phase !== 'prepared') return
  await verifyPrimaryHandoffSchema(k)
  const plan = canonicalPrimaryHandoffPlan(JSON.parse(control.plan))
  const source = plan.sources.find(value => value.storageIdentityKey === binding.source.storageIdentity)
  if (
    JSON.stringify(plan) !== control.plan ||
    plan.operationId !== control.operationId ||
    plan.targetStorageIdentityKey !== binding.destinationStorageIdentity ||
    source === undefined
  )
    invalid()
  if (
    metadata.sourceStorage.storageIdentityKey !== source.storageIdentityKey ||
    metadata.user.identityKey !== binding.source.identityKey ||
    metadata.user.userId !== binding.source.userId ||
    metadata.primary.activeStorage !== (metadata.user.activeStorage ?? null) ||
    snapshotSyncContentMetadataDigest({
      binding: content.binding,
      sourceStorage: metadata.sourceStorage,
      user: metadata.user,
      primaryEpoch: metadata.primary.epoch
    }) !== content.metadata
  )
    invalid()
  // A pre-retirement copy may warm the target but cannot qualify activation.
  if (
    metadata.primary.activeStorage !== plan.targetStorageIdentityKey ||
    BigInt(snapshotJournalRevision(metadata.primary.epoch)) !== BigInt(source.epoch) + 1n
  )
    return
  const row = {
    userId: binding.destinationUserId,
    sourceKey: snapshotSyncContentSourceKey(source.storageIdentityKey),
    version: 1,
    operationId: plan.operationId,
    sourceStorageIdentityKey: source.storageIdentityKey,
    sourceEpoch: metadata.primary.epoch,
    activeStorage: metadata.primary.activeStorage,
    sessionId: checkpoint.sessionId,
    sourceMetadata: content.metadata
  }
  await k(PRIMARY_HANDOFF_COPIES).insert(row).onConflict(['userId', 'sourceKey']).merge(row)
}
