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

function wellFormed(value: string): void {
  // In Unicode mode a valid pair is one code point outside this range. Only
  // lone UTF-16 surrogates match; reject them before TextEncoder replaces them.
  outputAssert(!/[\uD800-\uDFFF]/u.test(value), 'Unpaired JSON surrogate')
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
    originalBytes = typeof input === 'string' ? bytes : encoder.encode(source).length,
    encoding = new OutputJSONEncodingInspection(originalBytes),
    value = new OutputJSONParser(source, bounds, encoding).parse()
  // Parse every syntax/Unicode/duplicate/depth/item boundary first, as before.
  outputAssert(
    originalBytes <= bounds.bytes && encoding.bytes <= bounds.bytes,
    'Output JSON byte limit',
    'limited'
  )
  return { value, canonical: encoding.canonical }
}

function outputJSONSource(
  input: Uint8Array | string,
  limits: Partial<OutputJSONLimits>
): [source: string, bounds: OutputJSONLimits, bytes: number] {
  const bounds = limitsFor(limits)
  let source: string, bytes: number
  if (typeof input === 'string') {
    outputAssert(input.length <= bounds.bytes, 'Output JSON byte limit', 'limited')
    wellFormed(input)
    bytes = encoder.encode(input).length
    outputAssert(bytes <= bounds.bytes, 'Output JSON byte limit', 'limited')
    source = input
  } else {
    outputAssert(input instanceof Uint8Array, 'Expected UTF-8 bytes')
    bytes = input.byteLength
    outputAssert(bytes <= bounds.bytes, 'Output JSON byte limit', 'limited')
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
    const canonical = JSON.stringify(value)
    this.canonical &&= canonical === source
    this.bytes += canonical.length - source.length
  }

  key(previous: string | undefined, key: string): void {
    this.canonical &&= previous === undefined || previous < key
  }
}

class OutputJSONParser {
  private offset = 0

  constructor(
    private readonly source: string,
    private readonly bounds: OutputJSONLimits,
    private readonly encoding?: OutputJSONEncodingObserver
  ) {}

  parse(): OutputJSON {
    const result = this.value(1)
    this.whitespace()
    outputAssert(this.offset === this.source.length, 'Trailing JSON data')
    return result
  }

  private whitespace(): void {
    while (' \r\n\t'.includes(this.source[this.offset] ?? '\0')) {
      this.offset++
      this.encoding?.whitespace()
    }
  }

  private string(): string {
    outputAssert(this.source[this.offset] === '"', 'Expected JSON string')
    const start = this.offset++
    // Each quote search advances. Backslash runs preceding candidate quotes
    // cannot overlap, so even malformed tokens require only linear work.
    // Native decoding still validates all escapes and raw controls.
    let end = start
    while ((end = this.source.indexOf('"', end + 1)) >= 0) {
      let backslashStart = end
      while (backslashStart > start && this.source[backslashStart - 1] === '\\') backslashStart--
      if ((end - backslashStart) % 2 === 0) break
    }
    this.offset = end < 0 ? this.source.length : end + 1
    outputAssert(end >= 0, 'Unterminated JSON string')
    const encoded = this.source.slice(start, this.offset)
    // Fresh source validation already proves unescaped Unicode well-formed;
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
    this.encoding?.string(encoded, decoded)
    return decoded
  }

  private object(depth: number): OutputJSONObject {
    this.offset++
    this.whitespace()
    const fields = new Map<string, OutputJSON>()
    let previous: string | undefined
    if (this.source[this.offset] === '}') {
      this.offset++
    } else {
      for (;;) {
        this.whitespace()
        const key = this.string()
        outputAssert(!fields.has(key), 'Duplicate decoded JSON key')
        outputAssert(fields.size < this.bounds.mapKeys, 'JSON map limit', 'limited')
        this.encoding?.key(previous, key)
        previous = key
        this.whitespace()
        outputAssert(this.source[this.offset++] === ':', 'Expected JSON colon')
        fields.set(key, this.value(depth + 1))
        this.whitespace()
        const end = this.source[this.offset++]
        if (end === '}') break
        outputAssert(end === ',', 'Expected JSON object separator')
      }
    }
    // One finalization creates own data properties without invoking setters.
    return Object.setPrototypeOf(Object.fromEntries(fields), null)
  }

  private array(depth: number): OutputJSON[] {
    this.offset++
    this.whitespace()
    const result: OutputJSON[] = []
    if (this.source[this.offset] === ']') {
      this.offset++
      return result
    }
    for (;;) {
      outputAssert(result.length < this.bounds.arrayElements, 'JSON array limit', 'limited')
      result.push(this.value(depth + 1))
      this.whitespace()
      const end = this.source[this.offset++]
      if (end === ']') return result
      outputAssert(end === ',', 'Expected JSON array separator')
    }
  }

