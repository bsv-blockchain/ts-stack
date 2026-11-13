import { utf16CodeUnitAt } from '../../utility/utf16CodeUnitAt'
import { SHA256 } from '@bsv/sdk/primitives/Hash'
import type { BRC38Tables } from './index'
import type { Brc38JsonFieldInput, Brc38JsonStreamedRow } from './Brc38JsonBinaryFields'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import { brc38WorkingAllocation, type Brc38WorkingAllocation } from './Brc38WorkingAllocation'

export interface Brc38JsonStructuredFieldPolicy {
  maximumStructuredBytes: number
  maximumChunkBytes?: number
  maximumKeyCodeUnits?: number
  maximumNumberCodeUnits?: number
}
export interface Brc38JsonStructuredField {
  readonly field: string
  readonly encoding: 'utf8-json'
  readonly bytes: number
  readonly sha256: string
}
/** All callbacks own provisional private staging only. The row callback receives
 * both field families, rather than inventing missing-history/binary values.
 * Syntax and a digest are DATA: actual semantic/relational validation and
 * whole-envelope authentication still precede sealing or wallet activation. */
export interface Brc38JsonStructuredFieldSink {
  begin(table: keyof BRC38Tables, index: number, field: string): Promise<void>
  append(table: keyof BRC38Tables, index: number, field: string, offset: number, bytes: Uint8Array): Promise<void>
  finish(table: keyof BRC38Tables, index: number, field: Brc38JsonStructuredField): Promise<void>
  row(table: keyof BRC38Tables, index: number, row: Brc38JsonStreamedRow): Promise<void>
}
const fields: Partial<Record<keyof BRC38Tables, readonly string[]>> = {
  provenTxReqs: ['history', 'notify'],
  syncStates: ['syncMap', 'errorLocal', 'errorOther']
}
export function brc38JsonStructuredField(table: keyof BRC38Tables, field: string): boolean {
  return Object.hasOwn(fields, table) && fields[table]?.includes(field) === true
}
function invalid(): never {
  throw new TypeError('Invalid BRC-38 streamed structured JSON field')
}
function bound(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new RangeError('Invalid structured staging policy')
  return value
}
export function brc38JsonStructuredFieldPolicy(
  selected: Brc38JsonStructuredFieldPolicy
): Readonly<Required<Brc38JsonStructuredFieldPolicy>> {
  return Object.freeze({
    maximumStructuredBytes: bound(selected.maximumStructuredBytes, 1, 1000000000),
    maximumChunkBytes: bound(selected.maximumChunkBytes ?? 65536, 64, 65536),
    maximumKeyCodeUnits: bound(selected.maximumKeyCodeUnits ?? 8192, 1, 8192),
    maximumNumberCodeUnits: bound(selected.maximumNumberCodeUnits ?? 8192, 1, 8192)
  })
}
const white = (unit: string) => unit === ' ' || unit === '\t' || unit === '\n' || unit === '\r'
type Expect = 'key-or-end' | 'key' | 'colon' | 'value-or-end' | 'value' | 'separator'
interface Frame {
  kind: 'object' | 'array'
  expect: Expect
}
/** Bounded grammar recognizer. It retains only 64 structural frames, one
 * <=8192-unit number token and primitive string/escape state. Discarded
 * duplicate values are checked as JSON syntax; final visible portability and
 * historical optional null semantics belong to the independent indexed pass. */
