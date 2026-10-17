import { brc38WorkingAllocation, type Brc38WorkingAllocation, type Brc38WorkingCharge } from './Brc38WorkingAllocation'
import { SHA256 } from '@bsv/sdk/primitives/Hash'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import { Brc38CleanupScope, Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { isOptionalBrc38StructuredField } from './Brc38PackedRow'
import { canonicalPortableChunks } from './CanonicalPortableChunks'
import { assertIsoDate, requireNumber } from './Brc38PortableRows'
import { brc38StructuredArrayText } from './Brc38JsonStructuredFields'

export interface Brc38JsonMember {
  key: string
  keyOffset: number
  start: number
  end: number
}
/** Host-owned temporary index, not a source-admission token. Keys use raw
 * UTF-16 ordering, duplicate keys replace the earlier value as JSON.parse does.
 * Each call must check the actual owner, original expiry, quota and layout;
 * seal/close must drain the host's actual operations. No callback holds a writer. */
export interface Brc38JsonMemberIndex {
  put(objectOffset: number, member: Brc38JsonMember): Promise<void>
  seal(): Promise<void>
  entries(objectOffset: number): AsyncIterable<Brc38JsonMember>
  /** Optional bounded keyset read with no retained host iterator. Nested
   * objects can suspend their grammar frame without retaining a parent cursor. */
  nextEntry?(objectOffset: number, afterKey?: string): Promise<Brc38JsonMember | undefined>
  /** Optional bounded original insertion/last-value lookup for operational
   * map normalization. Returned spans are DATA and do not admit a source. */
  lookup?(
    objectOffset: number,
    key: string
  ): Promise<Readonly<Brc38JsonMember & { firstKeyOffset: number }> | undefined>
  close(): Promise<void>
}
export interface Brc38StreamedStructured {
  encoding: 'utf16le' | 'utf8'
  length: number
  sha256: string
  read(offset: number, length: number): Promise<Uint8Array>
  openIndex(): Promise<Brc38JsonMemberIndex>
}
export interface Brc38StructuredJsonPolicy {
  maximumInputBytes: number
  maximumOutputBytes: number
  maximumChunkBytes?: number
  maximumKeyCodeUnits?: number
  maximumNumberCodeUnits?: number
  /** Optional original grammar working allocation shared by retained readers,
   * decoded keys/tokens, frames and explicit hash/output buffers. External
   * indexes, native SQLite and VM physical memory require separate admission. */
  maximumAllocationBytes?: number
  /** Optional shared original allowance; resource accounting only. */
  workingAllocation?: Brc38WorkingAllocation
  signal?: AbortSignal
}
export interface Brc38StructuredStringComparePolicy {
  readonly maximumInputBytes: number
  readonly maximumDecodedCodeUnits: number
  readonly maximumReadBytes: number
  readonly maximumAllocationBytes?: number
  readonly workingAllocation: Brc38WorkingAllocation
  readonly expiresAt: number
  readonly signal?: AbortSignal
  /** Concrete original owners, checked around this operation. Descriptors,
   * hashes and returned lexical order do not authenticate a source. */
  readonly check: () => void
}
export type Brc38StructuredPath = readonly (string | number)[]
/** Visible values only, after duplicate-key selection and original wallet
 * checks. Text is delivered in bounded pieces; no callback receives a whole
 * history/map. Effects remain provisional until visitation reaches EOF and
 * both source digest passes and the actual index close complete. */
export interface Brc38StructuredVisitor {
  enter?(
    path: Brc38StructuredPath,
    kind: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null',
    sourceOffset: number
  ): void | Promise<void>
  /** Original last-value span, plus original first insertion position when
   * available. This is DATA for legacy enumeration, never source authority. */
  member?(
    path: Brc38StructuredPath,
    value: Readonly<Brc38JsonMember & { firstKeyOffset: number }>
  ): void | Promise<void>
  text?(path: Brc38StructuredPath, value: string): void | Promise<void>
  number?(path: Brc38StructuredPath, value: number): void | Promise<void>
  boolean?(path: Brc38StructuredPath, value: boolean): void | Promise<void>
  null?(path: Brc38StructuredPath): void | Promise<void>
  end?(path: Brc38StructuredPath, sourceEnd: number): void | Promise<void>
}
export interface Brc38StructuredNotifyIds {
  chunks(maximumChunkBytes?: number): AsyncIterable<Uint8Array>
  close(): Promise<void>
}
/** Finite internal edits, applied outside a destination writer. Each original
 * replaced member is still parsed and visited before replacement. Values are
 * primitives, so no edit supplies an unbounded producer or a source verdict. */
export interface Brc38StructuredMemberEdit {
  readonly path: readonly string[]
  readonly key: string
  readonly existingOnly?: boolean
  readonly value: () => string | number | boolean | null
}
/** Only canonical strictly increasing safe integer arrays are accepted from
 * derived sort output. These bytes remain provisional; a copied producer can
 * supply DATA but cannot supply source/import/map authority. */
async function* notifyIds(selected: Brc38StructuredNotifyIds, policy: Policy): AsyncGenerator<string> {
  const source = { chunks: selected.chunks.bind(selected), close: selected.close.bind(selected) }
  const lifetimeCharge = policy.working.claim(1024)
  let state: 'start' | 'first' | 'value' | 'number' | 'done' = 'start',
    token = '',
    last: number | undefined
  let failed = false,
    original: unknown
  const finish = (): void => {
    const value = Number(token)
    if (!Number.isSafeInteger(value) || String(value) !== token || (last !== undefined && value <= last)) invalid()
    last = value
    token = ''
  }
  const cleanupScope1 = new Brc38CleanupScope(async () => {
    lifetimeCharge.close()
    try {
      await source.close()
    } catch (error_) {
      if (failed)
        throw new AggregateError([original, error_], 'Notification projection and cleanup failed', { cause: original })
      throw error_
    }
  })
  try {
    for await (const supplied of source.chunks(policy.width)) {
      policy.signal?.throwIfAborted()
      if (!(supplied instanceof Uint8Array) || supplied.byteLength < 1 || supplied.byteLength > policy.width) invalid()
      const scratch = policy.working.claim(512 + 4 * supplied.byteLength)
      let bytes: Uint8Array | undefined
      try {
        bytes = supplied.slice()
        for (const unit of bytes) {
          if (state === 'start') {
            if (unit !== 91) invalid()
            state = 'first'
          } else if (state === 'first' || state === 'value') {
            if (state === 'first' && unit === 93) state = 'done'
            else if (unit === 45 || (unit >= 48 && unit <= 57)) {
              token = String.fromCharCode(unit)
              state = 'number'
            } else invalid()
          } else if (state === 'number') {
            if (unit >= 48 && unit <= 57) {
              if (token.length >= 17) invalid()
              token += String.fromCharCode(unit)
            } else if (unit === 44 || unit === 93) {
              finish()
              state = unit === 44 ? 'value' : 'done'
            } else invalid()
          } else invalid()
        }
        yield new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } finally {
        bytes?.fill(0)
        scratch.close()
      }
    }
    if (state !== 'done') invalid()
  } catch (cause) {
    failed = true
    original = cause
    {
      await cleanupScope1.close()
      throw cause
    }
  } finally {
    await cleanupScope1.close()
  }
}
function invalid(): never {
  throw new TypeError('Invalid BRC-38 structured JSON or indexed source span')
}
function integer(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid()
  return value
}
/** One original bounded encoder for provisional grammar output. Full chunks
 * transfer ownership; the unfinished tail remains owned and erased on close.
 * Each caller performs its original exact-span/digest checks before publishing
 * that tail, and retains the charge until its original cleanup point. */
class StructuredUtf8Output {
  readonly #encoder = new TextEncoder()
  readonly #charge: WorkingCharge
  #buffer: Uint8Array
  #owned = true
  #used = 0
  #total = 0
  constructor(
    private readonly policy: Policy,
    private readonly maximum: number,
    private readonly limitMessage: string
  ) {
    this.#charge = policy.working.claim(256 + 2 * policy.width)
    try {
      this.#buffer = new Uint8Array(policy.width)
    } catch (cause) {
      this.#charge.close()
      throw cause
    }
  }
  async *encode(parts: AsyncIterable<string>): AsyncGenerator<Uint8Array> {
    for await (const part of parts) {
      this.policy.signal?.throwIfAborted()
      const scratch = this.policy.working.claim(512 + 8 * part.length)
      let bytes: Uint8Array | undefined
      try {
        bytes = this.#encoder.encode(part)
        if (bytes.length > this.maximum - this.#total) throw new SnapshotResourceLimitError(this.limitMessage)
        this.#total += bytes.length
        for (let offset = 0; offset < bytes.length;) {
          const count = Math.min(bytes.length - offset, this.policy.width - this.#used)
          this.#buffer.set(bytes.subarray(offset, offset + count), this.#used)
          this.#used += count
          offset += count
          if (this.#used === this.policy.width) {
            this.#owned = false
            yield this.#buffer
            this.#buffer = new Uint8Array(this.policy.width)
            this.#owned = true
            this.#used = 0
          }
        }
      } finally {
        bytes?.fill(0)
        scratch.close()
      }
    }
  }
  tail(): Uint8Array | undefined {
    return this.#used === 0 ? undefined : this.#buffer.slice(0, this.#used)
  }
  close(): void {
    if (this.#owned) this.#buffer.fill(0)
    this.#charge.close()
  }
}

/** Live resource accounting only, never source/schema/semantic authority.
 * Claims are released with their actual reachable parser scope. The original
 * maximum is immutable; recursion, output and digest passes cannot renew it. */
class WorkingAllocation {
  #used = 4096
  #combinedCharge?: Brc38WorkingCharge
  constructor(
    readonly maximum: number | undefined,
    private readonly combined?: Brc38WorkingAllocation
  ) {}
  change(delta: number): void {
    const next = this.#used + delta
    if (!Number.isSafeInteger(next) || next < 4096 || (this.maximum !== undefined && next > this.maximum))
      throw new SnapshotResourceLimitError('BRC-38 structured grammar exceeds its original working allocation')
    // The grammar base and all live scopes count together. Release the base
    // when no parser scope remains, including preflight failures and EOF.
    if (this.combined !== undefined) {
      if (next === 4096) {
        this.#combinedCharge?.close()
        this.#combinedCharge = undefined
      } else if (this.#combinedCharge === undefined) this.#combinedCharge = this.combined.claim(next)
      else this.#combinedCharge.resize(next)
    }
    this.#used = next
  }
  claim(bytes: number): WorkingCharge {
    this.change(bytes + 64)
    return new WorkingCharge(this, bytes)
  }
}
class WorkingCharge {
  #closed = false
  constructor(
    private readonly owner: WorkingAllocation,
    private bytes: number
  ) {}
  resize(bytes: number): void {
    if (this.#closed || !Number.isSafeInteger(bytes) || bytes < 0) invalid()
    this.owner.change(bytes - this.bytes)
    this.bytes = bytes
  }
  close(): void {
    if (!this.#closed) {
      this.owner.change(-this.bytes - 64)
      this.#closed = true
    }
  }
}
interface ChargedText {
  value: string
  readonly charge: WorkingCharge
}
function releaseText(text: ChargedText): void {
  text.value = ''
  text.charge.close()
}
function allocation(maximum: number | undefined, combined?: Brc38WorkingAllocation): WorkingAllocation {
  return new WorkingAllocation(
    maximum === undefined ? undefined : integer(maximum, 4096, 16777216),
    brc38WorkingAllocation(combined)
  )
}
/** At most one detached input extent, with byte offsets independent of decoder
 * windows. UTF-8 is decoded strictly; UTF-16 retains original code units until
 * the portable-value pass rejects an unpaired surrogate. */
class Input {
  position: number
  #bytes = new Uint8Array(0)
  #start = -1
  #charge?: WorkingCharge
  constructor(
    readonly source: Brc38StreamedStructured,
    readonly width: number,
    readonly signal: AbortSignal | undefined,
    readonly working: WorkingAllocation,
    start = 0,
    readonly end = source.length
  ) {
    this.position = start
  }
  dispose(): void {
    this.#bytes.fill(0)
    this.#bytes = new Uint8Array(0)
    this.#start = -1
    this.#charge?.close()
    this.#charge = undefined
  }
  async byte(offset: number): Promise<number> {
    this.signal?.throwIfAborted()
    if (offset < 0 || offset >= this.end) invalid()
    if (offset < this.#start || offset >= this.#start + this.#bytes.length) {
      this.dispose()
      const length = Math.min(this.width, this.source.length - offset),
        charge = this.working.claim(256 + 2 * length)
      try {
        const value = await this.source.read(offset, length)
        this.signal?.throwIfAborted()
        if (!(value instanceof Uint8Array) || value.length !== length) invalid()
        this.#bytes = value.slice()
        this.#start = offset
        this.#charge = charge
      } catch (error) {
        charge.close()
        throw error
      }
    }
    return this.#bytes[offset - this.#start]
  }
  point(): { text: string; bytes: number } | Promise<{ text: string; bytes: number }> {
    this.signal?.throwIfAborted()
    if (this.position >= this.end) return { text: '', bytes: 0 }
    const at = this.position - this.#start
    if (at < 0 || at >= this.#bytes.length) return this.loadPoint()
    const first = this.#bytes[at],
      count = this.source.encoding === 'utf16le' ? 2 : this.pointBytes(first)
    if (this.position + count > this.end) invalid()
    if (at + count > this.#bytes.length) return this.loadPoint()
    return this.decodePoint(first, count, offset => this.#bytes[at + offset])
  }
  private pointBytes(first: number): number {
    return first < 128
      ? 1
      : first >= 0xc2 && first <= 0xdf
        ? 2
        : first >= 0xe0 && first <= 0xef
          ? 3
          : first >= 0xf0 && first <= 0xf4
            ? 4
            : invalid()
  }
  private decodePoint(first: number, count: number, byte: (offset: number) => number): { text: string; bytes: number } {
    if (this.source.encoding === 'utf16le') {
      return { text: String.fromCharCode(first | (byte(1) << 8)), bytes: 2 }
    }
    if (first < 128) return { text: String.fromCharCode(first), bytes: 1 }
    let point = first & (count === 2 ? 31 : count === 3 ? 15 : 7)
    for (let i = 1; i < count; i++) {
      const next = byte(i)
      if (next < 0x80 || next > 0xbf) invalid()
      point = point * 64 + (next & 63)
    }
    if (
      point < (count === 2 ? 0x80 : count === 3 ? 0x800 : 0x10000) ||
      point > 0x10ffff ||
      (point >= 0xd800 && point <= 0xdfff)
    )
      invalid()
    return { text: String.fromCodePoint(point), bytes: count }
  }
  private async loadPoint(): Promise<{ text: string; bytes: number }> {
    const first = await this.byte(this.position),
      count = this.source.encoding === 'utf16le' ? 2 : this.pointBytes(first)
    if (this.position + count > this.end) invalid()
    // At a window boundary, retain at most four scalar bytes; no decoded
    // value or admission verdict is cached across source reads.
    const next: number[] = [first]
    for (let i = 1; i < count; i++) next.push(await this.byte(this.position + i))
    return this.decodePoint(first, count, offset => next[offset])
  }
  peek(): string | Promise<string> {
    const value = this.point()
    return value instanceof Promise ? value.then(point => point.text) : value.text
  }
  take(): string | Promise<string> {
    const value = this.point()
    if (value instanceof Promise)
      return value.then(point => {
        this.position += point.bytes
        return point.text
      })
    this.position += value.bytes
    return value.text
  }
  async expect(value: string): Promise<void> {
    if ((await this.take()) !== value) invalid()
  }
  async whitespace(): Promise<void> {
    while ([' ', '\t', '\r', '\n'].includes(await this.peek())) await this.take()
  }
}
function decodedUnit(input: Input): string | undefined | Promise<string | undefined> {
  const next = input.take()
  return next instanceof Promise ? next.then(value => decodeUnit(input, value)) : decodeUnit(input, next)
}
function decodeUnit(input: Input, next: string): string | undefined | Promise<string> {
  if (next === '"') return undefined
  if (next === '' || next.charCodeAt(0) < 32) invalid()
  if (next !== '\\') return next
  return escapedUnit(input)
}
async function escapedUnit(input: Input): Promise<string> {
  const escape = await input.take(),
    simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }
  if (Object.hasOwn(simple, escape)) return simple[escape]
  if (escape !== 'u') invalid()
  let hex = ''
  for (let i = 0; i < 4; i++) {
    const unit = await input.take()
    if (!/^[0-9a-fA-F]$/.test(unit)) invalid()
    hex += unit
  }
  return String.fromCharCode(parseInt(hex, 16))
}
async function key(input: Input, maximum: number, policy: Policy): Promise<ChargedText> {
  const charge = policy.working.claim(768),
    blocks: Uint16Array[] = []
  let units = 0
  try {
    await input.expect('"')
    for (let next = await decodedUnit(input); next !== undefined; next = await decodedUnit(input)) {
      if (next.length > maximum - units)
        throw new SnapshotResourceLimitError('BRC-38 structured key exceeds its code-unit policy')
      // Charge before allocating a code-unit block or extending the eventual
      // decoded string. Fixed blocks avoid one rope node per decoded unit.
      charge.resize(768 + 16 * (units + next.length))
      for (let at = 0; at < next.length; at++) {
        if (units % 128 === 0) blocks.push(new Uint16Array(128))
        blocks[Math.floor(units / 128)][units % 128] = next.charCodeAt(at)
        units++
      }
    }
    const parts: string[] = []
    for (let at = 0; at < blocks.length; at++) {
      const amount = Math.min(128, units - at * 128)
      parts.push(String.fromCharCode(...blocks[at].subarray(0, amount)))
    }
    const value = parts.join('')
    // CanonicalPortableChunks retains the original Unicode predicate, now with
    // explicit scratch accounting and the selected bounded output window.
    charge.resize(768 + 16 * units + 2 * policy.width)
    if (!policy.rawKeys)
      for (const _chunk of canonicalPortableChunks(value, {
        maximumValueBytes: maximum * 2 + 64,
        maximumChunkBytes: policy.width,
        signal: policy.signal
      })) {
        /* Unicode validation only. */
      }
    for (const block of blocks) block.fill(0)
    blocks.length = 0
    parts.length = 0
    charge.resize(512 + 16 * units)
    return { value, charge }
  } catch (error) {
    for (const block of blocks) block.fill(0)
    charge.close()
    throw error
  }
}
async function numberToken(input: Input, maximum: number, policy: Policy): Promise<ChargedText> {
  const charge = policy.working.claim(512)
  let value = ''
  try {
    while (/^[0-9eE+.-]$/.test(await input.peek())) {
      if (value.length === maximum)
        throw new SnapshotResourceLimitError('BRC-38 structured number exceeds its token policy')
      charge.resize(512 + 16 * (value.length + 1))
      value += await input.take()
    }
    if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(value)) invalid()
    return { value, charge }
  } catch (error) {
    charge.close()
    throw error
  }
}
async function literal(input: Input, value: string): Promise<void> {
  for (const unit of value) await input.expect(unit)
}
interface Policy {
  width: number
  key: number
  number: number
  signal?: AbortSignal
  working: WorkingAllocation
  rawKeys?: boolean
}
/** Syntax pass. Values discarded by duplicate-key replacement are checked as
 * JSON syntax, rather than rejected using semantics JSON.parse would discard. */
async function scan(
  input: Input,
  policy: Policy,
  index: Brc38JsonMemberIndex | undefined,
  depth: number
): Promise<void> {
  if (depth > 64) throw new SnapshotResourceLimitError('BRC-38 structured nesting exceeds 64 levels')
  const frame = policy.working.claim(512)
  try {
    const first = await input.peek(),
      objectOffset = input.position
    if (first === '{') {
      await input.take()
      await input.whitespace()
      if ((await input.peek()) !== '}')
        while (true) {
          const keyOffset = input.position,
            name = await key(input, policy.key, policy)
          try {
            await input.whitespace()
            await input.expect(':')
            await input.whitespace()
            const start = input.position
            await scan(input, policy, index, depth + 1)
            if (index !== undefined)
              await index.put(objectOffset, { key: name.value, keyOffset, start, end: input.position })
          } finally {
            releaseText(name)
          }
          await input.whitespace()
          if ((await input.peek()) === '}') break
          await input.expect(',')
          await input.whitespace()
        }
      await input.expect('}')
    } else if (first === '[') {
      await input.take()
      await input.whitespace()
      if ((await input.peek()) !== ']')
        while (true) {
          await scan(input, policy, index, depth + 1)
          await input.whitespace()
          if ((await input.peek()) === ']') break
          await input.expect(',')
          await input.whitespace()
        }
      await input.expect(']')
    } else if (first === '"') {
      await input.take()
      for (;;) {
        const unit = decodedUnit(input),
          next = unit instanceof Promise ? await unit : unit
        if (next === undefined) break
        /* One unit, never the whole string. */
      }
    } else if (first === 't') await literal(input, 'true')
    else if (first === 'f') await literal(input, 'false')
    else if (first === 'n') await literal(input, 'null')
    else {
      const token = await numberToken(input, policy.number, policy)
      releaseText(token)
    }
  } finally {
    frame.close()
  }
}
class WalletChecks {
  #note: { ordinal: number; what: boolean } | undefined
  #when = ''
  constructor(
    readonly field: string,
    readonly rowPath: string
  ) {}
  private when(path: readonly (string | number)[]): boolean {
    return (
      this.field === 'history' &&
      path.length === 3 &&
      path[0] === 'notes' &&
      typeof path[1] === 'number' &&
      path[2] === 'when'
    )
  }
  enter(path: readonly (string | number)[], first: string): void {
    const name = `${this.rowPath}.${this.field}`
    if (path.length === 0 && first !== '{') throw new Error(`BRC-38 ${name} must be an object`)
    if (this.field === 'history' && path[0] === 'notes') {
      if (path.length === 1 && first !== '[') throw new Error(`BRC-38 ${name}.notes must be an array`)
      if (path.length === 2) {
        if (first !== '{' || typeof path[1] !== 'number')
          throw new Error(`BRC-38 ${name}.notes entries must be objects`)
        this.#note = { ordinal: path[1], what: false }
      }
      if (path.length === 3 && path[2] === 'what') {
        if (first !== '"') throw new Error(`BRC-38 ${name}.notes.what must be a string`)
        if (this.#note === undefined || this.#note.ordinal !== path[1]) invalid()
        this.#note.what = true
      }
      if (this.when(path)) {
        if (first !== '"') throw new Error(`BRC-38 ${name}.notes.when must be a UTC ISO timestamp`)
        this.#when = ''
      }
    }
    if (this.field === 'notify' && path[0] === 'transactionIds') {
      if (path.length === 1 && first !== '[') throw new Error(`BRC-38 ${name}.transactionIds must be an array`)
      if (path.length === 2 && !/^[0-9-]$/.test(first))
        throw new Error(`BRC-38 ${name}.transactionIds must be an integer`)
    }
  }
  text(path: readonly (string | number)[], value: string): void {
    if (!this.when(path)) return
    if (value.length > 24 - this.#when.length)
      throw new Error(`BRC-38 ${this.rowPath}.history.notes.when must be a UTC ISO timestamp`)
    this.#when += value
  }
  textEnd(path: readonly (string | number)[]): void {
    if (this.when(path)) assertIsoDate(this.#when, `${this.rowPath}.history.notes.when`)
  }
  number(path: readonly (string | number)[], value: number): void {
    if (this.field === 'notify' && path.length === 2 && path[0] === 'transactionIds')
      requireNumber(value, `${this.rowPath}.notify.transactionIds`)
  }
  end(path: readonly (string | number)[]): void {
    if (this.field === 'history' && path.length === 2 && path[0] === 'notes') {
      if (this.#note === undefined || this.#note.ordinal !== path[1] || !this.#note.what)
        throw new Error(`BRC-38 ${this.rowPath}.history.notes.what must be a string`)
      this.#note = undefined
    }
  }
}
async function* stringParts(
  input: Input,
  policy: Policy,
  text?: (value: string) => void | Promise<void>,
  raw = false
): AsyncGenerator<string> {
  const charge = policy.working.claim(512)
  try {
    await input.expect('"')
    yield '"'
    let buffer = '',
      pending = ''
    while (true) {
      const unit = decodedUnit(input)
      let next = unit instanceof Promise ? await unit : unit
      if (next === undefined) {
        if (pending !== '') {
          if (!raw) invalid()
          buffer += pending
          pending = ''
          charge.resize(512 + 16 * buffer.length)
        }
        break
      }
      if (pending !== '') {
        if (next.length === 1 && next.charCodeAt(0) >= 0xdc00 && next.charCodeAt(0) <= 0xdfff) {
          next = pending + next
          pending = ''
        } else {
          if (!raw) invalid()
          buffer += pending
          pending = ''
          charge.resize(512 + 16 * (buffer.length + next.length))
          if (next.length === 1 && next.charCodeAt(0) >= 0xd800 && next.charCodeAt(0) <= 0xdbff) {
            pending = next
            if (buffer.length >= Math.floor(policy.width / 6) - 2) {
              if (text !== undefined) await text(buffer)
              yield JSON.stringify(buffer).slice(1, -1)
              buffer = ''
              charge.resize(512 + 16 * pending.length)
            }
            continue
          }
        }
      } else if (next.length === 1 && next.charCodeAt(0) >= 0xd800 && next.charCodeAt(0) <= 0xdbff) {
        pending = next
        charge.resize(512 + 16 * (buffer.length + pending.length))
        continue
      } else if (!raw && next.length === 1 && next.charCodeAt(0) >= 0xdc00 && next.charCodeAt(0) <= 0xdfff) invalid()
      charge.resize(512 + 16 * (buffer.length + pending.length + next.length))
      buffer += next
      if (buffer.length >= Math.floor(policy.width / 6) - 2) {
        if (text !== undefined) await text(buffer)
        yield JSON.stringify(buffer).slice(1, -1)
        buffer = ''
        charge.resize(512)
      }
    }
    if (buffer !== '') {
      if (text !== undefined) await text(buffer)
      yield JSON.stringify(buffer).slice(1, -1)
    }
    yield '"'
  } finally {
    charge.close()
  }
}
async function* sortedMembers(index: Brc38JsonMemberIndex, objectOffset: number): AsyncGenerator<Brc38JsonMember> {
  if (index.nextEntry === undefined) {
    yield* index.entries(objectOffset)
    return
  }
  let after: string | undefined
  for (;;) {
    const member = await index.nextEntry(objectOffset, after)
    if (member === undefined) return
    if (typeof member.key !== 'string' || (after !== undefined && member.key <= after)) invalid()
    after = member.key
    yield member
  }
}

async function* emit(
  input: Input,
  policy: Policy,
  index: Brc38JsonMemberIndex,
  field: string,
  path: readonly (string | number)[],
  depth: number,
  checks?: WalletChecks,
  visitor?: Readonly<Brc38StructuredVisitor>,
  notify?: Brc38StructuredNotifyIds,
  raw = false,
  edits?: ReadonlyMap<string, readonly Brc38StructuredMemberEdit[]>
): AsyncGenerator<string> {
  if (depth > 64) throw new SnapshotResourceLimitError('BRC-38 structured nesting exceeds 64 levels')
  const frame = policy.working.claim(512 + 16 * path.length)
  try {
    const first = await input.peek(),
      objectOffset = input.position
    checks?.enter(path, first)
    const point = visitor === undefined ? path : Object.freeze([...path])
    if (visitor?.enter !== undefined)
      await visitor.enter(
        point,
        first === '{'
          ? 'object'
          : first === '['
            ? 'array'
            : first === '"'
              ? 'string'
              : first === 't' || first === 'f'
                ? 'boolean'
                : first === 'n'
                  ? 'null'
                  : 'number',
        objectOffset
      )
    if (first === '{') {
      yield '{'
      let last: string | undefined,
        lastCharge: WorkingCharge | undefined,
        emitted = false,
        injected = false
      const inject = async function* (): AsyncGenerator<string> {
        if (emitted) yield ','
        emitted = true
        injected = true
        yield '"transactionIds":'
        yield* notifyIds(notify!, policy)
      }
      const replacements =
        path.length <= 2 && path.every(key => typeof key === 'string' && key.length <= 32)
          ? (edits?.get(JSON.stringify(path)) ?? [])
          : []
      let editOrdinal = 0
      const edited = function* (edit: Brc38StructuredMemberEdit): Generator<string> {
        const value = edit.value()
        if (
          typeof value === 'string'
            ? value.length > 8192
            : value !== null && typeof value !== 'boolean' && (typeof value !== 'number' || !Number.isFinite(value))
        )
          invalid()
        if (emitted) yield ','
        emitted = true
        yield JSON.stringify(edit.key)
        yield ':'
        yield JSON.stringify(value)
      }
      try {
        for await (const member of sortedMembers(index, objectOffset)) {
          if (
            typeof member.key !== 'string' ||
            member.key.length > policy.key ||
            (last !== undefined && member.key <= last) ||
            !Number.isSafeInteger(member.keyOffset) ||
            member.keyOffset <= objectOffset ||
            !Number.isSafeInteger(member.start) ||
            member.start <= member.keyOffset ||
            !Number.isSafeInteger(member.end) ||
            member.end <= member.start ||
            member.end > input.end
          )
            invalid()
          const memberCharge = policy.working.claim(512 + 16 * member.key.length)
          lastCharge?.close()
          lastCharge = memberCharge
          last = member.key
          const childPath = [...path, member.key],
            check = new Input(input.source, policy.width, policy.signal, policy.working, member.keyOffset, member.end)
          try {
            if (visitor?.member !== undefined) {
              if (index.lookup === undefined)
                throw new Error('Original JSON enumeration requires its actual first-insertion index')
              const original = await index.lookup(objectOffset, member.key)
              if (
                original === undefined ||
                original.key !== member.key ||
                original.keyOffset !== member.keyOffset ||
                original.start !== member.start ||
                original.end !== member.end ||
                original.firstKeyOffset > original.keyOffset ||
                original.firstKeyOffset <= objectOffset
              )
                invalid()
              await visitor.member(Object.freeze([...childPath]), Object.freeze({ ...original }))
            }
            const originalKey = await key(check, policy.key, policy)
            try {
              if (originalKey.value !== member.key) invalid()
            } finally {
              releaseText(originalKey)
            }
            await check.whitespace()
            await check.expect(':')
            await check.whitespace()
            if (check.position !== member.start) invalid()
            while (editOrdinal < replacements.length && replacements[editOrdinal].key < member.key) {
              const replacement = replacements[editOrdinal++]
              if (!replacement.existingOnly) yield* edited(replacement)
            }
            if (editOrdinal < replacements.length && replacements[editOrdinal].key === member.key) {
              // A replacement cannot launder invalid original syntax or semantics.
              for await (const _part of emit(
                check,
                policy,
                index,
                field,
                childPath,
                depth + 1,
                checks,
                visitor,
                undefined,
                raw
              )) {
                /* Original validation only. */
              }
              if (check.position !== member.end) invalid()
              yield* edited(replacements[editOrdinal++])
              continue
            }
            if (notify !== undefined && path.length === 0 && member.key === 'transactionIds') {
              // Validate the original visible member even though its output is
              // replaced. Invalid histories must not be laundered by projection.
              if ((await check.peek()) === 'n' && isOptionalBrc38StructuredField(field, childPath))
                await literal(check, 'null')
              else
                for await (const _part of emit(check, policy, index, field, childPath, depth + 1, checks)) {
                  /* Validation only. */
                }
              if (check.position !== member.end) invalid()
              yield* inject()
              continue
            }
            if (!raw && (await check.peek()) === 'n' && isOptionalBrc38StructuredField(field, childPath)) {
              await literal(check, 'null')
              if (check.position !== member.end) invalid()
              continue
            }
            if (notify !== undefined && path.length === 0 && !injected && member.key > 'transactionIds') yield* inject()
            if (emitted) yield ','
            emitted = true
            // A key is independently bounded to 8,192 units and was validated in
            // the syntax pass. Encode it once; the outer byte buffer may split UTF-8
            // anywhere without accidentally decoding partial UTF-8 chunks.
            yield JSON.stringify(member.key)
            yield ':'
            yield* emit(check, policy, index, field, childPath, depth + 1, checks, visitor, undefined, raw, edits)
            if (check.position !== member.end) invalid()
          } finally {
            check.dispose()
          }
        }
      } finally {
        last = undefined
        lastCharge?.close()
      }
      if (notify !== undefined && path.length === 0 && !injected) yield* inject()
      while (editOrdinal < replacements.length) {
        const replacement = replacements[editOrdinal++]
        if (!replacement.existingOnly) yield* edited(replacement)
      }
      // Retain the containing reader's sequential position without allocating
      // this object. Every member's bytes are checked independently above.
      await scan(input, policy, undefined, depth)
      checks?.end(path)
      yield '}'
    } else if (first === '[') {
      await input.take()
      await input.whitespace()
      yield '['
      let ordinal = 0
      if ((await input.peek()) !== ']')
        while (true) {
          if (ordinal !== 0) yield ','
          yield* emit(
            input,
            policy,
            index,
            field,
            [...path, ordinal++],
            depth + 1,
            checks,
            visitor,
            undefined,
            raw,
            edits
          )
          await input.whitespace()
          if ((await input.peek()) === ']') break
          await input.expect(',')
          await input.whitespace()
        }
      await input.expect(']')
      yield ']'
    } else if (first === '"') {
      yield* stringParts(
        input,
        policy,
        checks === undefined && visitor?.text === undefined
          ? undefined
          : async value => {
              checks?.text(path, value)
              await visitor?.text?.(point, value)
            },
        raw
      )
      checks?.textEnd(path)
    } else if (first === 't') {
      await literal(input, 'true')
      await visitor?.boolean?.(point, true)
      yield 'true'
    } else if (first === 'f') {
      await literal(input, 'false')
      await visitor?.boolean?.(point, false)
      yield 'false'
    } else if (first === 'n') {
      if (!raw) invalid()
      await literal(input, 'null')
      await visitor?.null?.(point)
      yield 'null'
    } else {
      const token = await numberToken(input, policy.number, policy)
      let value: number
      try {
        value = Number(token.value)
      } finally {
        releaseText(token)
      }
      if (!raw && !Number.isFinite(value)) invalid()
      checks?.number(path, value)
      await visitor?.number?.(point, value)
      yield JSON.stringify(value)
    }
    await visitor?.end?.(point, input.position)
  } finally {
    frame.close()
  }
}
/** Stream a selected original string span in canonical JSON spelling. The
 * coordinates are DATA: validate its actual syntax and the complete current
 * source digest before and after output. The owning source must independently
 * recheck original admission/expiry around each range operation. */
export async function* canonicalBrc38StructuredStringSpan(
  selected: Brc38StreamedStructured,
  selectedSpan: Readonly<{ start: number; end: number }>,
  options: Brc38StructuredJsonPolicy
): AsyncGenerator<Uint8Array> {
  const source = Object.freeze({ ...selected }),
    span = Object.freeze({ ...selectedSpan }),
    maximumInput = integer(options.maximumInputBytes, 1, 1000000000),
    maximumOutput = integer(options.maximumOutputBytes, 2, 1000000000),
    policy: Policy = {
      width: integer(options.maximumChunkBytes ?? 65536, 64, 65536),
      key: 8192,
      number: 8192,
      signal: options.signal,
      working: allocation(options.maximumAllocationBytes, options.workingAllocation)
    }
  integer(source.length, 1, maximumInput)
  integer(span.start, 0, source.length - 1)
  integer(span.end, span.start + 1, source.length)
  if (
    !['utf8', 'utf16le'].includes(source.encoding) ||
    (source.encoding === 'utf16le' && (source.length % 2 !== 0 || span.start % 2 !== 0 || span.end % 2 !== 0)) ||
    !/^[0-9a-f]{64}$/.test(source.sha256) ||
    typeof source.read !== 'function'
  )
    invalid()
  policy.signal?.throwIfAborted()
  await digest(source, policy)
  const input = new Input(source, policy.width, policy.signal, policy.working, span.start, span.end)
  let output: StructuredUtf8Output | undefined
  try {
    output = new StructuredUtf8Output(
      policy,
      maximumOutput,
      'Private structured string projection exceeds its byte limit'
    )
    yield* output.encode(stringParts(input, policy))
    if (input.position !== span.end) invalid()
    input.dispose()
    await digest(source, policy)
    const tail = output.tail()
    if (tail !== undefined) yield tail
  } finally {
    input.dispose()
    output?.close()
  }
}
/** ECMAScript UTF-16 lexical comparison of TWO actual JSON string spans.
 * Escaped/raw Unicode and astral pairs use decoded code units; no complete
 * string, escaped spelling or sort key is allocated. Both strings drain to
 * their exact original span EOF even when an earlier unit decides the order,
 * so invalid trailing syntax cannot become an accepted rank. Raw legacy JSON
 * lone surrogates retain ordinary JavaScript comparison behavior. This is
 * comparison DATA only: the enclosing controller independently authenticates
 * complete sources and freshly replays them before final field attachment. */
export async function compareBrc38StructuredStringSpans(
  selectedLeft: Brc38StreamedStructured,
  selectedLeftSpan: Readonly<{ start: number; end: number }>,
  selectedRight: Brc38StreamedStructured,
  selectedRightSpan: Readonly<{ start: number; end: number }>,
  selected: Brc38StructuredStringComparePolicy
): Promise<-1 | 0 | 1> {
  return await compareBrc38StructuredStringSequences(
    [{ source: selectedLeft, span: selectedLeftSpan }],
    [{ source: selectedRight, span: selectedRightSpan }],
    selected
  )
}
export type Brc38StructuredStringPart =
  | Readonly<{ literal: string }>
  | Readonly<{ source: Brc38StreamedStructured; span: Readonly<{ start: number; end: number }>; coerce?: true }>
/** JSON values have no callable own methods. Ordinary object coercion uses
 * Object.prototype.toString unless an own toString shadows it; arrays use
 * recursive join, with null elements empty. This models template-string
 * coercion without allocating a whole array/string or evaluating JSON data. */
async function* coercedJsonText(input: Input, policy: Policy, depth = 1, arrayElement = false): AsyncGenerator<string> {
  if (depth > 64) invalid()
  const frame = policy.working.claim(512)
  try {
    const first = await input.peek()
    if (first === '"') {
      await input.take()
      for (let part = await decodedUnit(input); part !== undefined; part = await decodedUnit(input)) yield part
    } else if (first === '[') {
      await input.take()
      await input.whitespace()
      let count = 0
      if ((await input.peek()) !== ']')
        for (;;) {
          if (count++ !== 0) yield ','
          yield* coercedJsonText(input, policy, depth + 1, true)
          await input.whitespace()
          if ((await input.peek()) === ']') break
          await input.expect(',')
          await input.whitespace()
        }
      await input.expect(']')
    } else if (first === '{') {
      await input.take()
      await input.whitespace()
      let shadowsToString = false
      if ((await input.peek()) !== '}')
        for (;;) {
          const name = await key(input, policy.key, policy)
          try {
            if (name.value === 'toString') shadowsToString = true
          } finally {
            releaseText(name)
          }
          await input.whitespace()
          await input.expect(':')
          await input.whitespace()
          await scan(input, policy, undefined, depth + 1)
          await input.whitespace()
          if ((await input.peek()) === '}') break
          await input.expect(',')
          await input.whitespace()
        }
      await input.expect('}')
      if (shadowsToString) throw new TypeError('Cannot convert request-history note value to primitive')
      yield '[object Object]'
    } else if (first === 'n') {
      await literal(input, 'null')
      if (!arrayElement) yield 'null'
    } else if (first === 't') {
      await literal(input, 'true')
      yield 'true'
    } else if (first === 'f') {
      await literal(input, 'false')
      yield 'false'
    } else {
      const token = await numberToken(input, policy.number, policy)
      try {
        yield String(Number(token.value))
      } finally {
        releaseText(token)
      }
    }
  } finally {
    frame.close()
  }
}
/** Compare the complete concatenation, including separators and missing-value
 * spellings. Comparing each component independently would change the legacy
 * `${when} ${what}` ordering when one component is a prefix of another. */
export async function compareBrc38StructuredStringSequences(
  selectedLeft: readonly Brc38StructuredStringPart[],
  selectedRight: readonly Brc38StructuredStringPart[],
  selected: Brc38StructuredStringComparePolicy
): Promise<-1 | 0 | 1> {
  const capture = (parts: readonly Brc38StructuredStringPart[]): readonly Brc38StructuredStringPart[] => {
    if (!Array.isArray(parts) || parts.length > 8) invalid()
    return Object.freeze(
      parts.map(part =>
        'literal' in part
          ? Object.freeze({ literal: part.literal })
          : Object.freeze({
              source: Object.freeze({ ...part.source }),
              span: Object.freeze({ ...part.span }),
              coerce: part.coerce
            })
      )
    )
  }
  const left = capture(selectedLeft),
    right = capture(selectedRight),
    options = Object.freeze({
      maximumInputBytes: selected.maximumInputBytes,
      maximumDecodedCodeUnits: selected.maximumDecodedCodeUnits,
      maximumReadBytes: selected.maximumReadBytes,
      maximumAllocationBytes: selected.maximumAllocationBytes,
      workingAllocation: selected.workingAllocation,
      expiresAt: selected.expiresAt,
      signal: selected.signal,
      check: selected.check
    }),
    maximum = integer(options.maximumInputBytes, 2, 1000000000),
    units = integer(options.maximumDecodedCodeUnits, 0, 1000000000),
    width = integer(options.maximumReadBytes, 64, 65536),
    combined = brc38WorkingAllocation(options.workingAllocation),
    working = allocation(options.maximumAllocationBytes, combined),
    deadline = performance.now() + options.expiresAt - Date.now()
  if (
    !Number.isSafeInteger(options.expiresAt) ||
    options.expiresAt <= Date.now() ||
    options.expiresAt > Date.now() + 3600000 ||
    typeof options.check !== 'function' ||
    combined === undefined
  )
    invalid()
  for (const part of [...left, ...right]) {
    if ('literal' in part) {
      if (typeof part.literal !== 'string' || part.literal.length > 64) invalid()
      continue
    }
    const { source, span } = part
    if (part.coerce !== undefined && part.coerce !== true) invalid()
    integer(source.length, 2, maximum)
    integer(span.start, 0, source.length - 1)
    integer(span.end, span.start + 1, source.length)
    if (
      !['utf8', 'utf16le'].includes(source.encoding) ||
      typeof source.read !== 'function' ||
      !/^[0-9a-f]{64}$/.test(source.sha256) ||
      (source.encoding === 'utf16le' && (source.length % 2 !== 0 || span.start % 2 !== 0 || span.end % 2 !== 0))
    )
      invalid()
  }
  const check = (): void => {
      options.signal?.throwIfAborted()
      options.check()
      if (Date.now() >= options.expiresAt || performance.now() >= deadline)
        throw new SnapshotResourceLimitError('Structured string comparison reached its original source deadline')
    },
    charge = working.claim(8192)
  const coercionPolicy: Policy = { width, key: 8192, number: 8192, signal: options.signal, working, rawKeys: true }
  type State = {
    parts: readonly Brc38StructuredStringPart[]
    position: number
    input?: Input
    coercion?: AsyncGenerator<string>
    pending: string
    done: boolean
    units: number
  }
  const next = async (state: State): Promise<number | undefined> => {
    check()
    if (state.done) return undefined
    while (state.pending === '') {
      if (state.position === state.parts.length) {
        state.done = true
        return undefined
      }
      const part = state.parts[state.position]
      if ('literal' in part) {
        state.pending = part.literal
        state.position++
        continue
      }
      if (state.input === undefined) {
        const guarded: Brc38StreamedStructured = {
          ...part.source,
          read: async (offset, length) => {
            check()
            const value = await part.source.read(offset, length)
            check()
            return value
          }
        }
        state.input = new Input(guarded, width, options.signal, working, part.span.start, part.span.end)
        if (part.coerce) state.coercion = coercedJsonText(state.input, coercionPolicy)
        else await state.input.expect('"')
        check()
      }
      const decoded =
        state.coercion === undefined ? await decodedUnit(state.input) : (await state.coercion.next()).value
      check()
      if (decoded === undefined) {
        if (state.input.position !== state.input.end) invalid()
        state.input.dispose()
        state.input = undefined
        state.coercion = undefined
        state.position++
        continue
      }
      state.pending = decoded
    }
    if (++state.units > units)
      throw new SnapshotResourceLimitError('Structured string exceeds its original decoded-unit allowance')
    const result = state.pending.charCodeAt(0)
    state.pending = state.pending.slice(1)
    return result
  }
  const a: State = { parts: left, position: 0, pending: '', done: false, units: 0 },
    b: State = { parts: right, position: 0, pending: '', done: false, units: 0 }
  try {
    check()
    let result: -1 | 0 | 1 = 0
    while (!a.done || !b.done) {
      const x = await next(a),
        y = await next(b)
      if (result === 0 && x !== y) result = x === undefined ? -1 : y === undefined ? 1 : x < y ? -1 : 1
    }
    check()
    return result
  } finally {
    try {
      await a.coercion?.return(undefined)
    } finally {
      try {
        await b.coercion?.return(undefined)
      } finally {
        a.input?.dispose()
        b.input?.dispose()
        charge.close()
      }
    }
  }
}
export type Brc38StructuredScalar =
  | Readonly<{ kind: 'string'; codeUnits: number; captured?: string }>
  | Readonly<{ kind: 'number'; value: number }>
  | Readonly<{ kind: 'boolean'; value: boolean }>
  | Readonly<{ kind: 'null' | 'object' | 'array' }>
/** Fresh span inspection for primitive equality. Strings drain without being
 * materialized; callers can request at most 64 captured units for note dates.
 * Containers are syntax checked but never become reusable semantic verdicts. */
export async function inspectBrc38StructuredScalarSpan(
  selectedSource: Brc38StreamedStructured,
  selectedSpan: Readonly<{ start: number; end: number }>,
  selected: Brc38StructuredStringComparePolicy,
  maximumCapturedStringCodeUnits = 0
): Promise<Brc38StructuredScalar> {
  const original = Object.freeze({ ...selectedSource }),
    span = Object.freeze({ ...selectedSpan }),
    options = Object.freeze({ ...selected }),
    maximum = integer(options.maximumInputBytes, 2, 1000000000),
    width = integer(options.maximumReadBytes, 64, 65536),
    units = integer(options.maximumDecodedCodeUnits, 0, 1000000000),
    capturedLimit = integer(maximumCapturedStringCodeUnits, 0, 64),
    combined = brc38WorkingAllocation(options.workingAllocation),
    policy: Policy = {
      width,
      key: 8192,
      number: 8192,
      signal: options.signal,
      working: allocation(options.maximumAllocationBytes, combined),
      rawKeys: true
    },
    deadline = performance.now() + options.expiresAt - Date.now()
  integer(original.length, 2, maximum)
  integer(span.start, 0, original.length - 1)
  integer(span.end, span.start + 1, original.length)
  if (
    combined === undefined ||
    typeof options.check !== 'function' ||
    !Number.isSafeInteger(options.expiresAt) ||
    options.expiresAt <= Date.now() ||
    options.expiresAt > Date.now() + 3600000 ||
    !['utf8', 'utf16le'].includes(original.encoding) ||
    !/^[0-9a-f]{64}$/.test(original.sha256) ||
    (original.encoding === 'utf16le' && (original.length % 2 !== 0 || span.start % 2 !== 0 || span.end % 2 !== 0))
  )
    invalid()
  const check = (): void => {
      options.signal?.throwIfAborted()
      options.check()
      if (Date.now() >= options.expiresAt || performance.now() >= deadline)
        throw new SnapshotResourceLimitError('Structured scalar inspection reached its original source deadline')
    },
    source: Brc38StreamedStructured = {
      ...original,
      read: async (offset, length) => {
        check()
        const result = await original.read(offset, length)
        check()
        return result
      }
    },
    input = new Input(source, width, options.signal, policy.working, span.start, span.end),
    retained = policy.working.claim(4096)
  try {
    check()
    const first = await input.peek()
    let result: Brc38StructuredScalar
    if (first === '"') {
      await input.take()
      let codeUnits = 0,
        captured: string | undefined = ''
      for (let part = await decodedUnit(input); part !== undefined; part = await decodedUnit(input)) {
        check()
        codeUnits += part.length
        if (codeUnits > units)
          throw new SnapshotResourceLimitError('Structured scalar exceeds its original decoded-unit allowance')
        if (codeUnits > capturedLimit) captured = undefined
        else if (captured !== undefined) captured += part
      }
      result = Object.freeze({ kind: 'string', codeUnits, captured })
    } else if (first === 't' || first === 'f') {
      await literal(input, first === 't' ? 'true' : 'false')
      result = Object.freeze({ kind: 'boolean', value: first === 't' })
    } else if (first === 'n') {
      await literal(input, 'null')
      result = Object.freeze({ kind: 'null' })
    } else if (first === '{' || first === '[') {
      await scan(input, policy, undefined, 1)
      result = Object.freeze({ kind: first === '{' ? 'object' : 'array' })
    } else {
      const token = await numberToken(input, policy.number, policy)
      try {
        result = Object.freeze({ kind: 'number', value: Number(token.value) })
      } finally {
        releaseText(token)
      }
    }
    if (input.position !== span.end) invalid()
    check()
    return result
  } finally {
    input.dispose()
    retained.close()
  }
}
/** Raw legacy JSON visitation for occupied request-history merging. Unlike
 * the BRC-38 canonical exporter this preserves visible nulls, raw legacy
 * string code units and object/array extras. Last duplicate values and first
 * key insertion positions come from the actual owned index. No complete
 * object/string or emitted document is allocated. Full source digests run
 * independently before and after visitation; callbacks remain provisional
 * through exact EOF and physical index cleanup. This supplies no archive,
 * provider, source-profile or final-writer authority. */
export async function visitBrc38StructuredJsonValues(
  selected: Brc38StreamedStructured,
  selectedPolicy: Brc38StructuredJsonPolicy,
  selectedVisitor: Readonly<Brc38StructuredVisitor>
): Promise<void> {
  const source = Object.freeze({ ...selected }),
    visitor = Object.freeze({ ...selectedVisitor }),
    options = Object.freeze({ ...selectedPolicy }),
    policy: Policy = {
      width: integer(options.maximumChunkBytes ?? 65536, 64, 65536),
      key: integer(options.maximumKeyCodeUnits ?? 8192, 1, 8192),
      number: integer(options.maximumNumberCodeUnits ?? 8192, 1, 8192),
      signal: options.signal,
      working: allocation(options.maximumAllocationBytes, options.workingAllocation),
      rawKeys: true
    }
  integer(source.length, 1, integer(options.maximumInputBytes, 1, 1000000000))
  if (
    !['utf8', 'utf16le'].includes(source.encoding) ||
    (source.encoding === 'utf16le' && source.length % 2 !== 0) ||
    !/^[0-9a-f]{64}$/.test(source.sha256) ||
    typeof source.read !== 'function' ||
    typeof source.openIndex !== 'function'
  )
    invalid()
  policy.signal?.throwIfAborted()
  await digest(source, policy)
  const index = await source.openIndex()
  let input: Input | undefined,
    output: Input | undefined,
    failed = false,
    original: unknown
  const cleanupScope2 = new Brc38CleanupScope(async () => {
    input?.dispose()
    output?.dispose()
    try {
      await index.close()
    } catch (cause) {
      throw new Brc38StagingCleanupError(
        failed ? [original, cause] : [cause],
        'Raw history visitation retains its actual temporary index until physical cleanup',
        () => index.close()
      )
    }
  })
  try {
    input = new Input(source, policy.width, policy.signal, policy.working)
    await input.whitespace()
    if ((await input.peek()) !== '{') invalid()
    await scan(input, policy, index, 1)
    await input.whitespace()
    if (input.position !== source.length) invalid()
    input.dispose()
    input = undefined
    await index.seal()
    output = new Input(source, policy.width, policy.signal, policy.working)
    await output.whitespace()
    for await (const _part of emit(output, policy, index, 'history', [], 1, undefined, visitor, undefined, true)) {
      policy.signal?.throwIfAborted()
    }
    await output.whitespace()
    if (output.position !== source.length) invalid()
    output.dispose()
    output = undefined
    await digest(source, policy)
  } catch (cause) {
    failed = true
    original = cause
    {
      await cleanupScope2.close()
      throw cause
    }
  } finally {
    await cleanupScope2.close()
  }
}
function enumerationKey(key: string, firstKeyOffset: number): string {
  const number = Number(key)
  return Number.isInteger(number) && number >= 0 && number < 4294967295 && String(number) === key
    ? '0' + String(number).padStart(10, '0')
    : '1' + String(firstKeyOffset).padStart(16, '0')
}
/** Bounded JSON.stringify spelling of a selected actual legacy JSON value.
 * Integer property names precede other names; remaining properties retain
 * their first original insertion, with the last duplicate value. This keeps
 * nulls, arrays, -0/number normalization and raw legacy string code units.
 * The two owned external indexes hold coordinates, never semantic/source
 * authority. Original whole-source digests, fresh source calls, exact span
 * syntax and physical index drainage precede successful completion. */
export async function* stringifyBrc38StructuredJsonSpan(
  selected: Brc38StreamedStructured,
  selectedSpan: Readonly<{ start: number; end: number }>,
  selectedPolicy: Brc38StructuredJsonPolicy,
  selectedWhen?: Readonly<{ value: string }>,
  selectedNotes?: Readonly<{
    member?: 'notes' | 'transactionIds'
    chunks(maximumChunkBytes: number): AsyncIterable<Uint8Array>
    check(): void
    close(): Promise<void>
  }>
): AsyncGenerator<Uint8Array> {
  const source = Object.freeze({ ...selected }),
    span = Object.freeze({ ...selectedSpan }),
    options = Object.freeze({ ...selectedPolicy }),
    maximumInput = integer(options.maximumInputBytes, 1, 1000000000),
    maximumOutput = integer(options.maximumOutputBytes, 1, 1000000000),
    policy: Policy = {
      width: integer(options.maximumChunkBytes ?? 65536, 64, 65536),
      key: integer(options.maximumKeyCodeUnits ?? 8192, 1, 8192),
      number: integer(options.maximumNumberCodeUnits ?? 8192, 1, 8192),
      signal: options.signal,
      working: allocation(options.maximumAllocationBytes, options.workingAllocation),
      rawKeys: true
    },
    replacement = selectedWhen === undefined ? undefined : Object.freeze({ value: selectedWhen.value }),
    notes =
      selectedNotes === undefined
        ? undefined
        : Object.freeze({
            chunks: selectedNotes.chunks.bind(selectedNotes),
            check: selectedNotes.check.bind(selectedNotes),
            close: selectedNotes.close.bind(selectedNotes),
            member: selectedNotes.member ?? 'notes'
          })
  if (notes !== undefined && !['notes', 'transactionIds'].includes(notes.member)) invalid()
  if (replacement !== undefined && notes !== undefined) invalid()
  if (replacement !== undefined) assertIsoDate(replacement.value, 'history.note.when')
  integer(source.length, 1, maximumInput)
  integer(span.start, 0, source.length - 1)
  integer(span.end, span.start + 1, source.length)
  if (
    !['utf8', 'utf16le'].includes(source.encoding) ||
    (source.encoding === 'utf16le' && (source.length % 2 !== 0 || span.start % 2 !== 0 || span.end % 2 !== 0)) ||
    !/^[0-9a-f]{64}$/.test(source.sha256)
  )
    invalid()
  options.signal?.throwIfAborted()
  await digest(source, policy)
  const owned = new Set<Brc38JsonMemberIndex>(),
    acquisitions = new Set<Brc38StagingCleanupError>(),
    scopes = new Set<Input>(),
    cleanup = async (): Promise<void> => {
      const failures: unknown[] = []
      if (notes !== undefined)
        try {
          await notes.close()
        } catch (cause) {
          failures.push(cause)
        }
      for (const index of owned)
        try {
          await index.close()
          owned.delete(index)
        } catch (cause) {
          failures.push(cause)
        }
      for (const failure of acquisitions)
        try {
          await failure.retryCleanup()
          acquisitions.delete(failure)
        } catch (cause) {
          failures.push(cause)
        }
      if (failures.length !== 0)
        throw new Brc38StagingCleanupError(
          failures,
          'Legacy JSON spelling retains original temporary indexes until physical cleanup',
          cleanup
        )
    }
  let output: StructuredUtf8Output | undefined,
    failed = false,
    original: unknown
  const input = (start: number, end: number): Input => {
      const value = new Input(source, policy.width, policy.signal, policy.working, start, end)
      scopes.add(value)
      return value
    },
    dispose = (value: Input): void => {
      value.dispose()
      scopes.delete(value)
    }
  const cleanupScope3 = new Brc38CleanupScope(async () => {
    for (const value of scopes) value.dispose()
    scopes.clear()
    output?.close()
    try {
      await cleanup()
    } catch (cause) {
      throw new Brc38StagingCleanupError(
        failed ? [original, cause] : [cause],
        'Legacy JSON spelling remains provisional through actual cleanup',
        cleanup
      )
    }
  })
  try {
    const grammar = await source.openIndex()
    owned.add(grammar)
    const order = await source.openIndex()
    owned.add(order)
    const syntax = input(span.start, span.end)
    await syntax.whitespace()
    await scan(syntax, policy, grammar, 1)
    await syntax.whitespace()
    if (syntax.position !== span.end) invalid()
    dispose(syntax)
    await grammar.seal()
    const frames: Array<{ depth: number; offset: number; kind: 'object' | 'array' }> = [],
      frameCharge = policy.working.claim(8192),
      visible = input(span.start, span.end)
    try {
      await visible.whitespace()
      for await (const _part of emit(
        visible,
        policy,
        grammar,
        'history',
        [],
        1,
        undefined,
        {
          enter: (path, kind, offset) => {
            if (kind === 'object' || kind === 'array') {
              if (frames.length >= 64) invalid()
              frames.push({ depth: path.length, offset, kind })
            }
          },
          member: async (path, value) => {
            const parent = frames.at(-1)
            if (parent === undefined || parent.kind !== 'object' || parent.depth + 1 !== path.length) invalid()
            await order.put(parent.offset, {
              key: enumerationKey(value.key, value.firstKeyOffset),
              keyOffset: value.firstKeyOffset,
              start: value.start,
              end: value.end
            })
          },
          end: path => {
            if (frames.at(-1)?.depth === path.length) frames.pop()
          }
        },
        undefined,
        true
      )) {
        options.signal?.throwIfAborted()
      }
      await visible.whitespace()
      if (visible.position !== span.end || frames.length !== 0) invalid()
    } finally {
      dispose(visible)
      frames.length = 0
      frameCharge.close()
    }
    await order.seal()
    const parts = async function* (value: Input, depth: number): AsyncGenerator<string> {
      if (depth > 64) throw new SnapshotResourceLimitError('Legacy JSON spelling exceeds original nesting allowance')
      const frame = policy.working.claim(512)
      try {
        const first = await value.peek(),
          offset = value.position
        if (first === '{') {
          yield '{'
          let count = 0,
            replaced = false,
            notesReplaced = false
          for await (const member of sortedMembers(order, offset)) {
            const nameInput = input(member.keyOffset, source.length),
              name = await key(nameInput, policy.key, policy)
            dispose(nameInput)
            try {
              if (grammar.lookup === undefined) invalid()
              const actual = await grammar.lookup(offset, name.value)
              if (
                actual === undefined ||
                actual.firstKeyOffset !== member.keyOffset ||
                actual.start !== member.start ||
                actual.end !== member.end ||
                member.key !== enumerationKey(name.value, member.keyOffset)
              )
                invalid()
              if (count++ !== 0) yield ','
              yield JSON.stringify(name.value)
              yield ':'
              const child = input(member.start, member.end)
              try {
                if (depth === 1 && name.value === 'when' && replacement !== undefined) {
                  await scan(child, policy, undefined, depth + 1)
                  yield JSON.stringify(replacement.value)
                  replaced = true
                } else if (depth === 1 && notes !== undefined && name.value === notes.member) {
                  await scan(child, policy, undefined, depth + 1)
                  notes.check()
                  yield* brc38StructuredArrayText(
                    notes.chunks(policy.width),
                    {
                      maximumStructuredBytes: maximumOutput,
                      maximumChunkBytes: policy.width,
                      maximumKeyCodeUnits: policy.key,
                      maximumNumberCodeUnits: policy.number
                    },
                    options.workingAllocation!,
                    notes.check,
                    options.signal
                  )
                  notesReplaced = true
                  notes.check()
                } else yield* parts(child, depth + 1)
                if (child.position !== member.end) invalid()
              } finally {
                dispose(child)
              }
            } finally {
              releaseText(name)
            }
          }
          let actualCount = 0
          for await (const _member of sortedMembers(grammar, offset)) actualCount++
          if (actualCount !== count) invalid()
          if (depth === 1 && replacement !== undefined && !replaced) {
            if (count !== 0) yield ','
            yield '"when":'
            yield JSON.stringify(replacement.value)
          }
          if (depth === 1 && notes !== undefined && !notesReplaced) {
            if (count !== 0) yield ','
            yield JSON.stringify(notes.member)
            yield ':'
            notes.check()
            yield* brc38StructuredArrayText(
              notes.chunks(policy.width),
              {
                maximumStructuredBytes: maximumOutput,
                maximumChunkBytes: policy.width,
                maximumKeyCodeUnits: policy.key,
                maximumNumberCodeUnits: policy.number
              },
              options.workingAllocation!,
              notes.check,
              options.signal
            )
            notes.check()
          }
          await scan(value, policy, undefined, depth)
          yield '}'
        } else if (first === '[') {
          await value.take()
          await value.whitespace()
          yield '['
          let ordinal = 0
          if ((await value.peek()) !== ']')
            for (;;) {
              if (ordinal++ !== 0) yield ','
              yield* parts(value, depth + 1)
              await value.whitespace()
              if ((await value.peek()) === ']') break
              await value.expect(',')
              await value.whitespace()
            }
          await value.expect(']')
          yield ']'
        } else if (first === '"') yield* stringParts(value, policy, undefined, true)
        else if (first === 't') {
          await literal(value, 'true')
          yield 'true'
        } else if (first === 'f') {
          await literal(value, 'false')
          yield 'false'
        } else if (first === 'n') {
          await literal(value, 'null')
          yield 'null'
        } else {
          const token = await numberToken(value, policy.number, policy)
          let number: number
          try {
            number = Number(token.value)
          } finally {
            releaseText(token)
          }
          yield JSON.stringify(number)
        }
      } finally {
        frame.close()
      }
    }
    const current = input(span.start, span.end)
    await current.whitespace()
    output = new StructuredUtf8Output(policy, maximumOutput, 'Legacy JSON spelling exceeds original output allowance')
    yield* output.encode(parts(current, 1))
    await current.whitespace()
    if (current.position !== span.end) invalid()
    dispose(current)
    await digest(source, policy)
    const tail = output.tail()
    if (tail !== undefined) yield tail
  } catch (cause) {
    failed = true
    original = cause
    if (cause instanceof Brc38StagingCleanupError) acquisitions.add(cause)
    {
      await cleanupScope3.close()
      throw cause
    }
  } finally {
    await cleanupScope3.close()
  }
}
/** Fresh whole-content comparison only. This does not retain or return a
 * semantic/schema/source admission result; the host checks the actual retained
 * source owner around each read. Used after derived output to detect changes. */
export async function verifyBrc38StructuredSourceDigest(
  selected: Brc38StreamedStructured,
  maximumInputBytes: number,
  signal?: AbortSignal,
  maximumChunkBytes = 65536,
  maximumAllocationBytes?: number,
  workingAllocation?: Brc38WorkingAllocation
): Promise<void> {
  const source = Object.freeze({ ...selected }),
    maximum = integer(maximumInputBytes, 1, 1000000000)
  integer(source.length, 1, maximum)
  if (
    !['utf8', 'utf16le'].includes(source.encoding) ||
    (source.encoding === 'utf16le' && source.length % 2 !== 0) ||
    !/^[0-9a-f]{64}$/.test(source.sha256) ||
    typeof source.read !== 'function'
  )
    invalid()
  signal?.throwIfAborted()
  await digest(source, {
    width: integer(maximumChunkBytes, 64, 65536),
    key: 8192,
    number: 8192,
    signal,
    working: allocation(maximumAllocationBytes, workingAllocation)
  })
}
async function digest(source: Brc38StreamedStructured, policy: Policy): Promise<void> {
  const charge = policy.working.claim(2048 + 16 * policy.width)
  try {
    const hash = new SHA256()
    for (let offset = 0; offset < source.length; offset += policy.width) {
      policy.signal?.throwIfAborted()
      const length = Math.min(policy.width, source.length - offset),
        value = await source.read(offset, length)
      if (!(value instanceof Uint8Array) || value.length !== length) invalid()
      const owned = value.slice()
      try {
        hash.update(owned)
      } finally {
        owned.fill(0)
      }
    }
    if (hash.digestHex() !== source.sha256) throw new TypeError('BRC-38 structured source digest differs')
  } finally {
    charge.close()
  }
}
/** Bounded canonicalization of one arbitrarily large structured field. The
 * externally stored object index avoids a whole history/map, full key array or
 * JSON.parse allocation; array elements retain original order. Output stays
 * provisional through the independent final digest and actual index close. */
export async function* canonicalBrc38StructuredJson(
  field: string,
  selected: Brc38StreamedStructured,
  options: Brc38StructuredJsonPolicy
): AsyncGenerator<Uint8Array> {
  yield* canonical(field, selected, options)
}
/** Fresh complete visible-field validation under the original wallet rules.
 * It owns the actual index through both digest passes and never stores an
 * admission result. What strings remain streamed; note dates retain at most
 * 24 decoded units and notification IDs use the original integer predicate. */
export async function validateBrc38StructuredWalletField(
  field: string,
  source: Brc38StreamedStructured,
  options: Brc38StructuredJsonPolicy,
  rowPath: string
): Promise<void> {
  for await (const _bytes of validatedCanonicalBrc38StructuredWalletField(field, source, options, rowPath)) {
    /* Bounded validation only. */
  }
}
/** Canonical output remains provisional until both source digest passes, every
 * visible wallet rule and the actual index close succeed. Consumers must retain
 * private output and await EOF before marking any derived field complete. */
export async function* validatedCanonicalBrc38StructuredWalletField(
  field: string,
  source: Brc38StreamedStructured,
  options: Brc38StructuredJsonPolicy,
  rowPath: string
): AsyncGenerator<Uint8Array> {
  if (typeof rowPath !== 'string' || rowPath.length > 256) invalid()
  yield* canonical(field, source, options, new WalletChecks(field, rowPath))
}
/** A fresh indexed pass for bounded remapping/projection preparation. Callers
 * must finish this pass outside destination writers and retain provisional
 * effects privately until success; spans/events never authorize a source. */
export async function visitBrc38StructuredWalletField(
  field: string,
  source: Brc38StreamedStructured,
  options: Brc38StructuredJsonPolicy,
  rowPath: string,
  selected: Brc38StructuredVisitor
): Promise<void> {
  if (typeof rowPath !== 'string' || rowPath.length > 256 || selected === null || typeof selected !== 'object')
    invalid()
  const visitor = Object.freeze({
    enter: selected.enter,
    text: selected.text,
    number: selected.number,
    boolean: selected.boolean,
    end: selected.end
  })
  if (Object.values(visitor).some(value => value !== undefined && typeof value !== 'function')) invalid()
  for await (const _bytes of canonical(field, source, options, new WalletChecks(field, rowPath), visitor)) {
    /* Private effects only. */
  }
}
/** Preserve every other visible notify member and replace only the inactive
 * transactionIds projection in canonical key order. Raw originals remain
 * separate. Actual map/source/destination ownership and final postimage checks
 * are responsibilities of the enclosing private receiver. */
export async function* canonicalBrc38ProjectedNotify(
  source: Brc38StreamedStructured,
  options: Brc38StructuredJsonPolicy,
  rowPath: string,
  selected: Brc38StructuredNotifyIds
): AsyncGenerator<Uint8Array> {
  if (
    typeof rowPath !== 'string' ||
    rowPath.length > 256 ||
    selected === null ||
    typeof selected.chunks !== 'function' ||
    typeof selected.close !== 'function'
  )
    invalid()
  const projection = Object.freeze({ chunks: selected.chunks.bind(selected), close: selected.close.bind(selected) })
  let failed = false,
    original: unknown
  const cleanupScope4 = new Brc38CleanupScope(async () => {
    // Cleanup also applies when source admission fails before replacement.
    try {
      await projection.close()
    } catch (error_) {
      if (failed)
        throw new AggregateError([original, error_], 'Projected notify source and cleanup failed', { cause: original })
      throw error_
    }
  })
  try {
    yield* canonical('notify', source, options, new WalletChecks('notify', rowPath), undefined, projection)
  } catch (cause) {
    failed = true
    original = cause
    {
      await cleanupScope4.close()
      throw cause
    }
  } finally {
    await cleanupScope4.close()
  }
}
/** Internal current-state rewrite, preserving unknown members, nulls, arrays
 * and ordinary JSON primitive values. Output is provisional through whole
 * source digest verification and physical index cleanup. No admission, map,
 * row or primary authority is conveyed by edits or the returned bytes. */
export async function* rewriteBrc38StructuredJsonMembers(
  source: Brc38StreamedStructured,
  options: Brc38StructuredJsonPolicy,
  selected: readonly Brc38StructuredMemberEdit[],
  selectedVisitor: Readonly<Brc38StructuredVisitor>
): AsyncGenerator<Uint8Array> {
  if (!Array.isArray(selected) || selected.length > 4096) invalid()
  const working = brc38WorkingAllocation(options.workingAllocation),
    charge = working?.claim(8192 + 4096 * selected.length)
  try {
    const edits = selected
      .map(edit => {
        if (
          !Array.isArray(edit.path) ||
          edit.path.length > 2 ||
          edit.path.some((key: unknown) => typeof key !== 'string' || key.length > 32) ||
          typeof edit.key !== 'string' ||
          edit.key.length > 32 ||
          typeof edit.value !== 'function' ||
          (edit.existingOnly !== undefined && typeof edit.existingOnly !== 'boolean')
        )
          invalid()
        return Object.freeze({
          path: Object.freeze([...edit.path]),
          key: edit.key,
          existingOnly: edit.existingOnly,
          value: edit.value
        })
      })
      .sort((left, right) => {
        const a = JSON.stringify(left.path),
          b = JSON.stringify(right.path)
        return a < b ? -1 : a > b ? 1 : left.key < right.key ? -1 : left.key > right.key ? 1 : 0
      })
    for (let ordinal = 1; ordinal < edits.length; ordinal++)
      if (
        JSON.stringify(edits[ordinal - 1].path) === JSON.stringify(edits[ordinal].path) &&
        edits[ordinal - 1].key === edits[ordinal].key
      )
        invalid()
    const byPath = new Map<string, Brc38StructuredMemberEdit[]>()
    for (const edit of edits) {
      const key = JSON.stringify(edit.path),
        group = byPath.get(key)
      if (group === undefined) byPath.set(key, [edit])
      else group.push(edit)
    }
    const visitor = Object.freeze({ ...selectedVisitor })
    yield* canonical('syncMap', source, options, undefined, visitor, undefined, true, byPath)
  } finally {
    charge?.close()
  }
}
async function* canonical(
  field: string,
  selected: Brc38StreamedStructured,
  options: Brc38StructuredJsonPolicy,
  checks?: WalletChecks,
  visitor?: Readonly<Brc38StructuredVisitor>,
  notify?: Brc38StructuredNotifyIds,
  raw = false,
  edits?: ReadonlyMap<string, readonly Brc38StructuredMemberEdit[]>
): AsyncGenerator<Uint8Array> {
  const source = { ...selected },
    policy: Policy = {
      width: integer(options.maximumChunkBytes ?? 65536, 64, 65536),
      key: integer(options.maximumKeyCodeUnits ?? 8192, 1, 8192),
      number: integer(options.maximumNumberCodeUnits ?? 8192, 1, 8192),
      signal: options.signal,
      working: allocation(options.maximumAllocationBytes, options.workingAllocation),
      rawKeys: raw
    }
  const maximumInput = integer(options.maximumInputBytes, 1, Number.MAX_SAFE_INTEGER),
    maximumOutput = integer(options.maximumOutputBytes, 1, Number.MAX_SAFE_INTEGER)
  integer(source.length, 1, maximumInput)
  if (
    !['history', 'notify', 'syncMap', 'errorLocal', 'errorOther'].includes(field) ||
    !['utf16le', 'utf8'].includes(source.encoding) ||
    (source.encoding === 'utf16le' && source.length % 2 !== 0) ||
    !/^[0-9a-f]{64}$/.test(source.sha256) ||
    typeof source.read !== 'function' ||
    typeof source.openIndex !== 'function'
  )
    invalid()
  policy.signal?.throwIfAborted()
  await digest(source, policy)
  const index = await source.openIndex()
  let original: unknown,
    failed = false,
    input: Input | undefined,
    output: Input | undefined,
    encoded: StructuredUtf8Output | undefined
  const cleanupScope5 = new Brc38CleanupScope(async () => {
    input?.dispose()
    output?.dispose()
    encoded?.close()
    try {
      await index.close()
    } catch (error_) {
      if (failed)
        throw new AggregateError([original, error_], 'BRC-38 structured source and index cleanup failed', {
          cause: original
        })
      throw error_
    }
  })
  try {
    input = new Input(source, policy.width, policy.signal, policy.working)
    await input.whitespace()
    if ((await input.peek()) !== '{') invalid()
    await scan(input, policy, index, 1)
    await input.whitespace()
    if (input.position !== source.length) invalid()
    input.dispose()
    input = undefined
    await index.seal()
    output = new Input(source, policy.width, policy.signal, policy.working)
    await output.whitespace()
    encoded = new StructuredUtf8Output(policy, maximumOutput, 'BRC-38 structured output exceeds its byte policy')
    yield* encoded.encode(emit(output, policy, index, field, [], 1, checks, visitor, notify, raw, edits))
    await output.whitespace()
    if (output.position !== source.length) invalid()
    output.dispose()
    output = undefined
    await digest(source, policy)
    const tail = encoded.tail()
    if (tail !== undefined) yield tail
  } catch (error) {
    original = error
    failed = true
    {
      await cleanupScope5.close()
      throw error
    }
  } finally {
    await cleanupScope5.close()
  }
}
