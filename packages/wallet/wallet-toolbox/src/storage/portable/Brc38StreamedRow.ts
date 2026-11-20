import { SHA256 } from '@bsv/sdk/primitives/Hash'
import { toBase64, toHex } from '@bsv/sdk/primitives/utils'
import type { BRC38Tables } from './index'
import { projectBrc38PackedRow } from './Brc38PackedRow'
import { canonicalPortableChunks } from './CanonicalPortableChunks'
import { detachBrc38PrivateChunk } from './Brc38PrivateChunkPipe'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import { canonicalBrc38StructuredJson, type Brc38StreamedStructured } from './Brc38StructuredJson'
import { brc38StreamedTextFields, encodeBrc38StreamedText, type Brc38StreamedText } from './Brc38StreamedText'

/** A content descriptor is data, never authority. Its host must keep the actual
 * coherent source, profile and physical read lifetime owned through every read.
 * Each read must return exactly the requested extent; no read-ahead is assumed. */
export interface Brc38StreamedBinary {
  length: number
  sha256: string
  read: (offset: number, length: number) => Promise<Uint8Array>
}
export interface Brc38StreamedRow {
  /** Native metadata and small fields. Large binary cells must be absent here. */
  fields: Readonly<Record<string, unknown>>
  binaries: Readonly<Record<string, Brc38StreamedBinary>>
  /** Additive large structured-text path; original object/array wire semantics. */
  structured?: Readonly<Record<string, Brc38StreamedStructured>>
  /** Original large string values, with ordinary JSON string wire spelling. */
  texts?: Readonly<Record<string, Brc38StreamedText>>
}
export interface Brc38StreamedRowPolicy {
  maximumMetadataAllocationBytes: number
  maximumBinaryBytes: number
  maximumStructuredBytes?: number
  maximumTextBytes?: number
  maximumRowBytes: number
  maximumChunkBytes?: number
  signal?: AbortSignal
}
const binaryFields: Partial<Record<keyof BRC38Tables, readonly string[]>> = {
  commissions: ['lockingScript'],
  outputs: ['lockingScript'],
  provenTxs: ['merklePath', 'rawTx'],
  provenTxReqs: ['rawTx', 'inputBEEF'],
  transactions: ['rawTx', 'inputBEEF', 'noSendExpiryReclaimRawTx']
}
const tables = new Set([
  'provenTxs',
  'provenTxReqs',
  'outputBaskets',
  'transactions',
  'commissions',
  'outputs',
  'outputTags',
  'outputTagMaps',
  'txLabels',
  'txLabelMaps',
  'certificates',
  'certificateFields',
  'syncStates'
])
const structuredFields: Partial<Record<keyof BRC38Tables, readonly string[]>> = {
  provenTxReqs: ['history', 'notify'],
  syncStates: ['syncMap', 'errorLocal', 'errorOther']
}
function invalid(): never {
  throw new TypeError('Invalid BRC-38 streamed row or binary extent')
}
function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid()
  return value
}
function own(value: unknown, maximumFields: number): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== null && prototype !== Object.prototype) invalid()
  const result: Record<string, unknown> = Object.create(null)
  let count = 0
  for (const field in value) {
    if (!Object.hasOwn(value, field)) continue
    if (++count > maximumFields || field.length > 128) invalid()
    const property = Object.getOwnPropertyDescriptor(value, field)
    if (property === undefined || !Object.hasOwn(property, 'value') || !property.enumerable) invalid()
    result[field] = property.value
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) invalid()
  return result
}

/** Canonical version-one row bytes without materializing a complete base64
 * string or expanding a complete binary field to number[]. The historical
 * no-send reclaim cell keeps its original JSON number-array spelling. At most one source
 * extent is in flight. The full digest/length is verified before closing its
 * JSON string; all output remains provisional until the complete archive source
 * validates and closes. These checks do not establish source authorization. */
