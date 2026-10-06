import { parseBRC38Json, type BRC38Tables, type BRC38WalletData } from './index'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import { runInSeries } from '../../utility/runInSeries'

type Table = keyof BRC38Tables
type Row = BRC38Tables[Table][number]
type Value = string | number | boolean | Value[] | { [key: string]: Value }
export interface Brc38JsonStreamOptions {
  maximumArchiveBytes: number
  /** Conservative parsed-node/string charge for ONE provisional row. */
  maximumRowAllocationBytes: number
  /** All non-table metadata together, default 65,536 allocation bytes. */
  maximumMetadataAllocationBytes?: number
  maximumInputChunkBytes?: number
  /** Includes empty chunks, so a producer cannot make unlimited zero-byte progress. */
  maximumInputChunks?: number
  signal?: AbortSignal
}
export interface Brc38JsonStagingSink {
  /** Private staging only. Awaited before reading the next row. No active wallet
   * writes, ID activation or capability publication may occur here. */
  provisionalRow: (table: Table, index: number, row: Readonly<Row>) => Promise<void>
  /** Independently validate every staged row, unique key, relation, profile and
   * original source/provenance. This callback must not activate the import.
   * Syntax/header completion alone is not complete portable semantic validation. */
  validateCompleted: (header: Readonly<BRC38WalletData>, counts: Readonly<Record<Table, number>>) => Promise<void>
  /** Wait for owned staging I/O and discard this private import after any error. */
  discard: (cause: unknown) => Promise<void>
}
export interface Brc38JsonStreamResult {
  readonly header: Readonly<BRC38WalletData>
  readonly counts: Readonly<Record<Table, number>>
  readonly inputBytes: number
}
const tables: readonly Table[] = Object.freeze([
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
const isTable = (value: string): value is Table => (tables as readonly string[]).includes(value)
const typedArrayPrototype: object = Object.getPrototypeOf(Uint8Array.prototype)
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!
const tagGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get!
const arrayBufferLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!
const copyBytes = Uint8Array.prototype.set
const whitespace = (unit: string | undefined): boolean =>
  unit === ' ' || unit === '\t' || unit === '\r' || unit === '\n'
function invalid(): never {
  throw new TypeError('Invalid bounded BRC-38 JSON stream')
}
function inputLength(value: Uint8Array): number {
  if (Reflect.apply(tagGetter, value, []) !== 'Uint8Array') invalid()
  const buffer: unknown = Reflect.apply(bufferGetter, value, [])
  // Ordinary ArrayBuffer ownership is required. Its intrinsic getter refuses
  // shared backing without reading caller-controlled properties or callbacks.
  Reflect.apply(arrayBufferLengthGetter, buffer, [])
  return Reflect.apply(byteLengthGetter, value, []) as number
}
function integer(value: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new RangeError(`${name} must be an integer from 1 to ${maximum}`)
  return value
}
function object(value: unknown): value is Record<string, Value> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function unicode(value: string): void {
  for (let index = 0; index < value.length; index++) {
    const point = value.codePointAt(index)!
    if (point >= 0xd800 && point <= 0xdfff) invalid()
    if (point > 0xffff) index++
  }
}
function portable(value: unknown): asserts value is Value {
  // ValueFrame has already bounded the complete nesting before JSON.parse.
  if (typeof value === 'string') unicode(value)
  else if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid()
  } else if (typeof value === 'boolean') return
  else if (Array.isArray(value)) {
    for (const child of value) portable(child)
  } else if (object(value)) {
    for (const key of Object.keys(value)) {
      unicode(key)
      portable(value[key])
    }
  } else invalid()
}
function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child)
    Object.freeze(value)
  }
  return value
}
interface Policy {
  maximumArchiveBytes: number
  maximumInputChunkBytes: number
  maximumInputChunks: number
  signal: AbortSignal | undefined
}
function* pending(continues: () => boolean): Generator<void> {
  while (continues()) yield undefined
}
class ValueFrame {
  readonly container: boolean
  readonly string: boolean
  quoted = false
  escaped = false
  atom = false
  depth = 0
  allocation = 0
  window = ''
  readonly pieces: string[] = []
  constructor(
    first: string,
    readonly maximum: number
  ) {
    this.container = first === '{' || first === '['
    this.string = first === '"'
  }
  charge(bytes: number): void {
    if (bytes > this.maximum - this.allocation)
      throw new SnapshotResourceLimitError('BRC-38 JSON value exceeds its allocation policy')
    this.allocation += bytes
  }
  delimiter(unit: string): boolean {
    return !this.quoted && !this.container && !this.string && (whitespace(unit) || ',:]}'.includes(unit))
  }
  quotedUnit(unit: string): void {
    if (this.escaped) this.escaped = false
    else if (unit === '\\') this.escaped = true
    else if (unit === '"') this.quoted = false
  }
  structuralUnit(unit: string): void {
    if (unit === '"') {
      this.charge(128)
      this.quoted = true
      this.atom = false
    } else if (unit === '{' || unit === '[') {
      this.charge(128)
      if (++this.depth > 64) throw new SnapshotResourceLimitError('BRC-38 JSON nesting exceeds 64 levels')
      this.atom = false
    } else if (unit === '}' || unit === ']') {
      this.depth--
      this.atom = false
    } else if (whitespace(unit) || unit === ',' || unit === ':') this.atom = false
    else if (!this.atom) {
      this.charge(128)
      this.atom = true
    }
  }
  accept(unit: string): boolean {
    this.charge(6)
    if (this.quoted) this.quotedUnit(unit)
    else this.structuralUnit(unit)
    this.window += unit
    if (this.window.length === 1024) {
      this.pieces.push(this.window)
      this.window = ''
    }
    return (this.container && this.depth === 0) || (this.string && !this.quoted)
  }
  finish(): { value: Value; allocation: number } {
    if (this.quoted || this.escaped || this.depth !== 0) invalid()
    this.pieces.push(this.window)
    const value: unknown = JSON.parse(this.pieces.join(''))
    portable(value)
    return { value, allocation: this.allocation }
  }
}
class Input {
  readonly iterator: AsyncIterator<Uint8Array>
  readonly decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  buffer = ''
  offset = 0
  done = false
  inputBytes = 0
  chunks = 0
  workUnits = 0
  closing: Promise<void> | undefined
  constructor(
    source: AsyncIterable<Uint8Array>,
    readonly policy: Policy
  ) {
    this.iterator = source[Symbol.asyncIterator]()
  }
  async peek(): Promise<string | undefined> {
    await this.yieldIfNeeded()
    this.policy.signal?.throwIfAborted()
    await runInSeries(
      pending(() => this.offset === this.buffer.length && !this.done),
      () => this.refill()
    )
    return this.offset === this.buffer.length ? undefined : this.buffer[this.offset]
  }
  advance(): void {
    this.offset++
    this.workUnits++
  }
  async yieldIfNeeded(): Promise<void> {
    if (this.workUnits >= 4096) {
      this.workUnits = 0
      // Resolved iterator/staging promises do not yield to timers or host
      // messages. Give cancellation and foreground work an actual task turn.
      await new Promise<void>(done => setTimeout(done, 0))
    }
    this.policy.signal?.throwIfAborted()
  }
  async refill(): Promise<void> {
    // The host must bound source I/O and settle it on cancellation. Never
    // abandon an in-flight iterator read and release its physical ownership.
    const next = await this.iterator.next()
    this.policy.signal?.throwIfAborted()
    this.offset = 0
    if (next.done === true) {
      this.done = true
      this.buffer = this.decoder.decode()
      return
    }
    const length = inputLength(next.value)
    if (
      ++this.chunks > this.policy.maximumInputChunks ||
      length > this.policy.maximumInputChunkBytes ||
      length > this.policy.maximumArchiveBytes - this.inputBytes
    )
      throw new SnapshotResourceLimitError('BRC-38 JSON input exceeds the selected stream policy')
    const detached = new Uint8Array(length)
    Reflect.apply(copyBytes, detached, [next.value])
    this.inputBytes += length
    this.buffer = this.decoder.decode(detached, { stream: true })
  }
  async skip(): Promise<void> {
    let more = true
    await runInSeries(
      pending(() => more),
      async () => {
        more = whitespace(await this.peek())
        if (more) this.advance()
      }
    )
  }
  async expect(unit: string): Promise<void> {
    await this.skip()
    if ((await this.peek()) !== unit) invalid()
    this.advance()
  }
  close(): Promise<void> {
    this.closing ??= Promise.resolve().then(async () => {
      if (this.iterator.return !== undefined) await this.iterator.return()
    })
    return this.closing
  }
  /** Charge raw buffered/joined/parsed text and every possible parsed node
   * BEFORE JSON.parse. Only this one value can be materialized. */
  async value(maximum: number): Promise<{ value: Value; allocation: number }> {
    await this.skip()
    const first = await this.peek()
    if (first === undefined || ',:]}'.includes(first)) invalid()
    const frame = new ValueFrame(first, maximum)
    let more = true
    await runInSeries(
      pending(() => more),
      async () => {
        if ((await this.peek()) === undefined) {
          more = false
          return
        }
        // Scan only the current decoded chunk and a fixed work allowance.
        // No await/promise allocation per character, and no unbounded CPU run.
        const end = Math.min(this.buffer.length, this.offset + 4096 - this.workUnits)
        while (more && this.offset < end) {
          const unit = this.buffer[this.offset]
          if (frame.delimiter(unit)) {
            more = false
            break
          }
          more = !frame.accept(unit)
          this.advance()
        }
      }
    )
    await this.yieldIfNeeded()
    return frame.finish()
  }
}

