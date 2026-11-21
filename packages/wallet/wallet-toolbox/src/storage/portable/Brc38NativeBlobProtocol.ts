import { detachBrc38PrivateChunk } from './Brc38PrivateChunkPipe'

/** Internal ABI data only. Native caller/session/transaction, original profile,
 * current schema/primary and source-field lifetime are admitted independently. */
export interface Brc38NativeBlobWrite {
  table: 'transactions' | 'provenTxs' | 'provenTxReqs' | 'outputs' | 'commissions'
  field: 'rawTx' | 'inputBEEF' | 'noSendExpiryReclaimRawTx' | 'merklePath' | 'lockingScript'
  rowId: number
  offset: number
  totalBytes: number
  bytes: Uint8Array
}
const tables = ['transactions', 'provenTxs', 'provenTxReqs', 'outputs', 'commissions'] as const
const columns: Readonly<Record<Brc38NativeBlobWrite['table'], readonly string[]>> = {
  transactions: ['rawTx', 'inputBEEF', 'noSendExpiryReclaimRawTx'],
  provenTxs: ['rawTx', 'merklePath'],
  provenTxReqs: ['rawTx', 'inputBEEF'],
  outputs: ['lockingScript'],
  commissions: ['lockingScript']
}
export interface Brc38NativeBlobRead extends Omit<Brc38NativeBlobWrite, 'bytes'> {
  readonly length: number
}
/** Separate read-only TEXT coordinates. The binary writer whitelist and every
 * existing binary coordinate remain unchanged. No marker or path is authority. */
export interface Brc38NativeTextRead {
  table:
    'provenTxReqs' | 'syncStates' | 'transactions' | 'outputs' | 'commissions' | 'certificates' | 'certificateFields'
  field:
    | 'history'
    | 'notify'
    | 'syncMap'
    | 'errorLocal'
    | 'errorOther'
    | 'description'
    | 'noSendExpiryReclaimDerivationPrefix'
    | 'noSendExpiryReclaimDerivationSuffix'
    | 'outputDescription'
    | 'spendingDescription'
    | 'customInstructions'
    | 'derivationPrefix'
    | 'derivationSuffix'
    | 'type'
    | 'purpose'
    | 'keyOffset'
    | 'subject'
    | 'revocationOutpoint'
    | 'signature'
    | 'verifier'
    | 'fieldValue'
    | 'masterKey'
  rowId: number
  offset: number
  totalBytes: number
  length: number
}
const rawTextCoordinates: Partial<Record<Brc38NativeTextRead['table'], readonly string[]>> = {
  transactions: ['description', 'noSendExpiryReclaimDerivationPrefix', 'noSendExpiryReclaimDerivationSuffix'],
  outputs: [
    'outputDescription',
    'spendingDescription',
    'customInstructions',
    'derivationPrefix',
    'derivationSuffix',
    'type',
    'purpose'
  ],
  commissions: ['keyOffset'],
  certificates: ['subject', 'revocationOutpoint', 'signature', 'verifier'],
  certificateFields: ['fieldValue', 'masterKey']
}
for (const fields of Object.values(rawTextCoordinates)) Object.freeze(fields)
Object.freeze(rawTextCoordinates)
export function brc38NativeTextCoordinate(
  table: Brc38NativeTextRead['table'],
  field: Brc38NativeTextRead['field']
): readonly [number, number] {
  if (table === 'provenTxReqs' && field === 'history') return [2, 2]
  if (table === 'provenTxReqs' && field === 'notify') return [2, 3]
  if (table === 'syncStates' && field === 'syncMap') return [5, 0]
  if (table === 'syncStates' && field === 'errorLocal') return [5, 1]
  if (table === 'syncStates' && field === 'errorOther') return [5, 2]
  const fields = rawTextCoordinates[table],
    ordinal = fields?.indexOf(field) ?? -1
  if (ordinal >= 0) {
    if (table === 'transactions') return [0, ordinal + 3]
    if (table === 'outputs') return [3, ordinal + 1]
    if (table === 'commissions') return [4, ordinal + 1]
    if (table === 'certificates') return [6, ordinal]
    if (table === 'certificateFields') return [7, ordinal]
  }
  throw new TypeError('Invalid native structured TEXT coordinate')
}
/** The original packed structured family has only these coordinates. Newly
 * added raw TEXT reads never imply that a destination can stage those fields. */
