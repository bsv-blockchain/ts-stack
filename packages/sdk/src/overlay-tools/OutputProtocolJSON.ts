import { outputAssert, OutputProtocolError } from './OutputProtocolError.js'

export type OutputJSON = null | boolean | number | string | OutputJSON[] | OutputJSONObject
export interface OutputJSONObject {
  [key: string]: OutputJSON
}

/** Limits may be narrowed by a caller, never widened beyond BRC-192 section 9. */
export interface OutputJSONLimits {
  bytes: number
  depth: number
  arrayElements: number
  mapKeys: number
}

export const OUTPUT_JSON_LIMITS: Readonly<OutputJSONLimits> = Object.freeze({
  bytes: 4 * 1024 * 1024,
  depth: 32,
  arrayElements: 4096,
  mapKeys: 256
})

const encoder = new TextEncoder()
// Fixed decoding options only. Non-streaming calls reset the decoder state
// for every complete input, including after malformed UTF-8.
let utf8Decoder: TextDecoder | undefined

const resourceMessages = Object.freeze([
  'Output JSON byte limit',
  'JSON depth limit',
  'JSON map limit',
  'JSON array limit'
] as const)
/** Fixed refusal identities only; every caller evaluates its own fresh bound. */
function outputJSONLimit(condition: boolean, resource: 0 | 1 | 2 | 3 = 0): asserts condition {
  if (!condition) throw new OutputProtocolError('limited', resourceMessages[resource])
}

/** Accept plain records from other realms as well as null-prototype records. */
export function isOutputPlainObject(value: object): boolean {
  const prototype: object | null = Object.getPrototypeOf(value) as object | null
  return prototype === null || Object.getPrototypeOf(prototype) === null
}

function limitsFor(limits: Partial<OutputJSONLimits>): OutputJSONLimits {
  // The default is already immutable and validated by its fixed declaration.
  // Capture and validate every supplied override once; immutable omitted
  // defaults do not need to be revalidated for every record.
  if (limits === OUTPUT_JSON_LIMITS) return OUTPUT_JSON_LIMITS
  const result = { ...limits }
  for (const key of Object.keys(result) as (keyof OutputJSONLimits)[]) {
    const value = result[key] ?? 0
    outputAssert(
      Object.hasOwn(OUTPUT_JSON_LIMITS, key) &&
        Number.isSafeInteger(value) &&
        value > 0 &&
        value <= OUTPUT_JSON_LIMITS[key],
      'Invalid output JSON resource limit'
    )
  }
  return { ...OUTPUT_JSON_LIMITS, ...result }
}

/** @internal Fresh Unicode check shared by bounded strings and JSON framing. */
function wellFormed(value: string): void {
  // In Unicode mode a valid pair is one code point outside this range. Only
  // lone UTF-16 surrogates match; reject them before TextEncoder replaces them.
  outputAssert(!/[\uD800-\uDFFF]/u.test(value), 'Unpaired JSON surrogate')
}

export { wellFormed as assertOutputJSONUnicode }

/** Exact fresh UTF-8 length; ASCII code units each occupy one byte. */
function outputJSONUTF8Length(value: string): number {
  return /[\u0080-\uFFFF]/.test(value) ? encoder.encode(value).length : value.length
}

/**
 * Parse bounded protocol JSON while retaining duplicate decoded keys long enough
 * to reject them. JSON.parse alone loses that evidence. This does not validate a
 * packet schema; callers must also validate its recursively closed structures.
 */
export function parseOutputJSON(
  input: Uint8Array | string,
  limits: Partial<OutputJSONLimits> = OUTPUT_JSON_LIMITS
): OutputJSON {
  const [source, bounds] = outputJSONSource(input, limits)
  return new OutputJSONParser(source, bounds).parse()
}

/** Fresh structural encoding inspection, never a schema or authority verdict.
 * Both original UTF-8 and its canonical encoding must fit the selected limits.
 * The flag describes this input text, not later mutations of the owned value. */
