import type { Knex } from 'knex'
import type { StorageKnex } from './StorageKnex'
import type { PrimaryHandoffPlan } from './PrimaryHandoffControl'
import type {
  SnapshotJournalDestinationBinding,
  SnapshotJournalDestinationCheckpoint
} from './snapshot/journal/SnapshotJournalTypes'
import { snapshotSyncContentSourceKey } from './snapshot/SnapshotSyncContentRevision'
import { WERR_INVALID_OPERATION } from '../sdk/WERR_errors'
import { PRIMARY_HANDOFF_COPIES } from './schema/primaryHandoffMigration'
import { snapshotJournalRevision } from './snapshot/journal/SnapshotJournalRevision'
import { readSnapshotJournalStoredWindow } from './snapshot/journal/SnapshotJournalDestinationWindow'
import { KnexSnapshotJournalDataContentReceipts } from './snapshot/journal/KnexSnapshotJournalDataContentReceipts'

function invalid(): never {
  throw new WERR_INVALID_OPERATION(
    'Primary activation requires actual completed final source copies and a current destination postimage'
  )
}
/** All participants need their actual completed financial ACK. Only the final
 * cumulative postimage must still match: later contributors legitimately change
 * earlier postimages. No status DATA or caller-provided success is accepted. */
export async function requireKnexPrimaryCopies(
  storage: StorageKnex,
  k: Knex.Transaction,
  userId: number,
  identityKey: string,
  plan: PrimaryHandoffPlan
) {
  const receipts = new KnexSnapshotJournalDataContentReceipts(storage)
  if (!(await receipts.supports(k))) invalid()
  let final:
    { binding: SnapshotJournalDestinationBinding; checkpoint: SnapshotJournalDestinationCheckpoint } | undefined
  for (const source of plan.sources) {
    const stamps: Array<Record<string, unknown>> = await k(PRIMARY_HANDOFF_COPIES)
      .where({ userId, sourceKey: snapshotSyncContentSourceKey(source.storageIdentityKey) })
      .select(
        'version',
        ...Object.entries({
          operationId: 32,
          sourceStorageIdentityKey: 130,
          sourceEpoch: 19,
          activeStorage: 130,
          sessionId: 64,
          sourceMetadata: 64
        }).map(([key, bound]) => k.raw('substr(??,1,?) AS ??', [key, bound + 1, key]))
      )
      .limit(2)
    const stamp = stamps[0]
    if (
      stamps.length !== 1 ||
      stamp.version !== 1 ||
      stamp.operationId !== plan.operationId ||
      stamp.sourceStorageIdentityKey !== source.storageIdentityKey ||
      stamp.activeStorage !== plan.targetStorageIdentityKey ||
      BigInt(snapshotJournalRevision(stamp.sourceEpoch)) !== BigInt(source.epoch) + 1n
    )
      invalid()
    const windows: Array<{ bindingJson: unknown }> = await k('snapshot_reconciliation_windows')
      .where({ userId, sourceStorageIdentity: source.storageIdentityKey })
      .select(k.raw('substr(bindingJson,1,4097) AS bindingJson'))
      .limit(2)
    if (
      windows.length !== 1 ||
      typeof windows[0].bindingJson !== 'string' ||
      Buffer.byteLength(windows[0].bindingJson) > 4096
    )
      invalid()
    const binding = JSON.parse(windows[0].bindingJson) as SnapshotJournalDestinationBinding
    if (
      binding.source?.storageIdentity !== source.storageIdentityKey ||
      binding.source.identityKey !== identityKey ||
      binding.source.chain !== storage.chain ||
      binding.destinationUserId !== userId ||
      binding.destinationStorageIdentity !== plan.targetStorageIdentityKey
    )
      invalid()
    const actual = await readSnapshotJournalStoredWindow(k, binding)
    if (
      actual === undefined ||
      actual.retired ||
      actual.checkpoint.phase !== 'acknowledged' ||
      actual.checkpoint.sessionId !== stamp.sessionId
    )
      invalid()
    const completed = await receipts.previous(k, actual.binding, actual.checkpoint)
    if (completed === undefined || completed.source.metadata !== stamp.sourceMetadata) invalid()
    if ((await receipts.destinationMatches(k, actual.binding, actual.checkpoint)) === true) final = actual
  }
  if (final === undefined) invalid()
  return { ...final, receipts }
}
