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
  // Custom limits still pass every original resource check below.
  if (limits === OUTPUT_JSON_LIMITS) return OUTPUT_JSON_LIMITS
  const result = { ...OUTPUT_JSON_LIMITS, ...limits }
  for (const key of Object.keys(result) as (keyof OutputJSONLimits)[]) {
    outputAssert(
      Object.hasOwn(OUTPUT_JSON_LIMITS, key) &&
        Number.isSafeInteger(result[key]) &&
        result[key] > 0 &&
        result[key] <= OUTPUT_JSON_LIMITS[key],
      'Invalid output JSON resource limit'
    )
  }
  return result
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
  const bounds = limitsFor(limits)
  let source: string
  if (typeof input === 'string') {
    outputAssert(input.length <= bounds.bytes, 'Output JSON byte limit', 'limited')
    wellFormed(input)
    outputAssert(encoder.encode(input).length <= bounds.bytes, 'Output JSON byte limit', 'limited')
    source = input
  } else {
    outputAssert(input instanceof Uint8Array, 'Expected UTF-8 bytes')
    outputAssert(input.byteLength <= bounds.bytes, 'Output JSON byte limit', 'limited')
    try {
      source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input)
    } catch {
      throw new OutputProtocolError('invalid', 'Malformed UTF-8')
    }
  }
  outputAssert(source.codePointAt(0) !== 0xfeff, 'JSON BOM is not permitted')
  return new OutputJSONParser(source, bounds).parse()
}

class OutputJSONParser {
  private offset = 0

  constructor(
    private readonly source: string,
    private readonly bounds: OutputJSONLimits
  ) {}

  parse(): OutputJSON {
    const result = this.value(1)
    this.whitespace()
    outputAssert(this.offset === this.source.length, 'Trailing JSON data')
    return result
  }

  private whitespace(): void {
    while (' \r\n\t'.includes(this.source[this.offset] ?? '\0')) this.offset++
  }

  private string(): string {
    outputAssert(this.source[this.offset] === '"', 'Expected JSON string')
    const start = this.offset++
    // A backslash skips exactly one following UTF-16 code unit.
    // JSON.parse still validates every escape/control;
    // the decoded Unicode check and duplicate-key checks remain independent.
    const delimiters = /["\\]/g
    delimiters.lastIndex = this.offset
    for (
      let match = delimiters.exec(this.source);
      match !== null;
      match = delimiters.exec(this.source)
    ) {
      if (match[0] === '\\') {
        delimiters.lastIndex = match.index + 2
        continue
      }
      this.offset = match.index + 1
      let decoded: string
      try {
        decoded = JSON.parse(this.source.slice(start, this.offset)) as string
      } catch {
        throw new OutputProtocolError('invalid', 'Malformed JSON string')
      }
      wellFormed(decoded)
      return decoded
    }
    this.offset = this.source.length
    throw new OutputProtocolError('invalid', 'Unterminated JSON string')
  }

  private object(depth: number): OutputJSONObject {
    this.offset++
    this.whitespace()
    const fields = new Map<string, OutputJSON>()
    // fromEntries creates own data properties without invoking object setters.
    const result = (): OutputJSONObject => Object.setPrototypeOf(Object.fromEntries(fields), null)
    if (this.source[this.offset] === '}') {
      this.offset++
      return result()
    }
    for (;;) {
      this.whitespace()
      const key = this.string()
      outputAssert(!fields.has(key), 'Duplicate decoded JSON key')
      outputAssert(fields.size < this.bounds.mapKeys, 'JSON map limit', 'limited')
      this.whitespace()
      outputAssert(this.source[this.offset++] === ':', 'Expected JSON colon')
      fields.set(key, this.value(depth + 1))
      this.whitespace()
      const end = this.source[this.offset++]
      if (end === '}') return result()
      outputAssert(end === ',', 'Expected JSON object separator')
    }
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
        return result as null | boolean | number
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
  function emit(chunk: string): void {
    outputAssert(chunk.length <= bounds.bytes, 'Output JSON byte limit', 'limited')
    // JSON punctuation and escaped ASCII strings have one byte per code unit.
    // Avoid allocating an encoded array for every delimiter and ASCII field.
    bytes += /^[\u0020-\u007E]*$/.test(chunk) ? chunk.length : encoder.encode(chunk).length
    outputAssert(bytes <= bounds.bytes, 'Output JSON byte limit', 'limited')
    chunks.push(chunk)
  }
  function string(text: string): void {
    outputAssert(text.length <= bounds.bytes, 'Output JSON byte limit', 'limited')
    wellFormed(text)
    emit(JSON.stringify(text))
  }
  function array(node: unknown[], depth: number): void {
    outputAssert(node.length <= bounds.arrayElements, 'JSON array limit', 'limited')
    outputAssert(
      Object.getOwnPropertyNames(node).length === node.length + 1 &&
        Object.keys(node).length === node.length,
      'Sparse or decorated JSON array'
    )
    emit('[')
    for (let i = 0; i < node.length; i++) {
      if (i > 0) emit(',')
      const descriptor = Object.getOwnPropertyDescriptor(node, i)
      outputAssert(descriptor?.enumerable && 'value' in descriptor, 'JSON array accessor or hole')
      visit(descriptor.value, depth + 1)
    }
    emit(']')
  }
  function object(node: object, depth: number): void {
    outputAssert(isOutputPlainObject(node), 'Expected plain JSON object')
    // RFC 8785 orders property names by UTF-16 code units, never locale rules.
    const keys = Object.getOwnPropertyNames(node).sort((a, b) => {
      if (a < b) return -1
      if (a > b) return 1
      return 0
    })
    outputAssert(keys.length <= bounds.mapKeys, 'JSON map limit', 'limited')
    emit('{')
    keys.forEach((key, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(node, key)
      outputAssert(descriptor?.enumerable && 'value' in descriptor, 'JSON accessor or hidden key')
      if (index > 0) emit(',')
      string(key)
      emit(':')
      visit(descriptor.value, depth + 1)
    })
    emit('}')
  }
  function visit(node: unknown, depth: number): void {
    outputAssert(depth <= bounds.depth, 'JSON depth limit', 'limited')
    if (node === null || typeof node === 'boolean') {
      emit(JSON.stringify(node))
    } else if (typeof node === 'number') {
      outputAssert(Number.isSafeInteger(node), 'Protocol numbers must be safe integers')
      emit(JSON.stringify(node))
    } else if (typeof node === 'string') {
      string(node)
    } else {
      outputAssert(typeof node === 'object' && node !== null, 'Expected a JSON value')
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