class Document {
  readonly fields = new Set<string>()
  readonly tableFields = new Set<string>()
  readonly metadata = new Map<string, Value>()
  readonly empty: BRC38Tables = {
    provenTxs: [],
    provenTxReqs: [],
    outputBaskets: [],
    transactions: [],
    commissions: [],
    outputs: [],
    outputTags: [],
    outputTagMaps: [],
    txLabels: [],
    txLabelMaps: [],
    certificates: [],
    certificateFields: [],
    syncStates: []
  }
  readonly counts = Object.fromEntries(tables.map(table => [table, 0])) as Record<Table, number>
  readonly row: Brc38JsonStagingSink['provisionalRow']
  constructor(
    readonly reader: Input,
    sink: Brc38JsonStagingSink,
    readonly maximumRow: number,
    public remainingMetadata: number
  ) {
    this.row = sink.provisionalRow.bind(sink)
  }
  async metadataValue(): Promise<Value> {
    const result = await this.reader.value(this.remainingMetadata)
    this.remainingMetadata -= result.allocation
    return result.value
  }
  async key(seen: Set<string>): Promise<string> {
    const value = await this.metadataValue()
    if (typeof value !== 'string' || seen.has(value) || seen.size >= 64) invalid()
    seen.add(value)
    await this.reader.expect(':')
    return value
  }
  async separator(end: string): Promise<boolean> {
    await this.reader.skip()
    const separator = await this.reader.peek()
    if (separator === undefined) invalid()
    this.reader.advance()
    if (separator === end) return false
    if (separator !== ',') invalid()
    return true
  }
  async tableRows(table: Table): Promise<void> {
    await this.reader.expect('[')
    await this.reader.skip()
    if ((await this.reader.peek()) === ']') {
      this.reader.advance()
      return
    }
    let more = true
    await runInSeries(
      pending(() => more),
      async () => {
        const result = await this.reader.value(this.maximumRow)
        if (!object(result.value) || this.counts[table] === Number.MAX_SAFE_INTEGER) invalid()
        await this.row(table, this.counts[table], frozen(result.value))
        this.counts[table]++
        more = await this.separator(']')
      }
    )
  }
  async tableObject(): Promise<void> {
    await this.reader.expect('{')
    let more = true
    await runInSeries(
      pending(() => more),
      async () => {
        const name = await this.key(this.tableFields)
        if (isTable(name)) await this.tableRows(name)
        else await this.metadataValue()
        more = await this.separator('}')
      }
    )
    if (!tables.every(table => this.tableFields.has(table))) invalid()
  }
  async read(): Promise<Readonly<BRC38WalletData>> {
    await this.reader.expect('{')
    let more = true
    await runInSeries(
      pending(() => more),
      async () => {
        const name = await this.key(this.fields)
        if (name === 'tables') await this.tableObject()
        else this.metadata.set(name, await this.metadataValue())
        more = await this.separator('}')
      }
    )
    await this.reader.skip()
    if ((await this.reader.peek()) !== undefined || !this.fields.has('tables')) invalid()
    // Only bounded metadata and thirteen empty arrays reach the unchanged
    // legacy header validator. Complete row relationships belong to staging.
    return frozen(parseBRC38Json(JSON.stringify({ ...Object.fromEntries(this.metadata), tables: this.empty })))
  }
}
async function discard(input: Input | undefined, sink: Brc38JsonStagingSink, error: unknown): Promise<never> {
  const failures = [error]
  try {
    await input?.close()
  } catch (error_) {
    if (error_ !== error) failures.push(error_)
  }
  try {
    await sink.discard(error)
  } catch (error_) {
    failures.push(error_)
  }
  if (failures.length > 1)
    throw new AggregateError(failures, 'BRC-38 JSON reading and staging cleanup failed', { cause: error })
  throw error
}

