import { createHash } from 'node:crypto'
import type { SnapshotJournalDestinationBinding } from './SnapshotJournalDestinationWindow'
import { snapshotJournalReceiptBinding } from './SnapshotJournalReceipt'

/** Durable association scope is DATA. Every actual operation must independently
 * establish current source and destination authority before using its rows. V1
 * retains the original per-generation scope. V2 groups full reconciliation data
 * by authenticated profile and physical destination, permitting a fresh full
 * scan to repair a replaced source or changed destination primary. */
export function snapshotJournalLineage(binding: SnapshotJournalDestinationBinding): string {
  if (binding.lineageVersion === 2) {
    snapshotJournalReceiptBinding(binding.source)
    return createHash('sha256')
      .update('snapshot-journal-profile-lineage-v2\n')
      .update(
        JSON.stringify([
          binding.source.storageIdentity,
          binding.source.identityKey,
          binding.source.chain,
          binding.destinationBackend,
          binding.destinationStorageIdentity,
          binding.destinationUserId
        ])
      )
      .digest('hex')
  }
  return snapshotJournalAssociationGeneration(binding)
}

/** Records which admitted generation produced an association; never a cached
 * approval to reuse an ID, source schema, backend or primary selection. */
export function snapshotJournalAssociationGeneration(binding: SnapshotJournalDestinationBinding): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        snapshotJournalReceiptBinding(binding.source),
        binding.destinationBackend,
        binding.destinationStorageIdentity,
        binding.destinationUserId,
        binding.primaryEpoch,
        binding.activeStorage
      ])
    )
    .digest('hex')
}