export async function* encodeBrc38StreamedRow(
  table: keyof BRC38Tables,
  input: Brc38StreamedRow,
  selected: Brc38StreamedRowPolicy
): AsyncGenerator<Uint8Array, void, void> {
  const policy = { ...selected }
  if (!tables.has(table)) invalid()
  const width = integer(policy.maximumChunkBytes ?? 65536, 64, 65536)
  integer(policy.maximumMetadataAllocationBytes, 1, 16777216)
  integer(policy.maximumBinaryBytes, 0, Number.MAX_SAFE_INTEGER)
  integer(policy.maximumRowBytes, 1, Number.MAX_SAFE_INTEGER)
  policy.signal?.throwIfAborted()
  const row = own(input, 4)
  if (!Object.hasOwn(row, 'fields') || !Object.hasOwn(row, 'binaries')) invalid()
  if (Object.keys(row).some(name => !['fields', 'binaries', 'structured', 'texts'].includes(name))) invalid()
  const metadata = projectBrc38PackedRow(table, row.fields, {
    maximumAllocationBytes: policy.maximumMetadataAllocationBytes,
    signal: policy.signal
  })
  const references = own(row.binaries, 3)
  const sources: Record<string, Brc38StreamedBinary> = Object.create(null)
  for (const [field, reference] of Object.entries(references)) {
    if (!Object.hasOwn(binaryFields, table) || !binaryFields[table]?.includes(field) || Object.hasOwn(metadata, field))
      invalid()
    const properties = own(reference, 3)
    if (
      !Object.hasOwn(properties, 'length') ||
      !Object.hasOwn(properties, 'sha256') ||
      !Object.hasOwn(properties, 'read')
    )
      invalid()
    const length = integer(properties.length, 0, policy.maximumBinaryBytes)
    const sha256 = properties.sha256,
      read = properties.read
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256) || typeof read !== 'function') invalid()
    // The callback remains host-owned. Never retain the caller's mutable length,
    // digest or method-property object across the first asynchronous boundary.
    sources[field] = { length, sha256, read: read as Brc38StreamedBinary['read'] }
  }
  const structured: Record<string, Brc38StreamedStructured> = Object.create(null)
  const maximumStructured = integer(
    policy.maximumStructuredBytes ?? policy.maximumBinaryBytes,
    0,
    Number.MAX_SAFE_INTEGER
  )
  for (const [field, reference] of Object.entries(row.structured === undefined ? {} : own(row.structured, 3))) {
    if (!structuredFields[table]?.includes(field) || Object.hasOwn(metadata, field) || Object.hasOwn(sources, field))
      invalid()
    const properties = own(reference, 5)
    if (Object.keys(properties).some(name => !['encoding', 'length', 'sha256', 'read', 'openIndex'].includes(name)))
      invalid()
    const length = integer(properties.length, 1, maximumStructured),
      encoding = properties.encoding,
      sha256 = properties.sha256,
      read = properties.read,
      openIndex = properties.openIndex
    if (
      (encoding !== 'utf16le' && encoding !== 'utf8') ||
      (encoding === 'utf16le' && length % 2 !== 0) ||
      typeof sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(sha256) ||
      typeof read !== 'function' ||
      typeof openIndex !== 'function'
    )
      invalid()
    structured[field] = {
      encoding,
      length,
      sha256,
      read: read as Brc38StreamedStructured['read'],
      openIndex: openIndex as Brc38StreamedStructured['openIndex']
    }
  }
  const texts: Record<string, Brc38StreamedText> = Object.create(null),
    maximumText = integer(policy.maximumTextBytes ?? policy.maximumBinaryBytes, 0, Number.MAX_SAFE_INTEGER)
  for (const [field, reference] of Object.entries(row.texts === undefined ? {} : own(row.texts, 7))) {
    const allowed = Object.hasOwn(brc38StreamedTextFields, table)
      ? brc38StreamedTextFields[table as keyof typeof brc38StreamedTextFields]
      : undefined
    if (
      !allowed?.includes(field) ||
      Object.hasOwn(metadata, field) ||
      Object.hasOwn(sources, field) ||
      Object.hasOwn(structured, field)
    )
      invalid()
    const properties = own(reference, 4),
      encoding = properties.encoding,
      length = integer(properties.length, 0, maximumText),
      sha256 = properties.sha256,
      read = properties.read
    if (
      Object.keys(properties).some(name => !['encoding', 'length', 'sha256', 'read'].includes(name)) ||
      (encoding !== 'utf8' && encoding !== 'utf16le') ||
      (encoding === 'utf16le' && length % 2 !== 0) ||
      typeof sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(sha256) ||
      typeof read !== 'function'
    )
      invalid()
    texts[field] = { encoding, length, sha256, read: read as Brc38StreamedText['read'] }
  }
  const fields = [
    ...Object.keys(metadata),
    ...Object.keys(sources),
    ...Object.keys(structured),
    ...Object.keys(texts)
  ].sort((a, b) => Number(a > b) - Number(a < b))
  if (fields.length > 64 || new Set(fields).size !== fields.length) invalid()
  const encoder = new TextEncoder()
  const small = {
    maximumValueBytes: policy.maximumMetadataAllocationBytes,
    maximumChunkBytes: width,
    signal: policy.signal
  }
  let emitted = 0
  const output = (bytes: Uint8Array): Uint8Array => {
    policy.signal?.throwIfAborted()
    if (bytes.byteLength > width || bytes.byteLength > policy.maximumRowBytes - emitted)
      throw new SnapshotResourceLimitError('BRC-38 streamed row exceeds its encoded byte policy')
    emitted += bytes.byteLength
    return bytes
  }
  yield output(encoder.encode('{'))
  for (const [index, field] of fields.entries()) {
    if (index !== 0) yield output(encoder.encode(','))
    for (const chunk of canonicalPortableChunks(field, small)) yield output(chunk)
    yield output(encoder.encode(':'))
    const text = texts[field]
    if (text !== undefined) {
      for await (const chunk of encodeBrc38StreamedText(text, {
        maximumInputBytes: maximumText,
        maximumOutputBytes: policy.maximumRowBytes - emitted,
        maximumChunkBytes: width,
        signal: policy.signal
      }))
        yield output(chunk)
      continue
    }
    const history = structured[field]
    if (history !== undefined) {
      for await (const chunk of canonicalBrc38StructuredJson(field, history, {
        maximumInputBytes: maximumStructured,
        maximumOutputBytes: policy.maximumRowBytes - emitted,
        maximumChunkBytes: width,
        signal: policy.signal
      }))
        yield output(chunk)
      continue
    }
    const source = sources[field]
    if (source === undefined) {
      for (const chunk of canonicalPortableChunks(metadata[field], small)) yield output(chunk)
      continue
    }
    // The historical no-send reclaim field is a JSON number array, not one
    // of the standard base64 cells. Preserve its original wire representation.
    const numberArray = table === 'transactions' && field === 'noSendExpiryReclaimRawTx'
    const encodedLength = numberArray
      ? source.length === 0
        ? 0
        : 2 * source.length - 1
      : 4 * Math.ceil(source.length / 3)
    if (!Number.isSafeInteger(encodedLength) || encodedLength + 2 > policy.maximumRowBytes - emitted)
      throw new SnapshotResourceLimitError('BRC-38 binary exceeds its encoded row byte policy')
    yield output(encoder.encode(numberArray ? '[' : '"'))
    const hash = new SHA256()
    // Every non-final extent is a multiple of three, preserving exact base64
    // spelling without carrying padding into the middle of a JSON string.
    const extent = numberArray ? Math.floor(width / 4) : Math.floor(width / 4) * 3
    let offset = 0,
      work = 0
    while (offset < source.length) {
      policy.signal?.throwIfAborted()
      const requested = Math.min(extent, source.length - offset)
      const bytes = detachBrc38PrivateChunk(await source.read(offset, requested), requested)
      policy.signal?.throwIfAborted()
      if (bytes.byteLength !== requested) invalid()
      const numbers = Array.from(bytes) // One bounded extent, never the full field.
      hash.update(numbers)
      yield output(encoder.encode(numberArray ? `${offset === 0 ? '' : ','}${numbers.join(',')}` : toBase64(numbers)))
      offset += requested
      work += requested
      if (work >= 65536) {
        work = 0
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
    }
    if (toHex(hash.digest()) !== source.sha256) throw new TypeError('BRC-38 streamed binary content digest differs')
    yield output(encoder.encode(numberArray ? ']' : '"'))
  }
  yield output(encoder.encode('}'))
}