  private value(depth: number): OutputJSON {
    outputAssert(depth <= this.bounds.depth, 'JSON depth limit', 'limited')
    this.whitespace()
    switch (this.source[this.offset]) {
      case '"':
        return this.string()
      case '{':
        return this.object(depth)
      case '[':
        return this.array(depth)
      default: {
        const rest = this.source.slice(this.offset)
        const token =
          /^(?:true|false|null)/.exec(rest)?.[0] ??
          /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest)?.[0]
        outputAssert(token !== undefined, 'Invalid JSON token')
        this.offset += token.length
        const result: unknown = JSON.parse(token)
        outputAssert(
          typeof result !== 'number' || Number.isSafeInteger(result),
          'Protocol numbers must be safe integers'
        )
        this.encoding?.value(token, result as OutputJSONScalar)
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
  const bounds = limitsFor(limits)
  const chunks: string[] = []
  const ancestors = new Set<object>()
  let bytes = 0
  function emit(chunk: string, knownASCII = false): void {
    outputAssert(chunk.length <= bounds.bytes, 'Output JSON byte limit', 'limited')
    // JSON punctuation and escaped ASCII strings have one byte per code unit.
    // Avoid allocating an encoded array for every delimiter and ASCII field.
    bytes +=
      knownASCII || /^[\u0020-\u007E]*$/.test(chunk) ? chunk.length : encoder.encode(chunk).length
    outputAssert(bytes <= bounds.bytes, 'Output JSON byte limit', 'limited')
    chunks.push(chunk)
  }
  function string(text: string, suffix = ''): void {
    outputAssert(text.length <= bounds.bytes, 'Output JSON byte limit', 'limited')
    // Valid unescaped ASCII has identical JSON and UTF-8 code-unit lengths.
    // Escaped/control/Unicode strings retain native escaping and byte counting.
    if (!/[^\u0020-\u0021\u0023-\u005B\u005D-\u007E]/.test(text)) {
      emit('"' + text + '"' + suffix, true)
    } else {
      wellFormed(text)
      emit(JSON.stringify(text) + suffix)
    }
  }
  function array(node: unknown[], depth: number): void {
    outputAssert(node.length <= bounds.arrayElements, 'JSON array limit', 'limited')
    outputAssert(
      Object.getOwnPropertyNames(node).length === node.length + 1 &&
        Object.keys(node).length === node.length,
      'Sparse or decorated JSON array'
    )
    emit('[', true)
    for (let i = 0; i < node.length; i++) {
      if (i > 0) emit(',', true)
      const descriptor = Object.getOwnPropertyDescriptor(node, i)
      outputAssert(descriptor?.enumerable && 'value' in descriptor, 'JSON array accessor or hole')
      visit(descriptor.value, depth + 1)
    }
    emit(']', true)
  }
  function object(node: object, depth: number): void {
    outputAssert(isOutputPlainObject(node), 'Expected plain JSON object')
    // Native default sorting of these primitive strings uses the UTF-16
    // ordering required by RFC 8785, independent of locale or numeric value.
    const keys = Object.getOwnPropertyNames(node).sort()
    outputAssert(keys.length <= bounds.mapKeys, 'JSON map limit', 'limited')
    emit('{', true)
    let index = 0
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(node, key)
      outputAssert(descriptor?.enumerable && 'value' in descriptor, 'JSON accessor or hidden key')
      if (index++ > 0) emit(',', true)
      // The colon is the next byte before visiting the value. One emission
      // retains the same byte-limit refusal before any value validation.
      string(key, ':')
      visit(descriptor.value, depth + 1)
    }
    emit('}', true)
  }
  function visit(node: unknown, depth: number): void {
    outputAssert(depth <= bounds.depth, 'JSON depth limit', 'limited')
    if (node === null || typeof node === 'boolean') {
      emit(String(node), true)
    } else if (typeof node === 'number') {
      outputAssert(Number.isSafeInteger(node), 'Protocol numbers must be safe integers')
      emit(JSON.stringify(node), true)
    } else if (typeof node === 'string') {
      string(node)
    } else {
      // The preceding scalar branch has already handled null.
      outputAssert(typeof node === 'object', 'Expected a JSON value')
      outputAssert(!ancestors.has(node), 'Cyclic JSON value')
      outputAssert(Object.getOwnPropertySymbols(node).length === 0, 'Symbol JSON key')
      ancestors.add(node)
      if (Array.isArray(node)) array(node, depth)
      else object(node, depth)
      ancestors.delete(node)
    }
  }
  visit(value, 1)
  return chunks.join('')
}

/**
 * Validate and capture a value as bounded canonical text and an independent
 * data-only copy. This is value ownership, not parsing incoming JSON text.
 * Every representation/resource check runs in canonicalOutputJSON before the
 * native parse. Its generated text has unique keys and valid bounded values;
 * normalize only the resulting owned records to the protocol's null prototype.
 * Incoming text/bytes still require parseOutputJSON to retain duplicate evidence.
 */
export function ownOutputJSON(
  input: unknown,
  limits: Partial<OutputJSONLimits> = OUTPUT_JSON_LIMITS
): { text: string; value: OutputJSON } {
  const text = canonicalOutputJSON(input, limits)
  const value = JSON.parse(text) as OutputJSON
  function normalize(node: OutputJSON): void {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) normalize(child)
    } else {
      Object.setPrototypeOf(node, null)
      for (const key of Object.keys(node)) normalize(node[key])
    }
  }
  normalize(value)
  return { text, value }
}
