import { SHA256 } from '@bsv/sdk/primitives/Hash'
import { toHex } from '@bsv/sdk/primitives/utils'
import type { BRC38Tables } from './index'
import type { PortableRow } from './Brc38PortableRows'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import type { Brc38JsonTextField } from './Brc38JsonTextFields'
import type { Brc38JsonStructuredField } from './Brc38JsonStructuredFields'

export interface Brc38JsonStreamedFieldPolicy {
  /** Decoded bytes of one binary field, independent of row metadata. */
  maximumBinaryBytes: number
  maximumChunkBytes?: number
}
export interface Brc38JsonStreamedField {
  readonly field: string
  readonly encoding: 'base64' | 'number-array'
  readonly bytes: number
  readonly sha256: string
}
export interface Brc38JsonStreamedRow {
  readonly fields: Readonly<PortableRow>
  readonly binaries: Readonly<Record<string, Brc38JsonStreamedField>>
  readonly structured?: Readonly<Record<string, Brc38JsonStructuredField>>
  readonly texts?: Readonly<Record<string, Brc38JsonTextField>>
}
/** Every callback writes ONLY private staging. All chunks and descriptors remain
 * provisional until whole-envelope authentication, complete independent row and
 * relationship validation and actual physical source/staging cleanup succeed.
 * A digest identifies content DATA; it cannot authorize a profile or an import. */
export interface Brc38JsonStreamedFieldSink {
  begin: (
    table: keyof BRC38Tables,
    index: number,
    field: string,
    encoding: Brc38JsonStreamedField['encoding']
  ) => Promise<void>
  append: (table: keyof BRC38Tables, index: number, field: string, offset: number, bytes: Uint8Array) => Promise<void>
  finish: (table: keyof BRC38Tables, index: number, field: Brc38JsonStreamedField) => Promise<void>
  row: (table: keyof BRC38Tables, index: number, row: Brc38JsonStreamedRow) => Promise<void>
}
export interface Brc38JsonFieldInput {
  check: () => void
  skip: () => Promise<void>
  peek: () => Promise<string | undefined>
  expect: (unit: string) => Promise<void>
  /** Synchronous bounded scanner: consumes the last accepted character and then
   * pauses when accept returns false. Its host yields/refills outside the scan. */
  scan: (accept: (unit: string) => boolean) => Promise<void>
}
const fields: Partial<Record<keyof BRC38Tables, readonly string[]>> = {
  provenTxs: ['merklePath', 'rawTx'],
  provenTxReqs: ['rawTx', 'inputBEEF'],
  transactions: ['rawTx', 'inputBEEF', 'noSendExpiryReclaimRawTx'],
  commissions: ['lockingScript'],
  outputs: ['lockingScript']
}
export function brc38JsonBinaryField(table: keyof BRC38Tables, field: string): boolean {
  return Object.hasOwn(fields, table) && fields[table]?.includes(field) === true
}
export function brc38JsonStreamedFieldPolicy(
  input: Brc38JsonStreamedFieldPolicy
): Readonly<Required<Brc38JsonStreamedFieldPolicy>> {
  const maximumBinaryBytes = input.maximumBinaryBytes,
    maximumChunkBytes = input.maximumChunkBytes ?? 65536
  if (
    !Number.isSafeInteger(maximumBinaryBytes) ||
    maximumBinaryBytes < 0 ||
    !Number.isSafeInteger(maximumChunkBytes) ||
    maximumChunkBytes < 64 ||
    maximumChunkBytes > 65536
  )
    throw new RangeError('Invalid BRC-38 binary staging bounds')
  return Object.freeze({ maximumBinaryBytes, maximumChunkBytes })
}
function invalid(): never {
  throw new TypeError('Invalid BRC-38 streamed binary JSON field')
}
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** One decoded field, at most one awaited staging write and one owned <=64KiB
 * buffer. No complete base64 string or number[] reaches JavaScript memory. */
