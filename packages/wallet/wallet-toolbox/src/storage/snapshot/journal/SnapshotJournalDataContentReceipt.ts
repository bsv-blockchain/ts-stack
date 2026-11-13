import { snapshotJournalDataRecord, snapshotJournalDataText } from './SnapshotJournalReceiptData'
import { parseSnapshotJournalDataCheckpoint } from './SnapshotJournalDataProtocol'
import { parseSnapshotSyncContentRevision, type SnapshotSyncContentRevision } from '../SnapshotSyncContentRevision'
import type { SnapshotJournalDestinationCheckpoint } from './SnapshotJournalTypes'

/** Names an ACTUAL previously completed journal ACK, never a new copy/session. */
export interface SnapshotJournalDataContentReceipt {
  readonly version: 1
  readonly kind: 'journal-data'
  readonly identityKey: string
  readonly sourceStorageIdentity: string
  readonly destinationStorageIdentity: string
  readonly checkpoint: SnapshotJournalDestinationCheckpoint
  readonly source: Readonly<SnapshotSyncContentRevision>
}
export function parseSnapshotJournalDataContentReceipt(input: unknown): Readonly<SnapshotJournalDataContentReceipt> {
  const row = snapshotJournalDataRecord(input, [
      'version',
      'kind',
      'identityKey',
      'sourceStorageIdentity',
      'destinationStorageIdentity',
      'checkpoint',
      'source'
    ]),
    checkpoint = parseSnapshotJournalDataCheckpoint(row.checkpoint)
  if (
    row.version !== 1 ||
    row.kind !== 'journal-data' ||
    checkpoint.phase !== 'acknowledged' ||
    checkpoint.sequence < 15
  )
    throw new TypeError('Invalid completed journal DATA receipt')
  const identityKey = snapshotJournalDataText(row.identityKey, 66, 66)
  if (!/^(02|03)[0-9a-f]{64}$/.test(identityKey)) throw new TypeError('Invalid journal DATA receipt identity')
  return Object.freeze({
    version: 1,
    kind: 'journal-data',
    identityKey,
    sourceStorageIdentity: snapshotJournalDataText(row.sourceStorageIdentity, 130, 1),
    destinationStorageIdentity: snapshotJournalDataText(row.destinationStorageIdentity, 256, 1),
    checkpoint: Object.freeze(checkpoint),
    source: parseSnapshotSyncContentRevision(row.source)
  })
}
