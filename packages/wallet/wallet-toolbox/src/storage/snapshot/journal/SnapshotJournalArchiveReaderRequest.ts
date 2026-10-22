import { sha256 } from '@bsv/sdk/primitives/Hash'
import { toHex } from '@bsv/sdk/primitives/utils'
import { snapshotArchiveLimits } from '../archive/SnapshotArchive'
import {
  parseSnapshotJournalArchivePosition,
  snapshotJournalDataDigest,
  snapshotJournalDataRecord,
  type SnapshotJournalArchivePosition
} from './SnapshotJournalReceiptData'

/** A distinct server-issued DATA tuple. Admission still requires the actual
 * authenticated offered row; a digest never creates or renews an owner. */
export interface SnapshotJournalArchiveReaderRequest {
  readonly version: 3
  readonly nonce: string
  readonly notAfter: number
  readonly maxBytes: number
  readonly position: Readonly<SnapshotJournalArchivePosition> | null
  readonly requestId: string
}
function invalid(): never {
  throw new TypeError('Invalid snapshot journal archive reader request')
}
function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid()
  return value
}

/** Domain and lower bound prevent a retry on another replica from changing
 * this request into a row/content capture or a different incremental window. */
export function snapshotJournalArchiveReaderRequestId(
  input: Omit<SnapshotJournalArchiveReaderRequest, 'requestId'>
): string {
  const row = snapshotJournalDataRecord(input, ['version', 'nonce', 'notAfter', 'maxBytes', 'position'])
  if (row.version !== 3) invalid()
  const nonce = snapshotJournalDataDigest(row.nonce),
    notAfter = integer(row.notAfter, 1, Number.MAX_SAFE_INTEGER),
    maxBytes = integer(row.maxBytes, snapshotArchiveLimits.headerCharge + 1, snapshotArchiveLimits.archiveBytes),
    position = parseSnapshotJournalArchivePosition(row.position)
  return toHex(
    sha256(
      new TextEncoder().encode(
        JSON.stringify([
          'wallet-journal-reader-request/1',
          3,
          nonce,
          notAfter,
          maxBytes,
          position === undefined ? null : [position.binding, position.highWater]
        ])
      )
    )
  )
}

export function parseSnapshotJournalArchiveReaderRequest(
  input: unknown
): Readonly<SnapshotJournalArchiveReaderRequest> {
  const row = snapshotJournalDataRecord(input, ['version', 'nonce', 'notAfter', 'maxBytes', 'position', 'requestId'])
  if (row.version !== 3) invalid()
  const fields = {
      version: 3 as const,
      nonce: snapshotJournalDataDigest(row.nonce),
      notAfter: integer(row.notAfter, 1, Number.MAX_SAFE_INTEGER),
      maxBytes: integer(row.maxBytes, snapshotArchiveLimits.headerCharge + 1, snapshotArchiveLimits.archiveBytes),
      position: parseSnapshotJournalArchivePosition(row.position) ?? null
    },
    requestId = snapshotJournalArchiveReaderRequestId(fields)
  if (snapshotJournalDataDigest(row.requestId) !== requestId) invalid()
  return Object.freeze({ ...fields, requestId })
}

export function validateSnapshotJournalArchiveReaderRequest(
  input: unknown,
  now: number
): Readonly<SnapshotJournalArchiveReaderRequest> {
  const request = parseSnapshotJournalArchiveReaderRequest(input)
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    request.notAfter <= now ||
    request.notAfter - now > snapshotArchiveLimits.lifetimeMs
  )
    invalid()
  return request
}

/** Separate field nonce/domain. Only an actual matching offered SQL row can
 * admit capture; a recomputed tuple never creates or renews an owner. */
export interface SnapshotJournalFieldArchiveReaderRequest {
  readonly version: 4
  readonly nonce: string
  readonly notAfter: number
  readonly maxBytes: number
  readonly position: Readonly<SnapshotJournalArchivePosition> | null
  readonly requestId: string
}
/** Domain and lower bound prevent a retry on another replica from changing
 * this request into a row/content capture or a different incremental window. */
export function snapshotJournalFieldArchiveReaderRequestId(
  input: Omit<SnapshotJournalFieldArchiveReaderRequest, 'requestId'>
): string {
  const row = snapshotJournalDataRecord(input, ['version', 'nonce', 'notAfter', 'maxBytes', 'position'])
  if (row.version !== 4) invalid()
  const nonce = snapshotJournalDataDigest(row.nonce),
    notAfter = integer(row.notAfter, 1, Number.MAX_SAFE_INTEGER),
    maxBytes = integer(row.maxBytes, snapshotArchiveLimits.headerCharge + 1, snapshotArchiveLimits.archiveBytes),
    position = parseSnapshotJournalArchivePosition(row.position)
  return toHex(
    sha256(
      new TextEncoder().encode(
        JSON.stringify([
          'wallet-journal-field-reader-request/1',
          4,
          nonce,
          notAfter,
          maxBytes,
          position === undefined ? null : [position.binding, position.highWater]
        ])
      )
    )
  )
}

export function parseSnapshotJournalFieldArchiveReaderRequest(
  input: unknown
): Readonly<SnapshotJournalFieldArchiveReaderRequest> {
  const row = snapshotJournalDataRecord(input, ['version', 'nonce', 'notAfter', 'maxBytes', 'position', 'requestId'])
  if (row.version !== 4) invalid()
  const fields = {
      version: 4 as const,
      nonce: snapshotJournalDataDigest(row.nonce),
      notAfter: integer(row.notAfter, 1, Number.MAX_SAFE_INTEGER),
      maxBytes: integer(row.maxBytes, snapshotArchiveLimits.headerCharge + 1, snapshotArchiveLimits.archiveBytes),
      position: parseSnapshotJournalArchivePosition(row.position) ?? null
    },
    requestId = snapshotJournalFieldArchiveReaderRequestId(fields)
  if (snapshotJournalDataDigest(row.requestId) !== requestId) invalid()
  return Object.freeze({ ...fields, requestId })
}

export function validateSnapshotJournalFieldArchiveReaderRequest(
  input: unknown,
  now: number
): Readonly<SnapshotJournalFieldArchiveReaderRequest> {
  const request = parseSnapshotJournalFieldArchiveReaderRequest(input)
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    request.notAfter <= now ||
    request.notAfter - now > snapshotArchiveLimits.lifetimeMs
  )
    invalid()
  return request
}