export async function readBrc38JsonBinaryField(
  input: Brc38JsonFieldInput,
  table: keyof BRC38Tables,
  index: number,
  field: string,
  sink: Brc38JsonStreamedFieldSink,
  policy: Readonly<Required<Brc38JsonStreamedFieldPolicy>>
): Promise<Brc38JsonStreamedField> {
  if (!brc38JsonBinaryField(table, field)) invalid()
  const encoding = field === 'noSendExpiryReclaimRawTx' ? 'number-array' : 'base64'
  const digest = new SHA256(),
    buffer = new Uint8Array(policy.maximumChunkBytes)
  let used = 0,
    bytes = 0
  const byte = (value: number) => {
    if (bytes >= policy.maximumBinaryBytes)
      throw new SnapshotResourceLimitError('BRC-38 binary staging byte policy reached')
    buffer[used++] = value
    bytes++
  }
  const flush = async () => {
    if (used === 0) return
    const detached = buffer.slice(0, used),
      offset = bytes - used
    // The host may retain its chunk; neither the working buffer nor the digest
    // reads caller-mutated bytes after append. Hash before the callback.
    digest.update(detached)
    input.check()
    await sink.append(table, index, field, offset, detached)
    input.check()
    used = 0
  }
  await input.expect(encoding === 'base64' ? '"' : '[')
  input.check()
  await sink.begin(table, index, field, encoding)
  input.check()
  if (encoding === 'base64') {
    let quartet = '',
      escaped = false,
      unicodeDigits: string | undefined,
      terminal = false,
      ended = false
    const decoded = (unit: string) => {
      if (terminal || (unit !== '=' && alphabet.indexOf(unit) === -1)) invalid()
      quartet += unit
      if (quartet.length !== 4) return
      if (!/^[A-Za-z0-9+/]{2}(?:[A-Za-z0-9+/]{2}|[A-Za-z0-9+/]=|==)$/.test(quartet)) invalid()
      const a = alphabet.indexOf(quartet[0]),
        b = alphabet.indexOf(quartet[1]),
        c = alphabet.indexOf(quartet[2]),
        d = alphabet.indexOf(quartet[3])
      byte((a << 2) | (b >> 4))
      if (quartet[2] !== '=') byte(((b & 15) << 4) | (c >> 2))
      if (quartet[3] !== '=') byte(((c & 3) << 6) | d)
      // Legacy padded base64 accepts nonzero unused padding bits; preserve that
      // input compatibility. Fresh export still emits canonical padded base64.
      terminal = quartet[3] === '='
      quartet = ''
    }
    while (!ended) {
      await input.scan(unit => {
        if (unicodeDigits !== undefined) {
          if (!/^[0-9a-fA-F]$/.test(unit)) invalid()
          unicodeDigits += unit
          if (unicodeDigits.length === 4) {
            decoded(String.fromCharCode(Number.parseInt(unicodeDigits, 16)))
            unicodeDigits = undefined
          }
        } else if (escaped) {
          escaped = false
          if (unit === 'u') unicodeDigits = ''
          else if (unit === '/') decoded('/')
          else invalid()
        } else if (unit === '\\') escaped = true
        else if (unit === '"') {
          if (quartet !== '') invalid()
          ended = true
          return false
        } else decoded(unit)
        return used <= policy.maximumChunkBytes - 3
      })
      await flush()
    }
  } else {
    let token = '',
      state: 'first' | 'value' | 'separator' | 'next' = 'first',
      ended = false
    const complete = () => {
      if (token.length === 0) invalid()
      const value: unknown = JSON.parse(token)
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255) invalid()
      byte(value)
      token = ''
      state = 'separator'
    }
    while (!ended) {
      await input.scan(unit => {
        const white = unit === ' ' || unit === '\t' || unit === '\n' || unit === '\r'
        if (state === 'value') {
          if (white || unit === ',' || unit === ']') complete()
          else {
            if (token.length >= 64) invalid()
            token += unit
            return true
          }
        }
        if (white) return used < policy.maximumChunkBytes
        if (state === 'separator') {
          if (unit === ',') state = 'next'
          else if (unit === ']') ended = true
          else invalid()
        } else if (unit === ']' && state === 'first') ended = true
        else {
          if (unit === ']' || unit === ',') invalid()
          token = unit
          state = 'value'
        }
        return !ended && used < policy.maximumChunkBytes
      })
      await flush()
    }
  }
  const result = Object.freeze({ field, encoding, bytes, sha256: toHex(digest.digest()) })
  input.check()
  await sink.finish(table, index, result)
  input.check()
  return result
}