export function inspectOutputJSONEncoding(
  input: Uint8Array | string,
  limits: Partial<OutputJSONLimits> = OUTPUT_JSON_LIMITS
): { value: OutputJSON; canonical: boolean } {
  const [source, bounds, bytes] = outputJSONSource(input, limits),
    // Count the decoded UTF-8 for byte inputs independently of overridable
    // byteLength properties, matching serialization of the parsed value.
    originalBytes = typeof input === 'string' ? bytes : outputJSONUTF8Length(source),
    encoding = new OutputJSONEncodingInspection(originalBytes),
    value = new OutputJSONParser(source, bounds, encoding).parse()
  // Parse every syntax/Unicode/duplicate/depth/item boundary first, as before.
  outputJSONLimit(originalBytes <= bounds.bytes && encoding.bytes <= bounds.bytes)
  return { value, canonical: encoding.canonical }
}

function outputJSONSource(
  input: Uint8Array | string,
  limits: Partial<OutputJSONLimits>
): [source: string, bounds: OutputJSONLimits, bytes: number] {
  const bounds = limitsFor(limits)
  let source: string, bytes: number
  if (typeof input === 'string') {
    outputJSONLimit(input.length <= bounds.bytes)
    wellFormed(input)
    bytes = outputJSONUTF8Length(input)
    outputJSONLimit(bytes <= bounds.bytes)
    source = input
  } else {
    outputAssert(input instanceof Uint8Array, 'Expected UTF-8 bytes')
    bytes = input.byteLength
    outputJSONLimit(bytes <= bounds.bytes)
    try {
      utf8Decoder ??= new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      source = utf8Decoder.decode(input)
    } catch {
      throw new OutputProtocolError('invalid', 'Malformed UTF-8')
    }
  }
  outputAssert(source.codePointAt(0) !== 0xfeff, 'JSON BOM is not permitted')
  return [source, bounds, bytes]
}

/** Internal optional observer; ordinary parser consumers do not retain the
 * inspection implementation in their bundles. Each inspection owns its state. */
type OutputJSONScalar = null | boolean | number

interface OutputJSONEncodingObserver {
  whitespace(): void
  string(source: string, decoded: string): void
  value(source: string, value: OutputJSONScalar): void
  key(previous: string | undefined, key: string): void
}

class OutputJSONEncodingInspection implements OutputJSONEncodingObserver {
  canonical = true

  constructor(public bytes: number) {}

  whitespace(): void {
    this.canonical = false
    this.bytes--
  }

  string(source: string, decoded: string): void {
    if (!source.includes('\\')) return
    const canonical = JSON.stringify(decoded)
    this.canonical &&= canonical === source
    this.bytes += encoder.encode(canonical).length - encoder.encode(source).length
  }

  value(source: string, value: OutputJSONScalar): void {
    if (typeof value !== 'number') return
    const canonical = String(value)
    this.canonical &&= canonical === source
    this.bytes += canonical.length - source.length
  }

  key(previous: string | undefined, key: string): void {
    this.canonical &&= previous === undefined || previous < key
  }
}

