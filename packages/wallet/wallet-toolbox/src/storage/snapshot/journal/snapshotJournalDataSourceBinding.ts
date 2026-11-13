import type { SnapshotSyncContentRevision } from '../SnapshotSyncContentRevision'
import type { SnapshotJournalReconciliationSource } from './SnapshotJournalProvider'
import type { SnapshotJournalDataStatus } from './SnapshotJournalDataProtocol'
import { compareSnapshotJournalRevisions, snapshotJournalRevision } from './SnapshotJournalRevision'
import { parseSnapshotJournalArchiveBinding, type SnapshotJournalArchiveBinding } from './SnapshotJournalArchiveBinding'
import { snapshotJournalArchiveEncoding } from './SnapshotJournalArchivePacket'

/** Metadata from the ACTUAL retained source; this function grants no writer or
 * SQL fence. A current destination BEGIN still independently validates lineage. */
export function snapshotJournalDataSourceBinding(
  source: SnapshotJournalReconciliationSource,
  previous?: SnapshotJournalDataStatus,
  forceBootstrap = false,
  contentRevision?: SnapshotSyncContentRevision
): SnapshotJournalArchiveBinding {
  const receipt = source.receipt,
    position = previous?.checkpoint.phase === 'acknowledged' ? previous.binding.receipt : undefined
  const same = position !== undefined && position.binding === receipt.binding
  if (same && compareSnapshotJournalRevisions(position.highWater, receipt.highWater) > 0)
    throw new TypeError('Destination journal position exceeds the actual retained source')
  const incremental = !forceBootstrap && same && compareSnapshotJournalRevisions(position.highWater, receipt.floor) >= 0
  return parseSnapshotJournalArchiveBinding({
    version: 3,
    encoding: snapshotJournalArchiveEncoding,
    snapshotId: source.snapshotId,
    sourceStorage: source.sourceStorage,
    sourceSchema: source.sourceSchema,
    user: source.user,
    journal: {
      source: source.receiptBinding,
      receipt,
      low: incremental ? position.highWater : snapshotJournalRevision('0'),
      bootstrap: !incremental,
      primary: source.primary,
      ...(contentRevision === undefined ? {} : { contentRevision })
    }
  })
}
