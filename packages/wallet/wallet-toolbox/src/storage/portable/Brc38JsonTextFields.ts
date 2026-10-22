import { utf16CodeUnitAt } from '../../utility/utf16CodeUnitAt'
import { SHA256 } from '@bsv/sdk/primitives/Hash'
import { toHex } from '@bsv/sdk/primitives/utils'
import type { BRC38Tables } from './index'
import type { Brc38JsonFieldInput, Brc38JsonStreamedRow } from './Brc38JsonBinaryFields'
import { brc38StreamedTextFields } from './Brc38StreamedText'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

export interface Brc38JsonTextFieldPolicy {
  /** Decoded UTF-8 bytes, independently bounded from row metadata and JSON spelling. */
  maximumTextBytes: number
  maximumChunkBytes?: number
}
export interface Brc38JsonTextField {
  readonly field: string
  readonly encoding: 'utf8'
  readonly bytes: number
  readonly sha256: string
}
/** Provisional private writes only. Append borrows its extent until settlement;
 * durable staging must copy it before returning. Authentication, original row
 * semantics, source closure and receiver admission remain separate checks. */
export interface Brc38JsonTextFieldSink {
  begin: (table: keyof BRC38Tables, index: number, field: string, encoding: 'utf8') => Promise<void>
  append: (table: keyof BRC38Tables, index: number, field: string, offset: number, bytes: Uint8Array) => Promise<void>
  finish: (table: keyof BRC38Tables, index: number, field: Brc38JsonTextField) => Promise<void>
  row: (table: keyof BRC38Tables, index: number, row: Brc38JsonStreamedRow) => Promise<void>
}
export function brc38JsonTextField(table: keyof BRC38Tables, field: string): boolean {
  const fields: Readonly<Partial<Record<keyof BRC38Tables, readonly string[]>>> = brc38StreamedTextFields
  return Object.hasOwn(fields, table) && fields[table]?.includes(field) === true
}
export function brc38JsonTextFieldPolicy(
  input: Brc38JsonTextFieldPolicy
): Readonly<Required<Brc38JsonTextFieldPolicy>> {
  const maximumTextBytes = input.maximumTextBytes,
    maximumChunkBytes = input.maximumChunkBytes ?? 16384
  if (
    !Number.isSafeInteger(maximumTextBytes) ||
    maximumTextBytes < 0 ||
    maximumTextBytes > 1000000000 ||
    !Number.isSafeInteger(maximumChunkBytes) ||
    maximumChunkBytes < 64 ||
    maximumChunkBytes > 16384
  )
    throw new RangeError('Invalid BRC-38 scalar TEXT staging bounds')
  return Object.freeze({ maximumTextBytes, maximumChunkBytes })
}
function invalid(): never {
  throw new TypeError('Invalid BRC-38 streamed scalar TEXT JSON field')
}

/** Decode the original JSON string into bounded UTF-8 extents. Surrogate pairs
 * may span input chunks, raw/escaped spelling and staging windows; unpaired
 * surrogates and raw controls are refused as in the original portable parser.
 * Neither a complete encoded string nor a complete decoded value is retained. */
export async function readBrc38JsonTextField(
  input: Brc38JsonFieldInput,
  table: keyof BRC38Tables,
  index: number,
  field: string,
  sink: Brc38JsonTextFieldSink,
  policy: Readonly<Required<Brc38JsonTextFieldPolicy>>
): Promise<Brc38JsonTextField> {
  if (!brc38JsonTextField(table, field)) invalid()
  const digest = new SHA256(),
    buffer = new Uint8Array(policy.maximumChunkBytes)
  let used = 0,
    bytes = 0,
    high: number | undefined,
    escaped = false,
    digits: string | undefined,
    ended = false
  const point = (value: number): void => {
    const size = value < 0x80 ? 1 : value < 0x800 ? 2 : value < 0x10000 ? 3 : 4
    if (size > policy.maximumTextBytes - bytes)
      throw new SnapshotResourceLimitError('BRC-38 decoded scalar TEXT staging byte policy reached')
    if (used > buffer.length - size) invalid()
    if (size === 1) buffer[used++] = value
    else if (size === 2) {
      buffer[used++] = 0xc0 | (value >> 6)
      buffer[used++] = 0x80 | (value & 63)
    } else if (size === 3) {
      buffer[used++] = 0xe0 | (value >> 12)
      buffer[used++] = 0x80 | ((value >> 6) & 63)
      buffer[used++] = 0x80 | (value & 63)
    } else {
      buffer[used++] = 0xf0 | (value >> 18)
      buffer[used++] = 0x80 | ((value >> 12) & 63)
      buffer[used++] = 0x80 | ((value >> 6) & 63)
      buffer[used++] = 0x80 | (value & 63)
    }
    bytes += size
  }
  const unit = (value: number): void => {
    if (high !== undefined) {
      if (value < 0xdc00 || value > 0xdfff) invalid()
      point(0x10000 + ((high - 0xd800) << 10) + value - 0xdc00)
      high = undefined
    } else if (value >= 0xd800 && value <= 0xdbff) high = value
    else if (value >= 0xdc00 && value <= 0xdfff) invalid()
    else point(value)
  }
  const flush = async (): Promise<void> => {
    if (used === 0) return
    const loan = buffer.slice(0, used),
      offset = bytes - used
    try {
      digest.update(loan)
      input.check()
      await sink.append(table, index, field, offset, loan)
      input.check()
      used = 0
    } finally {
      loan.fill(0)
    }
  }
  try {
    await input.expect('"')
    input.check()
    await sink.begin(table, index, field, 'utf8')
    input.check()
    while (!ended) {
      await input.scan(value => {
        if (digits !== undefined) {
          if (!/^[0-9a-fA-F]$/.test(value)) invalid()
          digits += value
          if (digits.length === 4) {
            unit(Number.parseInt(digits, 16))
            digits = undefined
          }
        } else if (escaped) {
          escaped = false
          if (value === 'u') digits = ''
          else {
            const decoded =
              value === '"'
                ? 34
                : value === '\\'
                  ? 92
                  : value === '/'
                    ? 47
                    : value === 'b'
                      ? 8
                      : value === 'f'
                        ? 12
                        : value === 'n'
                          ? 10
                          : value === 'r'
                            ? 13
                            : value === 't'
                              ? 9
                              : undefined
            if (decoded === undefined) invalid()
            unit(decoded)
          }
        } else if (value === '\\') escaped = true
        else if (value === '"') {
          if (high !== undefined) invalid()
          ended = true
          return false
        } else {
          const code = utf16CodeUnitAt(value, 0)
          if (code < 32) invalid()
          unit(code)
        }
        return used <= buffer.length - 4
      })
      await flush()
    }
    // A quote from the next key can close a malformed scalar. Require its
    // own row delimiter before finishing even this provisional private field.
    await input.skip()
    const delimiter = await input.peek()
    if (delimiter !== ',' && delimiter !== '}') invalid()
    const result = Object.freeze({ field, encoding: 'utf8' as const, bytes, sha256: toHex(digest.digest()) })
    input.check()
    await sink.finish(table, index, result)
    input.check()
    return result
  } finally {
    buffer.fill(0)
  }
}