class OutputJSONParser {
  readonly #frame: {
    o: number
    readonly t: string
    readonly b: OutputJSONLimits
    readonly e?: OutputJSONEncodingObserver
  }

  constructor(text: string, bounds: OutputJSONLimits, encoding?: OutputJSONEncodingObserver) {
    this.#frame = { o: 0, t: text, b: bounds, e: encoding }
  }

  parse(): OutputJSON {
    const frame = this.#frame
    this.#value(1)
    this.#whitespace()
    outputAssert(frame.o === frame.t.length, 'Trailing JSON data')
    // Duplicate decoded names and every syntax/resource boundary are checked
    // before native construction of an independent, data-only graph.
    return ownValidatedOutputJSON(frame.t)
  }

  #whitespace(): void {
    const frame = this.#frame
    while (' \r\n\t'.includes(frame.t[frame.o] ?? '\0')) {
      frame.o++
      frame.e?.whitespace()
    }
  }

  #string(): string {
    const frame = this.#frame
    outputAssert(frame.t[frame.o] === '"', 'Expected JSON string')
    const start = frame.o++
    // Each quote search advances. Backslash runs preceding candidate quotes
    // cannot overlap, so even malformed tokens require only linear work.
    // Native decoding still validates all escapes and raw controls.
    let end = start
    while ((end = frame.t.indexOf('"', end + 1)) >= 0) {
      let backslashStart = end
      while (backslashStart > start && frame.t[backslashStart - 1] === '\\') backslashStart--
      if ((end - backslashStart) % 2 === 0) break
    }
    frame.o = end < 0 ? frame.t.length : end + 1
    outputAssert(end >= 0, 'Unterminated JSON string')
    const encoded = frame.t.slice(start, frame.o)
    // Fresh text validation already proves unescaped Unicode well-formed;
    // ASCII quote boundaries cannot split a pair. Only decoding escapes can
    // introduce a lone surrogate or change canonical string representation.
    if (!/[^\u0020-\u005B\u005D-\uFFFF]/.test(encoded)) return encoded.slice(1, -1)
    let decoded: string
    try {
      decoded = JSON.parse(encoded) as string
    } catch {
      throw new OutputProtocolError('invalid', 'Malformed JSON string')
    }
    wellFormed(decoded)
    frame.e?.string(encoded, decoded)
    return decoded
  }

  #object(depth: number): void {
    const frame = this.#frame
    frame.o++
    this.#whitespace()
    const keys = new Set<string>()
    let previous: string | undefined
    if (frame.t[frame.o] === '}') {
      frame.o++
    } else {
      for (;;) {
        this.#whitespace()
        const key = this.#string()
        outputAssert(!keys.has(key), 'Duplicate decoded JSON key')
        outputJSONLimit(keys.size < frame.b.mapKeys, 2)
        frame.e?.key(previous, key)
        previous = key
        this.#whitespace()
        outputAssert(frame.t[frame.o++] === ':', 'Expected JSON colon')
        this.#value(depth + 1)
        keys.add(key)
        this.#whitespace()
        const end = frame.t[frame.o++]
        if (end === '}') break
        outputAssert(end === ',', 'Expected JSON object separator')
      }
    }
  }

  #array(depth: number): void {
    const frame = this.#frame
    frame.o++
    this.#whitespace()
    let size = 0
    if (frame.t[frame.o] === ']') {
      frame.o++
      return
    }
    for (;;) {
      outputJSONLimit(size < frame.b.arrayElements, 3)
      this.#value(depth + 1)
      size++
      this.#whitespace()
      const end = frame.t[frame.o++]
      if (end === ']') return
      outputAssert(end === ',', 'Expected JSON array separator')
    }
  }

  #value(depth: number): void {
    const frame = this.#frame
    outputJSONLimit(depth <= frame.b.depth, 1)
    this.#whitespace()
    switch (frame.t[frame.o]) {
      case '"':
        this.#string()
        return
      case '{':
        return this.#object(depth)
      case '[':
        return this.#array(depth)
      default: {
        const rest = frame.t.slice(frame.o)
        const token =
          /^(?:true|false|null)/.exec(rest)?.[0] ??
          /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest)?.[0]
        outputAssert(token !== undefined, 'Invalid JSON token')
        frame.o += token.length
        const result: unknown = JSON.parse(token)
        outputAssert(
          typeof result !== 'number' || Number.isSafeInteger(result),
          'Protocol numbers must be safe integers'
        )
        frame.e?.value(token, result as OutputJSONScalar)
        return
      }
    }
  }
}

/** RFC 8785 serialization with the additional BRC-192 integer and size rules. */
export function canonicalOutputJSON(
  value: unknown,
  limits: Partial<OutputJSONLimits> = OUTPUT_JSON_LIMITS
): string {
  return serializeOutputJSON(value, limitsFor(limits))
}

/** Fixed UTF-16 comparison of primitive names, independent of locale. */
const compareOutputJSONKeys = (a: string, b: string): number => +(a > b) - +(a < b)

