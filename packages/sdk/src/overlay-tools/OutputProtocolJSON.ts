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
      source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input)
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
    const value = this.#value(1)
    this.#whitespace()
    outputAssert(frame.o === frame.t.length, 'Trailing JSON data')
    // Every value is decoded once into this private, bounded data-property graph.
    // Expose it only after complete syntax, duplicate, Unicode and resource checks.
    return value
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

  #object(depth: number): OutputJSONObject {
    const frame = this.#frame
    frame.o++
    this.#whitespace()
    const fields = new Map<string, OutputJSON>()
    let previous: string | undefined
    if (frame.t[frame.o] === '}') {
      frame.o++
    } else {
      for (;;) {
        this.#whitespace()
        const key = this.#string()
        outputAssert(!fields.has(key), 'Duplicate decoded JSON key')
        outputJSONLimit(fields.size < frame.b.mapKeys, 2)
        frame.e?.key(previous, key)
        previous = key
        this.#whitespace()
        outputAssert(frame.t[frame.o++] === ':', 'Expected JSON colon')
        fields.set(key, this.#value(depth + 1))
        this.#whitespace()
        const end = frame.t[frame.o++]
        if (end === '}') break
        outputAssert(end === ',', 'Expected JSON object separator')
      }
    }
    return ownedOutputJSONRecord(fields)
  }

  #array(depth: number): OutputJSON[] {
    const frame = this.#frame
    frame.o++
    this.#whitespace()
    const values = new Map<number, OutputJSON>()
    if (frame.t[frame.o] === ']') {
      frame.o++
      return Array.from(values.values())
    }
    for (;;) {
      outputJSONLimit(values.size < frame.b.arrayElements, 3)
      values.set(values.size, this.#value(depth + 1))
      this.#whitespace()
      const end = frame.t[frame.o++]
      if (end === ']') return Array.from(values.values())
      outputAssert(end === ',', 'Expected JSON array separator')
    }
  }

  #value(depth: number): OutputJSON {
    const frame = this.#frame
    outputJSONLimit(depth <= frame.b.depth, 1)
    this.#whitespace()
    switch (frame.t[frame.o]) {
      case '"':
        return this.#string()
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
        return result as OutputJSONScalar
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

/** Each invocation owns its complete mutable framing state. Shared functions
 * never expose this private frame or retain an input or validation verdict. */
/** Fixed UTF-16 comparison of primitive names, independent of locale. */
const compareOutputJSONKeys = (a: string, b: string): number => +(a > b) - +(a < b)

interface OutputJSONFrame {
  text: string
  bytes: number
  readonly bounds: OutputJSONLimits
  readonly path: Set<object>
  readonly capture: 0 | 1 | 2
}

function serializeOutputJSON(
  value: unknown,
  bounds: OutputJSONLimits,
  capture: 1 | 2
): { text: string; value: OutputJSON }
function serializeOutputJSON(value: unknown, bounds: OutputJSONLimits, capture?: 0): string
function serializeOutputJSON(
  value: unknown,
  bounds: OutputJSONLimits,
  capture: 0 | 1 | 2 = 0
): string | { text: string; value: OutputJSON } {
  const frame: OutputJSONFrame = {
    text: '',
    path: new Set<object>(),
    bytes: 0,
    bounds,
    capture
  }
  const owned = visitOutputJSON(frame, value, 1)
  return capture ? { text: frame.text, value: owned as OutputJSON } : frame.text
}

function emitOutputJSON(frame: OutputJSONFrame, chunk: string, knownASCII = false): void {
  outputJSONLimit(chunk.length <= frame.bounds.bytes)
  // JSON punctuation and escaped ASCII strings have one byte per code unit.
  // Avoid allocating an encoded array for every delimiter and ASCII field.
  frame.bytes +=
    knownASCII || /^[\u0020-\u007E]*$/.test(chunk) ? chunk.length : encoder.encode(chunk).length
  outputJSONLimit(frame.bytes <= frame.bounds.bytes)
  if (frame.capture !== 2) frame.text += chunk
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

function visitOutputJSONArray(
  frame: OutputJSONFrame,
  node: unknown[],
  depth: number
): OutputJSON[] | undefined {
  outputJSONLimit(node.length <= frame.bounds.arrayElements, 3)
  outputAssert(
    Object.getOwnPropertyNames(node).length === node.length + 1 &&
      Object.keys(node).length === node.length,
    'Sparse or decorated JSON array'
  )
  const owned = frame.capture ? new Map<number, OutputJSON>() : undefined
  emitOutputJSON(frame, '[', true)
  for (let i = 0; i < node.length; i++) {
    if (i > 0) emitOutputJSON(frame, ',', true)
    const descriptor = Object.getOwnPropertyDescriptor(node, i)
    outputAssert(descriptor?.enumerable && 'value' in descriptor, 'JSON array accessor or hole')
    const child = visitOutputJSON(frame, descriptor.value, depth + 1)
    if (owned) owned.set(i, child as OutputJSON)
  }
  emitOutputJSON(frame, ']', true)
  return owned ? Array.from(owned.values()) : undefined
}

function visitOutputJSONObject(
  frame: OutputJSONFrame,
  node: object,
  depth: number
): OutputJSONObject | undefined {
  outputAssert(isOutputPlainObject(node), 'Expected plain JSON object')
  // RFC 8785 orders primitive property-name strings by UTF-16 code units.
  const keys = Object.getOwnPropertyNames(node)
  // The fresh primitive names use one fixed locale-independent comparator.
  keys.sort(compareOutputJSONKeys)
  outputJSONLimit(keys.length <= frame.bounds.mapKeys, 2)
  const owned = frame.capture ? new Map<string, OutputJSON>() : undefined
  emitOutputJSON(frame, '{', true)
  let index = 0
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(node, key)
    outputAssert(descriptor?.enumerable && 'value' in descriptor, 'JSON accessor or hidden key')
    if (index++ > 0) emitOutputJSON(frame, ',', true)
    // The colon is the next byte before visiting the value. One emission
    // retains the same byte-limit refusal before any value validation.
    emitOutputJSONString(frame, key, ':')
    const child = visitOutputJSON(frame, descriptor.value, depth + 1)
    if (owned) owned.set(key, child as OutputJSON)
  }
  emitOutputJSON(frame, '}', true)
  return owned ? ownedOutputJSONRecord(owned) : undefined
}

function visitOutputJSON(
  frame: OutputJSONFrame,
  node: unknown,
  depth: number
): OutputJSON | undefined {
  outputJSONLimit(depth <= frame.bounds.depth, 1)
  const number = typeof node === 'number'
  if (node === null || typeof node === 'boolean' || number) {
    outputAssert(!number || Number.isSafeInteger(node), 'Protocol numbers must be safe integers')
    // Safe integers never use exponent notation here; both encoders map -0 to 0.
    emitOutputJSON(frame, String(node), true)
    return number && node === 0 ? 0 : (node as OutputJSONScalar)
  } else if (typeof node === 'string') {
    emitOutputJSONString(frame, node)
    return node
  } else {
    // The preceding scalar branch has already handled null.
    outputAssert(typeof node === 'object', 'Expected a JSON value')
    outputAssert(!frame.path.has(node), 'Cyclic JSON value')
    outputAssert(Object.getOwnPropertySymbols(node).length === 0, 'Symbol JSON key')
    frame.path.add(node)
    const owned = Array.isArray(node)
      ? visitOutputJSONArray(frame, node, depth)
      : visitOutputJSONObject(frame, node, depth)
    frame.path.delete(node)
    return owned
  }
}

/** Copy staged own data into a record whose prototype is null from creation. */
function ownedOutputJSONRecord(fields: Map<string, OutputJSON>): OutputJSONObject {
  return { __proto__: null, ...Object.fromEntries(fields) } as OutputJSONObject
}

/**
 * Validate and capture bounded canonical text and an independent data-only graph.
 * Every representation/resource check runs before its privately captured child
 * is retained. Fresh null-prototype records and ordinary array data properties
 * preserve ownership without reparsing the generated text or retaining verdicts.
 * Incoming text/bytes still require parseOutputJSON to retain duplicate evidence.
 */
export function ownOutputJSON(
  input: unknown,
  limits: Partial<OutputJSONLimits> = OUTPUT_JSON_LIMITS
): { text: string; value: OutputJSON } {
  return serializeOutputJSON(input, limitsFor(limits), 1)
}

/** @internal Same fresh ownership and complete canonical byte fences, without
 * retaining text that the schema layer would immediately discard. */
export function ownOutputJSONValue(
  input: unknown,
  limits: Partial<OutputJSONLimits> = OUTPUT_JSON_LIMITS
): OutputJSON {
  return serializeOutputJSON(input, limitsFor(limits), 2).value
}