export function brc38NativeStructuredTextTable(table: Brc38NativeTextRead['table']): boolean {
  return table === 'provenTxReqs' || table === 'syncStates'
}
export function brc38NativeTextProtocolSupports(table: Brc38NativeTextRead['table'], abi: number): boolean {
  return brc38NativeStructuredTextTable(table)
    ? abi === 1 || abi === 2
    : Object.hasOwn(rawTextCoordinates, table) && abi === 2
}
export function encodeBrc38NativeTextRead(input: Brc38NativeTextRead): Uint8Array {
  const coordinate = brc38NativeTextCoordinate(input.table, input.field)
  if (
    !Number.isSafeInteger(input.rowId) ||
    !Number.isSafeInteger(input.totalBytes) ||
    input.totalBytes < 1 ||
    input.totalBytes > 1000000000 ||
    !Number.isSafeInteger(input.offset) ||
    input.offset < 0 ||
    input.offset >= input.totalBytes ||
    !Number.isSafeInteger(input.length) ||
    input.length < 1 ||
    input.length > 65536 ||
    input.length > input.totalBytes - input.offset
  )
    throw new TypeError('Invalid native structured TEXT extent')
  const body = new Uint8Array(28),
    view = new DataView(body.buffer)
  body[0] = coordinate[0]
  body[1] = coordinate[1]
  view.setBigInt64(4, BigInt(input.rowId), true)
  view.setUint32(12, input.offset, true)
  view.setUint32(16, input.totalBytes, true)
  view.setUint32(20, input.length, true)
  return body
}
/** Operation7 uses the same independent coordinate layout without a payload.
 * This is a request for one owned extent, never SQL or a backend capability. */
export function encodeBrc38NativeBlobRead(input: Brc38NativeBlobRead): Uint8Array {
  const { table, field, rowId, offset, totalBytes, length } = input,
    tableIndex = tables.indexOf(table),
    fieldIndex = Object.hasOwn(columns, table) ? columns[table].indexOf(field) : -1
  if (
    tableIndex === -1 ||
    fieldIndex === -1 ||
    !Number.isSafeInteger(rowId) ||
    rowId < 1 ||
    !Number.isSafeInteger(totalBytes) ||
    totalBytes < 1 ||
    totalBytes > 1000000000 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset >= totalBytes ||
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > 65536 ||
    length > totalBytes - offset
  )
    throw new TypeError('Invalid native incremental blob read coordinate')
  const body = new Uint8Array(28),
    view = new DataView(body.buffer)
  body[0] = tableIndex
  body[1] = fieldIndex
  view.setBigUint64(4, BigInt(rowId), true)
  view.setUint32(12, offset, true)
  view.setUint32(16, totalBytes, true)
  view.setUint32(20, length, true)
  return body
}
/** Operation6 body: fixed28-byte metadata followed by one <=64KiB extent.
 * Every coordinate is checked before allocation. No caller-provided SQL, table
 * name, path, unbounded binary or authority object enters this ABI. */
export function encodeBrc38NativeBlobWrite(input: Brc38NativeBlobWrite): Uint8Array {
  const { table, field, rowId, offset, totalBytes } = input
  const tableIndex = tables.indexOf(table),
    fieldIndex = Object.hasOwn(columns, table) ? columns[table].indexOf(field) : -1
  if (
    tableIndex === -1 ||
    fieldIndex === -1 ||
    !Number.isSafeInteger(rowId) ||
    rowId < 1 ||
    !Number.isSafeInteger(totalBytes) ||
    totalBytes < 1 ||
    totalBytes > 1000000000 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset >= totalBytes
  )
    throw new TypeError('Invalid native incremental blob coordinate')
  const bytes = detachBrc38PrivateChunk(input.bytes, 65536)
  if (bytes.byteLength === 0 || bytes.byteLength > totalBytes - offset)
    throw new TypeError('Native incremental blob extent exceeds its declared field')
  const body = new Uint8Array(28 + bytes.byteLength),
    view = new DataView(body.buffer)
  body[0] = tableIndex
  body[1] = fieldIndex
  view.setBigUint64(4, BigInt(rowId), true)
  view.setUint32(12, offset, true)
  view.setUint32(16, totalBytes, true)
  view.setUint32(20, bytes.byteLength, true)
  // Reserved bytes/flags are zero, independently refused by the native parser.
  body.set(bytes, 28)
  return body
}