/** Each invocation owns its complete mutable framing state. Shared functions
 * never expose this private frame or retain an input or validation verdict. */
interface OutputJSONFrame {
  text: string
  bytes: number
  readonly bounds: OutputJSONLimits
  readonly path: Set<object>
}

function serializeOutputJSON(value: unknown, bounds: OutputJSONLimits): string {
  const frame: OutputJSONFrame = { text: '', path: new Set<object>(), bytes: 0, bounds }
  visitOutputJSON(frame, value, 1)
  return frame.text
}

function emitOutputJSON(frame: OutputJSONFrame, chunk: string, knownASCII = false): void {
  outputJSONLimit(chunk.length <= frame.bounds.bytes)
  // JSON punctuation and escaped ASCII strings have one byte per code unit.
  // Avoid allocating an encoded array for every delimiter and ASCII field.
  frame.bytes +=
    knownASCII || /^[\u0020-\u007E]*$/.test(chunk) ? chunk.length : encoder.encode(chunk).length
  outputJSONLimit(frame.bytes <= frame.bounds.bytes)
  frame.text += chunk
}

function emitOutputJSONString(frame: OutputJSONFrame, text: string, suffix = ''): void {
  outputJSONLimit(text.length <= frame.bounds.bytes)
  // Valid unescaped ASCII has identical JSON and UTF-8 code-unit lengths.
  // Escaped/control/Unicode strings retain native escaping and byte counting.
  if (!/[^\u0020-\u0021\u0023-\u005B\u005D-\u007E]/.test(text)) {
    emitOutputJSON(frame, '"' + text + '"' + suffix, true)
  } else {
    wellFormed(text)
    emitOutputJSON(frame, JSON.stringify(text) + suffix)
  }
}

function visitOutputJSONArray(frame: OutputJSONFrame, node: unknown[], depth: number): void {
  outputJSONLimit(node.length <= frame.bounds.arrayElements, 3)
  outputAssert(
    Object.getOwnPropertyNames(node).length === node.length + 1 &&
      Object.keys(node).length === node.length,
    'Sparse or decorated JSON array'
  )
  emitOutputJSON(frame, '[', true)
  for (let i = 0; i < node.length; i++) {
    if (i > 0) emitOutputJSON(frame, ',', true)
    const descriptor = Object.getOwnPropertyDescriptor(node, i)
    outputAssert(descriptor?.enumerable && 'value' in descriptor, 'JSON array accessor or hole')
    visitOutputJSON(frame, descriptor.value, depth + 1)
  }
  emitOutputJSON(frame, ']', true)
}

function visitOutputJSONObject(frame: OutputJSONFrame, node: object, depth: number): void {
  outputAssert(isOutputPlainObject(node), 'Expected plain JSON object')
  // RFC 8785 orders primitive property-name strings by UTF-16 code units.
  const keys = Object.getOwnPropertyNames(node)
  // The fresh primitive names use one fixed locale-independent comparator.
  keys.sort(compareOutputJSONKeys)
  outputJSONLimit(keys.length <= frame.bounds.mapKeys, 2)
  emitOutputJSON(frame, '{', true)
  let index = 0
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(node, key)
    outputAssert(descriptor?.enumerable && 'value' in descriptor, 'JSON accessor or hidden key')
    if (index++ > 0) emitOutputJSON(frame, ',', true)
    // The colon is the next byte before visiting the value. One emission
    // retains the same byte-limit refusal before any value validation.
    emitOutputJSONString(frame, key, ':')
    visitOutputJSON(frame, descriptor.value, depth + 1)
  }
  emitOutputJSON(frame, '}', true)
}

