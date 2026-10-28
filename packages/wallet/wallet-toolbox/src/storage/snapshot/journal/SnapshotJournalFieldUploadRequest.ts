import { syncTransferDigest } from '../../remoting/SyncTransfer'
import { snapshotArchiveLimits } from '../archive/SnapshotArchive'
import {
  snapshotJournalFieldArchiveReaderRequestId,
  parseSnapshotJournalFieldArchiveReaderRequest,
  type SnapshotJournalFieldArchiveReaderRequest
} from './SnapshotJournalArchiveReaderRequest'
import { snapshotJournalDataDigest, snapshotJournalDataRecord } from './SnapshotJournalReceiptData'
import {
  parseSnapshotJournalFieldArchiveBinding,
  type SnapshotJournalFieldArchiveBinding
} from './SnapshotJournalArchiveBinding'

/** A separate durable target-upload namespace. It cannot admit a source capture. */
export interface SnapshotJournalFieldUploadRequest extends Omit<SnapshotJournalFieldArchiveReaderRequest, 'version'> {
  readonly version: 5
  readonly sourceDigest: string
}
export function snapshotJournalFieldUploadSourceDigest(input: SnapshotJournalFieldArchiveBinding): string {
  return syncTransferDigest(new TextEncoder().encode(JSON.stringify(parseSnapshotJournalFieldArchiveBinding(input))))
}
export function snapshotJournalFieldUploadRequestId(
  input: Omit<SnapshotJournalFieldUploadRequest, 'requestId'>
): string {
  return syncTransferDigest(
    new TextEncoder().encode(
      JSON.stringify([
        'wallet-journal-field-upload-request/1',
        input.nonce,
        input.notAfter,
        input.maxBytes,
        input.position === null ? null : [input.position.binding, input.position.highWater],
        input.sourceDigest
      ])
    )
  )
}
export function parseSnapshotJournalFieldUploadRequest(
  input: unknown,
  now?: number
): Readonly<SnapshotJournalFieldUploadRequest> {
  const row = snapshotJournalDataRecord(input, [
    'version',
    'nonce',
    'notAfter',
    'maxBytes',
    'position',
    'sourceDigest',
    'requestId'
  ])
  if (row.version !== 5) throw new TypeError('Invalid field upload request namespace')
  // Reuse the original coordinate parser, without treating the temporary tuple
  // as an offered reader or passing it to source admission.
  const fields = {
    version: 4 as const,
    nonce: row.nonce,
    notAfter: row.notAfter,
    maxBytes: row.maxBytes,
    position: row.position
  }
  const coordinates = parseSnapshotJournalFieldArchiveReaderRequest({
    ...fields,
    requestId: snapshotJournalFieldArchiveReaderRequestId(
      fields as Omit<SnapshotJournalFieldArchiveReaderRequest, 'requestId'>
    )
  })
  const result = { ...coordinates, version: 5 as const, sourceDigest: snapshotJournalDataDigest(row.sourceDigest) }
  if (
    row.requestId !== snapshotJournalFieldUploadRequestId(result) ||
    (now !== undefined &&
      (!Number.isSafeInteger(now) ||
        now < 0 ||
        result.notAfter <= now ||
        result.notAfter - now > snapshotArchiveLimits.lifetimeMs))
  )
    throw new TypeError('Invalid field upload request bounds')
  return Object.freeze({ ...result, requestId: row.requestId as string })
}