/** Bounded framing into private staging, not durable import activation. Every
 * standard table is required exactly once; rows and input chunks are bounded,
 * one callback is in flight and trailing/truncated/malformed input refuses.
 * The caller supplies already authenticated plaintext or an independently
 * authenticated private quarantine. It must provide real semantic/closure
 * validation and physical staging cleanup before using the result. */
export async function readBrc38JsonStream(
  source: AsyncIterable<Uint8Array>,
  sink: Brc38JsonStagingSink,
  selected: Brc38JsonStreamOptions
): Promise<Brc38JsonStreamResult> {
  let input: Input | undefined
  try {
    const options = Object.freeze({ ...selected })
    const maximumRow = integer(options.maximumRowAllocationBytes, 16777216, 'maximumRowAllocationBytes')
    const remainingMetadata = integer(
      options.maximumMetadataAllocationBytes ?? 65536,
      65536,
      'maximumMetadataAllocationBytes'
    )
    input = new Input(source, {
      maximumArchiveBytes: integer(options.maximumArchiveBytes, Number.MAX_SAFE_INTEGER, 'maximumArchiveBytes'),
      maximumInputChunkBytes: integer(options.maximumInputChunkBytes ?? 65536, 65536, 'maximumInputChunkBytes'),
      maximumInputChunks: integer(options.maximumInputChunks ?? 1000000, Number.MAX_SAFE_INTEGER, 'maximumInputChunks'),
      signal: options.signal
    })
    const reader = input
    const complete = sink.validateCompleted.bind(sink)
    const document = new Document(reader, sink, maximumRow, remainingMetadata)
    const header = await document.read()
    await reader.close()
    options.signal?.throwIfAborted()
    const detachedCounts = Object.freeze({ ...document.counts })
    await complete(header, detachedCounts)
    options.signal?.throwIfAborted()
    return Object.freeze({ header, counts: detachedCounts, inputBytes: reader.inputBytes })
  } catch (error) {
    return discard(input, sink, error)
  }
}