function visitOutputJSON(frame: OutputJSONFrame, node: unknown, depth: number): void {
  outputJSONLimit(depth <= frame.bounds.depth, 1)
  const number = typeof node === 'number'
  if (node === null || typeof node === 'boolean' || number) {
    outputAssert(!number || Number.isSafeInteger(node), 'Protocol numbers must be safe integers')
    // Safe integers never use exponent notation here; both encoders map -0 to 0.
    emitOutputJSON(frame, String(node), true)
  } else if (typeof node === 'string') {
    emitOutputJSONString(frame, node)
  } else {
    // The preceding scalar branch has already handled null.
    outputAssert(typeof node === 'object', 'Expected a JSON value')
    outputAssert(!frame.path.has(node), 'Cyclic JSON value')
    outputAssert(Object.getOwnPropertySymbols(node).length === 0, 'Symbol JSON key')
    frame.path.add(node)
    if (Array.isArray(node)) visitOutputJSONArray(frame, node, depth)
    else visitOutputJSONObject(frame, node, depth)
    frame.path.delete(node)
  }
}

/** Select null prototypes only on this invocation's newly parsed data graph.
 * Complete lexical/serializer checks precede native construction. Its unexposed
 * arrays are dense and records contain only own data. Direct arrays and newly
 * null-prototype records exclude inherited values. Native own-record enumeration
 * stays inside this unexposed, completely validated graph.
 * No caller object, input verdict or private record is retained here.
 */
function ownOutputJSONRecordPrototypes(value: OutputJSON): OutputJSON {
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child !== null && typeof child === 'object') ownOutputJSONRecordPrototypes(child)
      }
    } else {
      Object.setPrototypeOf(value, null)
      ownOutputJSONRecordFields(value)
    }
  }
  return value
}

/** Only freshly constructed records whose prototype is already null enter here.
 * Native enumeration reads ordinary own data from this private bounded graph. */
function ownOutputJSONRecordFields(value: OutputJSONObject): void {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === 'object') ownOutputJSONRecordPrototypes(child)
  }
}

/** Construct an independent graph only from text just fully validated here.
 * Native parsing creates ordinary own data, including builtin-looking names.
 * Incoming text reaches this path only after complete lexical validation,
 * including duplicate decoded names. Caller objects are serialized first.
 */
function ownValidatedOutputJSON(text: string): OutputJSON {
  return ownOutputJSONRecordPrototypes(JSON.parse(text) as OutputJSON)
}

/**
 * Validate bounded canonical text, then construct an independent data-only graph.
 * Every representation and resource check completes before graph construction.
 * Records have null prototypes; arrays and records have ordinary own data fields.
 * Incoming text/bytes still require parseOutputJSON to retain duplicate evidence.
 */
export function ownOutputJSON(
  input: unknown,
  limits: Partial<OutputJSONLimits> = OUTPUT_JSON_LIMITS
): { text: string; value: OutputJSON } {
  const text = serializeOutputJSON(input, limitsFor(limits))
  return { text, value: ownValidatedOutputJSON(text) }
}

/** @internal Same fresh ownership and complete canonical byte fences. */
export function ownOutputJSONValue(
  input: unknown,
  limits: Partial<OutputJSONLimits> = OUTPUT_JSON_LIMITS
): OutputJSON {
  return ownValidatedOutputJSON(serializeOutputJSON(input, limitsFor(limits)))
}

// Fixed syntax grammar only. Every invocation rechecks its own bounded text.
// Source validation already proves Unicode; syntax excludes controls, quotes and escapes.
const flatOutputJSONStringRecord =
  /^\{(?:"[^"\\]*":"[^"\\]*"(?:,"[^"\\]*":"[^"\\]*")*)?\}(?![\s\S])/

/** A complete fresh lexical proof for one flat string record. All other shapes,
 * escaped text and refusals retain the original parser/error order.
 * Decoded names equal these fresh unescaped names. Check them before native
 * construction; no supplied value, shape, ownership or verdict is retained.
 */