class Grammar {
  readonly stack: Frame[]
  ended = false
  quoted: 'key' | 'value' | undefined
  escape = false
  hex = 0
  keyUnits = 0
  number: string | undefined
  literal: string | undefined
  literalAt = 0
  constructor(
    readonly policy: Readonly<Required<Brc38JsonStructuredFieldPolicy>>,
    root: 'object' | 'array' = 'object'
  ) {
    this.stack = [{ kind: root, expect: root === 'object' ? 'key-or-end' : 'value-or-end' }]
  }
  private parent(): Frame {
    const value = this.stack[this.stack.length - 1]
    if (value === undefined) invalid()
    return value
  }
  private keyUnit(): void {
    if (this.quoted === 'key' && ++this.keyUnits > this.policy.maximumKeyCodeUnits)
      throw new SnapshotResourceLimitError('Structured staging key exceeds its code-unit policy')
  }
  private complete(): void {
    this.parent().expect = 'separator'
  }
  private finishNumber(): void {
    if (this.number === undefined || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(this.number))
      invalid()
    this.number = undefined
    this.complete()
  }
  private close(unit: string): void {
    const parent = this.parent()
    if (unit !== (parent.kind === 'object' ? '}' : ']')) invalid()
    this.stack.pop()
    if (this.stack.length === 0) this.ended = true
  }
  private value(unit: string): void {
    const parent = this.parent()
    parent.expect = 'separator'
    if (unit === '{' || unit === '[') {
      if (this.stack.length >= 64) throw new SnapshotResourceLimitError('Structured staging nesting exceeds 64 levels')
      this.stack.push({ kind: unit === '{' ? 'object' : 'array', expect: unit === '{' ? 'key-or-end' : 'value-or-end' })
    } else if (unit === '"') this.quoted = 'value'
    else if (unit === 't' || unit === 'f' || unit === 'n') {
      this.literal = unit === 't' ? 'true' : unit === 'f' ? 'false' : 'null'
      this.literalAt = 1
    } else if (unit === '-' || /^[0-9]$/.test(unit)) this.number = unit
    else invalid()
  }
  accept(unit: string): void {
    if (this.ended) invalid()
    if (this.quoted !== undefined) {
      if (this.hex !== 0) {
        if (!/^[0-9a-fA-F]$/.test(unit)) invalid()
        if (--this.hex === 0) this.keyUnit()
      } else if (this.escape) {
        this.escape = false
        if (unit === 'u') this.hex = 4
        else if ('"\\/bfnrt'.includes(unit)) this.keyUnit()
        else invalid()
      } else if (unit === '\\') this.escape = true
      else if (unit === '"') {
        this.parent().expect = this.quoted === 'key' ? 'colon' : 'separator'
        this.quoted = undefined
      } else {
        if (utf16CodeUnitAt(unit, 0) < 32) invalid()
        this.keyUnit()
      }
      return
    }
    if (this.literal !== undefined) {
      if (unit !== this.literal[this.literalAt++]) invalid()
      if (this.literalAt === this.literal.length) {
        this.literal = undefined
        this.complete()
      }
      return
    }
    if (this.number !== undefined) {
      if (/^[0-9eE+.-]$/.test(unit)) {
        if (this.number.length >= this.policy.maximumNumberCodeUnits)
          throw new SnapshotResourceLimitError('Structured staging number exceeds its token policy')
        this.number += unit
        return
      }
      this.finishNumber()
    }
    if (white(unit)) return
    const parent = this.parent()
    if (parent.expect === 'key-or-end' || parent.expect === 'key') {
      if (unit === '}' && parent.expect === 'key-or-end') this.close(unit)
      else if (unit === '"') {
        this.quoted = 'key'
        this.keyUnits = 0
      } else invalid()
    } else if (parent.expect === 'colon') {
      if (unit !== ':') invalid()
      parent.expect = 'value'
    } else if (parent.expect === 'value-or-end' || parent.expect === 'value') {
      if (unit === ']' && parent.expect === 'value-or-end') this.close(unit)
      else this.value(unit)
    } else if (unit === ',') parent.expect = parent.kind === 'object' ? 'key' : 'value'
    else this.close(unit)
  }
}

/** Recognize a provisional derived array in fixed UTF8 windows. No complete
 * note, string or array is retained. Syntactic completion is DATA only; the
 * enclosing receiver still independently checks wallet/source semantics. */
