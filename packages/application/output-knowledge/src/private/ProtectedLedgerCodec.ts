import {
  ownOutputJSON,
  canonicalOutputJSON,
  createClosedOutputObjectValidator,
  outputAssert,
  outputHex32,
  outputU64,
  type OutputJSONObject
} from '@bsv/sdk'
import { createHash } from 'node:crypto'

type ClosedFields = (value: unknown) => asserts value is Record<string, unknown>
// Only fixed field names are retained. Ownership, descriptors and values are
// independently checked for every supplied record.
const addressFields: ClosedFields = createClosedOutputObjectValidator(['kind', 'key'])
const configurationFields: ClosedFields = createClosedOutputObjectValidator([
  'storeId',
  'binding',
  'maximumRecords',
  'maximumReservedBytes',
  'maximumRecordBytes'
])

/** Internal ledger port. Service state machines own every record's semantics. */
export const protectedLedgerKinds = [
  'publication',
  'request-fence',
  'prefix-fence',
  'funding-fence',
  'quote',
  'candidate',
  'acquisition',
  'wallet',
  'admission',
  'delivery',
  'rules'
] as const
export type ProtectedLedgerKind = (typeof protectedLedgerKinds)[number]
export interface ProtectedLedgerAddress {
  kind: ProtectedLedgerKind
  key: string
}
export interface ProtectedLedgerRecord extends ProtectedLedgerAddress {
  revision: string
  reservedBytes: number
  reservedUpdates: number
  value: OutputJSONObject
}
export interface ProtectedLedgerChange extends ProtectedLedgerAddress {
  /** Null creates an explicitly reserved slot; an existing slot always requires its version. */
  expectedRevision: string | null
  reservedBytes: number
  reservedUpdates: number
  value: OutputJSONObject
}
export interface ProtectedLedgerConfiguration {
  /** Persist this identity outside the database; open never creates another identity. */
  storeId: string
  binding: OutputJSONObject
  maximumRecords: number
  maximumReservedBytes: number
  maximumRecordBytes: number
}
export interface ProtectedLedgerView {
  revision: string
  observedAt: string
  get(address: ProtectedLedgerAddress): ProtectedLedgerRecord | undefined
}
export type ProtectedLedgerGuard = (view: ProtectedLedgerView) => void
export interface ProtectedLedgerHead {
  revision: string
  observedAt: string
  records: number
  reservedBytes: number
  reservedUpdates: number
  inventory: string
}
export interface ProtectedLedgerHeader extends ProtectedLedgerAddress {
  revision: string
  reservedBytes: number
  reservedUpdates: number
  bytes: number
  sealedDigest: string
}

export function protectedDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
export function protectedUpdates(value: unknown): number {
  outputAssert(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 64,
    'Invalid protected record completion reservation'
  )
  return value
}
export function protectedRevisionCapacity(revision: string, reservedUpdates: number): void {
  outputAssert(
    Number.isSafeInteger(reservedUpdates) && reservedUpdates >= 0 && reservedUpdates <= 262144,
    'Invalid protected ledger completion capacity'
  )
  outputAssert(
    outputU64(revision) + BigInt(reservedUpdates) <= 18446744073709551615n,
    'Protected ledger must retain promised completion revisions',
    'limited'
  )
}
export function protectedInteger(value: unknown, maximum: number): number {
  outputAssert(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= maximum,
    'Invalid protected ledger capacity'
  )
  return value
}
export function protectedAddress(value: unknown): ProtectedLedgerAddress {
  const input = ownOutputJSON(value, { bytes: 1024 }).value
  addressFields(input)
  outputAssert(
    protectedLedgerKinds.includes(input.kind as ProtectedLedgerKind),
    'Invalid protected ledger record kind'
  )
  return { kind: input.kind as ProtectedLedgerKind, key: outputHex32(input.key) }
}
export function protectedConfiguration(
  value: ProtectedLedgerConfiguration
): ProtectedLedgerConfiguration {
  const input = ownOutputJSON(value, { bytes: 32768 }).value
  configurationFields(input)
  outputAssert(
    input.binding !== null && typeof input.binding === 'object' && !Array.isArray(input.binding),
    'Invalid protected ledger binding'
  )
  return {
    storeId: outputHex32(input.storeId),
    binding: input.binding as OutputJSONObject,
    maximumRecords: protectedInteger(input.maximumRecords, 4096),
    maximumReservedBytes: protectedInteger(input.maximumReservedBytes, 64 * 1024 * 1024),
    maximumRecordBytes: protectedInteger(input.maximumRecordBytes, 2 * 1024 * 1024)
  }
}
export function protectedValue(
  value: unknown,
  maximum: number
): { text: string; value: OutputJSONObject } {
  const { text, value: owned } = ownOutputJSON(value, { bytes: maximum })
  outputAssert(
    owned !== null && typeof owned === 'object' && !Array.isArray(owned),
    'Protected ledger record must be an object'
  )
  return { text, value: owned as OutputJSONObject }
}
export function protectedHeader(
  input: Record<string, unknown>,
  maximum: number
): ProtectedLedgerHeader {
  // Capture each native field once, as in the original constructed address.
  const fields = { kind: input.kind, key: input.key }
  // These two owned ASCII scalars are always below the 1,024-byte address
  // ceiling. Other representations retain the original ownership/error path.
  const address: ProtectedLedgerAddress =
    typeof fields.kind === 'string' &&
    /^[a-z-]{1,13}$/.test(fields.kind) &&
    protectedLedgerKinds.includes(fields.kind as ProtectedLedgerKind) &&
    typeof fields.key === 'string' &&
    /^[0-9a-f]{64}$/.test(fields.key)
      ? { kind: fields.kind as ProtectedLedgerKind, key: outputHex32(fields.key) }
      : protectedAddress(fields)
  const revision = outputU64(input.revision).toString()
  outputAssert(revision !== '0', 'Invalid protected record revision', 'unavailable')
  return {
    ...address,
    revision,
    reservedBytes: protectedInteger(input.reservedBytes, maximum),
    reservedUpdates: protectedUpdates(input.reservedUpdates),
    bytes: protectedInteger(input.bytes, maximum),
    sealedDigest: outputHex32(input.sealedDigest)
  }
}
export function protectedInventory(
  headers: ProtectedLedgerHeader[],
  maximumRecords: number,
  maximumReservedBytes: number
): Pick<ProtectedLedgerHead, 'inventory' | 'records' | 'reservedBytes' | 'reservedUpdates'> {
  outputAssert(
    headers.length <= maximumRecords,
    'Protected ledger record capacity exceeded',
    'unavailable'
  )
  let reservedBytes = 0,
    reservedUpdates = 0
  const hash = createHash('sha256').update('output-protected-ledger/inventory/1\0')
  for (const header of headers) {
    outputAssert(
      header.bytes <= header.reservedBytes,
      'Protected record exceeds its reserved capacity',
      'unavailable'
    )
    reservedBytes += header.reservedBytes
    reservedUpdates += header.reservedUpdates
    hash.update(canonicalOutputJSON(header) + '\n')
  }
  outputAssert(
    reservedBytes <= maximumReservedBytes,
    'Protected ledger allocation capacity exceeded',
    'unavailable'
  )
  return { inventory: hash.digest('hex'), records: headers.length, reservedBytes, reservedUpdates }
}