function ownFlatOutputJSONStringRecord(
  source: string,
  bounds: OutputJSONLimits
): OutputJSONObject | undefined {
  if (/[^\u0020-\uFFFF]/.test(source) || !flatOutputJSONStringRecord.test(source)) return undefined
  const names = new Set<string>()
  let position = 2
  // The complete grammar proves unescaped quoted key/value pairs. Follow their
  // quote boundaries; punctuation inside a string cannot become a separator.
  while (position < source.length - 1) {
    const nameEnd = source.indexOf('"', position),
      name = source.slice(position, nameEnd)
    if (names.has(name) || names.size >= bounds.mapKeys) return undefined
    names.add(name)
    position = source.indexOf('"', nameEnd + 3) + 3
  }
  if (names.size !== 0 && bounds.depth < 2) return undefined
  // Source byte/Unicode/BOM limits have already passed. Root depth is one;
  // nonempty string fields have depth two, and there are no arrays or children.
  return ownValidatedOutputJSON(source) as OutputJSONObject
}

/** Opt-in string-record path with the same complete parsing and ownership contract.
 * Other shapes and refusals retain parseOutputJSON's original parser/error order.
 * Ordinary parseOutputJSON and browser consumers do not select this path.
 */
export function parseOutputJSONWithStringRecords(
  input: Uint8Array | string,
  limits: Partial<OutputJSONLimits> = OUTPUT_JSON_LIMITS
): OutputJSON {
  const [source, bounds] = outputJSONSource(input, limits)
  const flat = ownFlatOutputJSONStringRecord(source, bounds)
  return flat ?? new OutputJSONParser(source, bounds).parse()
}

// Fixed member grammar only; a fresh sticky cursor proves every member and
// separator. No duplicate whole-record pattern or retained matching state.
const flatOutputJSONScalarMember = /"[^"\\]*":(?:"[^"\\]*"|-?\d+|true|false|null)(?=[,}])/
const canonicalOutputJSONIntegerToken = /^(?:0|-?[1-9]\d*)$/

function safeOutputJSONScalarToken(token: string): boolean {
  return (
    token.startsWith('"') ||
    token === 'true' ||
    token === 'false' ||
    token === 'null' ||
    (canonicalOutputJSONIntegerToken.test(token) && Number.isSafeInteger(JSON.parse(token)))
  )
}

function outputJSONScalarNextPosition(source: string, end: number): number | undefined {
  const next = end + 1
  if (next === source.length) return end
  if (source[end] === ',' && next < source.length - 1) return next
  return undefined
}

function inspectFlatOutputJSONScalarRecord(
  source: string,
  bounds: OutputJSONLimits
): { value: OutputJSON; canonical: boolean } | undefined {
  if (/[^\u0020-\uFFFF]/.test(source) || !source.startsWith('{') || source.at(-1) !== '}')
    return undefined
  const members = new RegExp(flatOutputJSONScalarMember.source, 'y'),
    names = new Set<string>()
  let position = 1,
    previous: string | undefined,
    canonical = true
  while (position < source.length - 1) {
    members.lastIndex = position
    const member = members.exec(source)
    if (member === null) return undefined
    const nameEnd = source.indexOf('"', position + 1),
      name = source.slice(position + 1, nameEnd),
      valueStart = nameEnd + 2,
      valueEnd = position + member[0].length
    if (names.has(name) || names.size >= bounds.mapKeys) return undefined
    names.add(name)
    canonical &&= previous === undefined || previous < name
    previous = name
    if (!safeOutputJSONScalarToken(source.slice(valueStart, valueEnd))) return undefined
    const next = outputJSONScalarNextPosition(source, valueEnd)
    if (next === undefined) return undefined
    position = next
  }
  if (names.size !== 0 && bounds.depth < 2) return undefined
  // Only exact safe decimal integers and unescaped scalar strings reach here.
  // Full framing and key order have been proved; reordering preserves byte size.
  return { value: ownValidatedOutputJSON(source), canonical }
}

/** Explicit flat-scalar inspection with the original complete ownership contract.
 * The ordinary inspector remains unchanged. Unsupported shapes and all refusals
 * use its original lexical observer with the already captured source/bounds,
 * preserving one observation of caller limits and byteLength. No input or verdict
 * is cached; canonical describes only this fresh input, never its later mutation.
 */