export async function* brc38StructuredArrayText(
  chunks: AsyncIterable<Uint8Array>,
  selected: Brc38JsonStructuredFieldPolicy,
  selectedWorking: Brc38WorkingAllocation,
  selectedCheck: () => void,
  signal?: AbortSignal
): AsyncGenerator<string> {
  const policy = brc38JsonStructuredFieldPolicy(selected),
    working = brc38WorkingAllocation(selectedWorking),
    check = selectedCheck,
    grammar = new Grammar(policy, 'array'),
    decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  if (working === undefined || typeof check !== 'function') invalid()
  const charge = working.claim(8192 + 16 * policy.maximumNumberCodeUnits + 16 * policy.maximumChunkBytes)
  let began = false,
    bytes = 0
  const accept = (text: string): void => {
    for (const unit of text) {
      if (!began) {
        if (white(unit)) continue
        if (unit !== '[') invalid()
        began = true
      } else if (grammar.ended) {
        if (!white(unit)) invalid()
      } else grammar.accept(unit)
    }
  }
  try {
    for await (const supplied of chunks) {
      signal?.throwIfAborted()
      check()
      if (
        !(supplied instanceof Uint8Array) ||
        supplied.length < 1 ||
        supplied.length > policy.maximumChunkBytes ||
        supplied.length > policy.maximumStructuredBytes - bytes
      )
        invalid()
      const owned = supplied.slice()
      try {
        bytes += owned.length
        const text = decoder.decode(owned, { stream: true })
        accept(text)
        if (text !== '') yield text
      } finally {
        owned.fill(0)
      }
      signal?.throwIfAborted()
      check()
    }
    const tail = decoder.decode()
    accept(tail)
    if (!began || !grammar.ended) invalid()
    signal?.throwIfAborted()
    check()
    if (tail !== '') yield tail
  } finally {
    charge.close()
  }
}

/** Capture one complete original object as detached UTF8 extents, preserving
 * escapes/order/duplicates without JSON.parse, a whole string, object or key
 * array. The actual host later independently validates the final visible
 * values through its authenticated staged index before accepting the import. */
export async function readBrc38JsonStructuredField(
  input: Brc38JsonFieldInput,
  table: keyof BRC38Tables,
  index: number,
  field: string,
  sink: Brc38JsonStructuredFieldSink,
  policy: Readonly<Required<Brc38JsonStructuredFieldPolicy>>
): Promise<Brc38JsonStructuredField> {
  if (!brc38JsonStructuredField(table, field)) invalid()
  input.check()
  await input.skip()
  if ((await input.peek()) !== '{') invalid()
  const grammar = new Grammar(policy),
    hash = new SHA256(),
    buffer = new Uint8Array(policy.maximumChunkBytes)
  let used = 0,
    bytes = 0,
    high: number | undefined
  const byte = (value: number) => {
    if (bytes >= policy.maximumStructuredBytes)
      throw new SnapshotResourceLimitError('Structured staging byte policy reached')
    if (used >= buffer.length) invalid()
    buffer[used++] = value
    bytes++
  }
  const utf8 = (unit: string) => {
    let point = utf16CodeUnitAt(unit, 0)
    if (high !== undefined) {
      if (point < 0xdc00 || point > 0xdfff) invalid()
      point = 0x10000 + (high - 0xd800) * 1024 + point - 0xdc00
      high = undefined
    } else if (point >= 0xd800 && point <= 0xdbff) {
      high = point
      return
    } else if (point >= 0xdc00 && point <= 0xdfff) invalid()
    if (point < 0x80) byte(point)
    else if (point < 0x800) {
      byte(0xc0 | (point >> 6))
      byte(0x80 | (point & 63))
    } else if (point < 0x10000) {
      byte(0xe0 | (point >> 12))
      byte(0x80 | ((point >> 6) & 63))
      byte(0x80 | (point & 63))
    } else {
      byte(0xf0 | (point >> 18))
      byte(0x80 | ((point >> 12) & 63))
      byte(0x80 | ((point >> 6) & 63))
      byte(0x80 | (point & 63))
    }
  }
  const flush = async () => {
    if (used === 0) return
    const detached = buffer.slice(0, used),
      offset = bytes - used
    hash.update(detached)
    input.check()
    await sink.append(table, index, field, offset, detached)
    input.check()
    used = 0
  }
  await sink.begin(table, index, field)
  input.check()
  await input.expect('{')
  byte(0x7b)
  while (!grammar.ended) {
    input.check()
    if ((await input.peek()) === undefined) invalid()
    await input.scan(unit => {
      grammar.accept(unit)
      utf8(unit)
      return !grammar.ended && used <= buffer.length - 4
    })
    await flush()
  }
  if (
    high !== undefined ||
    grammar.stack.length !== 0 ||
    grammar.quoted !== undefined ||
    grammar.escape ||
    grammar.hex !== 0 ||
    grammar.number !== undefined ||
    grammar.literal !== undefined
  )
    invalid()
  await flush()
  const result = Object.freeze({ field, encoding: 'utf8-json' as const, bytes, sha256: hash.digestHex() })
  input.check()
  await sink.finish(table, index, result)
  input.check()
  return result
}
