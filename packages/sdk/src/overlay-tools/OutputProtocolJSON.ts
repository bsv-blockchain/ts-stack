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
  // Check UTF-16 before TextEncoder can silently replace a lone surrogate.
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i)
      outputAssert(next >= 0xdc00 && next <= 0xdfff, 'Unpaired JSON surrogate')
    } else {
      outputAssert(unit < 0xdc00 || unit > 0xdfff, 'Unpaired JSON surrogate')
    }
  }
}

/**
 * Parse bounded protocol JSON while retaining duplicate decoded keys long enough
 * to reject them. JSON.parse alone loses that evidence. This does not validate a
 * packet schema; callers must also validate its recursively closed structures.
 */
export function parseOutputJSON(
  input: Uint8Array | string,
  limits: Partial<OutputJSONLimits> = {}
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
  outputAssert(source.charCodeAt(0) !== 0xfeff, 'JSON BOM is not permitted')
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
    let escaped = false
    while (this.offset < this.source.length) {
      const character = this.source[this.offset++]
      if (!escaped && character === '"') {
        let decoded: string
        try {
          decoded = JSON.parse(this.source.slice(start, this.offset)) as string
        } catch {
          throw new OutputProtocolError('invalid', 'Malformed JSON string')
        }
        wellFormed(decoded)
        return decoded
      }
      escaped = !escaped && character === '\\'
    }
    throw new OutputProtocolError('invalid', 'Unterminated JSON string')
  }

  private object(depth: number): OutputJSONObject {
    this.offset++
    this.whitespace()
    const result: OutputJSONObject = Object.create(null) as OutputJSONObject
    let count = 0
    if (this.source[this.offset] === '}') {
      this.offset++
      return result
    }
    for (;;) {
      this.whitespace()
      const key = this.string()
      outputAssert(!Object.hasOwn(result, key), 'Duplicate decoded JSON key')
      outputAssert(++count <= this.bounds.mapKeys, 'JSON map limit', 'limited')
      this.whitespace()
      outputAssert(this.source[this.offset++] === ':', 'Expected JSON colon')
      result[key] = this.value(depth + 1)
      this.whitespace()
      const end = this.source[this.offset++]
      if (end === '}') return result
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
        const token =
          /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
            this.source.slice(this.offset)
          )?.[0]
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
  limits: Partial<OutputJSONLimits> = {}
): string {
  const bounds = limitsFor(limits)
  const chunks: string[] = []
  const ancestors = new Set<object>()
  let bytes = 0
  function emit(chunk: string): void {
    outputAssert(chunk.length <= bounds.bytes, 'Output JSON byte limit', 'limited')
    bytes += encoder.encode(chunk).length
    outputAssert(bytes <= bounds.bytes, 'Output JSON byte limit', 'limited')
    chunks.push(chunk)
  }
  function string(text: string): void {
    outputAssert(text.length <= bounds.bytes, 'Output JSON byte limit', 'limited')
    wellFormed(text)
    emit(JSON.stringify(text))
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
      if (Array.isArray(node)) {
        outputAssert(node.length <= bounds.arrayElements, 'JSON array limit', 'limited')
        outputAssert(Object.keys(node).length === node.length, 'Sparse or decorated JSON array')
        emit('[')
        for (let i = 0; i < node.length; i++) {
          if (i > 0) emit(',')
          const descriptor = Object.getOwnPropertyDescriptor(node, i)
          outputAssert(descriptor && 'value' in descriptor, 'JSON array accessor or hole')
          visit(descriptor.value, depth + 1)
        }
        emit(']')
      } else {
        outputAssert(isOutputPlainObject(node), 'Expected plain JSON object')
        const keys = Object.getOwnPropertyNames(node).sort()
        outputAssert(keys.length <= bounds.mapKeys, 'JSON map limit', 'limited')
        emit('{')
        keys.forEach((key, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(node, key)
          outputAssert(
            descriptor?.enumerable && 'value' in descriptor,
            'JSON accessor or hidden key'
          )
          if (index > 0) emit(',')
          string(key)
          emit(':')
          visit(descriptor.value, depth + 1)
        })
        emit('}')
      }
      ancestors.delete(node)
    }
  }
  visit(value, 1)
  return chunks.join('')
}