export function inspectOutputJSONEncodingWithScalarRecords(
  input: Uint8Array | string,
  limits: Partial<OutputJSONLimits> = OUTPUT_JSON_LIMITS
): { value: OutputJSON; canonical: boolean } {
  const [source, bounds, bytes] = outputJSONSource(input, limits),
    originalBytes = typeof input === 'string' ? bytes : outputJSONUTF8Length(source),
    flat = inspectFlatOutputJSONScalarRecord(source, bounds)
  if (flat) {
    outputJSONLimit(originalBytes <= bounds.bytes)
    return flat
  }
  const encoding = new OutputJSONEncodingInspection(originalBytes),
    value = new OutputJSONParser(source, bounds, encoding).parse()
  outputJSONLimit(originalBytes <= bounds.bytes && encoding.bytes <= bounds.bytes)
  return { value, canonical: encoding.canonical }
}

/** The same fresh traversal/refusal order, with ASCII string fields emitted
 * directly. Reflection captures each descriptor exactly once; this frame never
 * retains a caller record, normalized shape or authority decision between calls. */
function visitOutputJSONInlineRecord(frame: OutputJSONFrame, node: unknown, depth: number): void {
  if (node === null || typeof node !== 'object') {
    visitOutputJSON(frame, node, depth)
    return
  }
  outputJSONLimit(depth <= frame.bounds.depth, 1)
  outputAssert(!frame.path.has(node), 'Cyclic JSON value')
  outputAssert(Object.getOwnPropertySymbols(node).length === 0, 'Symbol JSON key')
  frame.path.add(node)
  if (Array.isArray(node)) {
    visitOutputJSONArray(frame, node, depth)
    frame.path.delete(node)
    return
  }
  outputAssert(isOutputPlainObject(node), 'Expected plain JSON object')
  const keys = Object.getOwnPropertyNames(node).sort(compareOutputJSONKeys)
  outputJSONLimit(keys.length <= frame.bounds.mapKeys, 2)
  emitOutputJSON(frame, '{', true)
  let index = 0
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(node, key)
    outputAssert(descriptor?.enumerable && 'value' in descriptor, 'JSON accessor or hidden key')
    if (index++ > 0) emitOutputJSON(frame, ',', true)
    emitOutputJSONString(frame, key, ':')
    const value: unknown = descriptor.value
    if (typeof value === 'string') {
      outputJSONLimit(depth + 1 <= frame.bounds.depth, 1)
      outputJSONLimit(value.length <= frame.bounds.bytes)
      if (!/[^\u0020-\u0021\u0023-\u005B\u005D-\u007E]/.test(value)) {
        const size = value.length + 2
        outputJSONLimit(size <= frame.bounds.bytes)
        frame.bytes += size
        outputJSONLimit(frame.bytes <= frame.bounds.bytes)
        frame.text += '"' + value + '"'
      } else emitOutputJSONString(frame, value)
    } else visitOutputJSONInlineRecord(frame, value, depth + 1)
  }
  emitOutputJSON(frame, '}', true)
  frame.path.delete(node)
}

/** Explicit serialization with inlined ASCII string-field emission. All values,
 * descriptors, Unicode, cycles and limits are freshly checked in the original
 * traversal order. Arrays and other scalar shapes retain the original visitor.
 * The ordinary canonicalOutputJSON entry and its browser graph are unchanged. */
export function canonicalOutputJSONWithInlineStrings(
  input: unknown,
  limits: Partial<OutputJSONLimits> = OUTPUT_JSON_LIMITS
): string {
  const frame: OutputJSONFrame = {
    text: '',
    path: new Set<object>(),
    bytes: 0,
    bounds: limitsFor(limits)
  }
  visitOutputJSONInlineRecord(frame, input, 1)
  return frame.text
}

/** Fresh private graph assembly alongside canonical emission. Descriptor
 * observations and refusals retain the original order; no partial graph escapes
 * if any later representation or resource check fails. */
function visitOwnedOutputJSONInlineRecord(
  frame: OutputJSONFrame,
  node: unknown,
  depth: number
): OutputJSON {
  if (node === null || typeof node !== 'object') {
    visitOutputJSON(frame, node, depth)
    // Ordinary ownership also normalizes negative zero through JSON parsing.
    return typeof node === 'number' && node === 0 ? 0 : (node as OutputJSON)
  }
  outputJSONLimit(depth <= frame.bounds.depth, 1)
  outputAssert(!frame.path.has(node), 'Cyclic JSON value')
  outputAssert(Object.getOwnPropertySymbols(node).length === 0, 'Symbol JSON key')
  frame.path.add(node)
  const owned = Array.isArray(node)
    ? ownOutputJSONInlineArray(frame, node, depth)
    : ownOutputJSONInlineObject(frame, node, depth)
  frame.path.delete(node)
  return owned
}

function ownOutputJSONInlineArray(
  frame: OutputJSONFrame,
  node: unknown[],
  depth: number
): OutputJSON[] {
  outputJSONLimit(node.length <= frame.bounds.arrayElements, 3)
  outputAssert(
    Object.getOwnPropertyNames(node).length === node.length + 1 &&
      Object.keys(node).length === node.length,
    'Sparse or decorated JSON array'
  )
  const owned: OutputJSON[] = []
  emitOutputJSON(frame, '[', true)
  for (let i = 0; i < node.length; i++) {
    if (i > 0) emitOutputJSON(frame, ',', true)
    const descriptor = Object.getOwnPropertyDescriptor(node, i)
    outputAssert(descriptor?.enumerable && 'value' in descriptor, 'JSON array accessor or hole')
    // Define ordinary own data without consulting an inherited array setter.
    Object.defineProperty(owned, i, {
      value: visitOwnedOutputJSONInlineRecord(frame, descriptor.value, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true
    })
  }
  emitOutputJSON(frame, ']', true)
  return owned
}

function ownOutputJSONInlineObject(
  frame: OutputJSONFrame,
  node: object,
  depth: number
): OutputJSONObject {
  outputAssert(isOutputPlainObject(node), 'Expected plain JSON object')
  const keys = Object.getOwnPropertyNames(node).sort(compareOutputJSONKeys)
  outputJSONLimit(keys.length <= frame.bounds.mapKeys, 2)
  const owned = Object.create(null) as OutputJSONObject
  emitOutputJSON(frame, '{', true)
  let index = 0
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(node, key)
    outputAssert(descriptor?.enumerable && 'value' in descriptor, 'JSON accessor or hidden key')
    if (index++ > 0) emitOutputJSON(frame, ',', true)
    emitOutputJSONString(frame, key, ':')
    const value: unknown = descriptor.value
    if (typeof value === 'string') {
      outputJSONLimit(depth + 1 <= frame.bounds.depth, 1)
      outputJSONLimit(value.length <= frame.bounds.bytes)
      if (!/[^\u0020-\u0021\u0023-\u005B\u005D-\u007E]/.test(value)) {
        const size = value.length + 2
        outputJSONLimit(size <= frame.bounds.bytes)
        frame.bytes += size
        outputJSONLimit(frame.bytes <= frame.bounds.bytes)
        frame.text += '"' + value + '"'
      } else emitOutputJSONString(frame, value)
      owned[key] = value
    } else owned[key] = visitOwnedOutputJSONInlineRecord(frame, value, depth + 1)
  }
  emitOutputJSON(frame, '}', true)
  return owned
}

/** Explicit native ownership companion. Each call independently validates and
 * emits its complete input while assembling a fresh private null-prototype graph.
 * Both results are returned only after every check succeeds. It retains no caller
 * value, normalized graph, shape or authority verdict between calls. */
export function ownOutputJSONWithInlineStrings(
  input: unknown,
  limits: Partial<OutputJSONLimits> = OUTPUT_JSON_LIMITS
): { text: string; value: OutputJSON } {
  const frame: OutputJSONFrame = {
    text: '',
    path: new Set<object>(),
    bytes: 0,
    bounds: limitsFor(limits)
  }
  const value = visitOwnedOutputJSONInlineRecord(frame, input, 1)
  return { text: frame.text, value }
}
