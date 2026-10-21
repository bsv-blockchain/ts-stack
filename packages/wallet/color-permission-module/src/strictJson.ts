// Strict JSON for BRC-207 metadata: RFC 8259 grammar, duplicate members rejected
// at every level, unpaired surrogate escapes rejected, bounded nesting.

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject
export interface JsonObject {
  [member: string]: JsonValue
}

const MAX_DEPTH = 64
const UINT32_MAX = 0xffffffff
// Stryker disable next-line StringLiteral: TextDecoder('') throws ERR_ENCODING_NOT_SUPPORTED at module load, so the mutant can only be a RuntimeError, never a behavior change a test could observe
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y
const ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t'
}

class Parser {
  private position = 0

  constructor(
    private readonly text: string,
    private readonly label: string
  ) {}

  fail(reason: string): never {
    throw new Error(`BRC-207: ${this.label} is not strict JSON (${reason})`)
  }

  parse(): JsonValue {
    const value = this.value(0)
    this.whitespace()
    if (this.position !== this.text.length) this.fail('trailing data')
    return value
  }

  private whitespace(): void {
    while (this.position < this.text.length && ' \t\n\r'.includes(this.text[this.position]))
      this.position++
  }

  private literal(word: string, value: JsonValue): JsonValue {
    if (!this.text.startsWith(word, this.position)) this.fail('invalid literal')
    this.position += word.length
    return value
  }

  private value(depth: number): JsonValue {
    if (depth > MAX_DEPTH) this.fail('nesting too deep')
    this.whitespace()
    const next = this.text[this.position]
    if (next === '{') return this.object(depth)
    if (next === '[') return this.array(depth)
    if (next === '"') return this.string()
    if (next === 't') return this.literal('true', true)
    if (next === 'f') return this.literal('false', false)
    if (next === 'n') return this.literal('null', null)
    return this.number()
  }

  private number(): number {
    NUMBER.lastIndex = this.position
    const match = NUMBER.exec(this.text)
    if (match == null) this.fail('invalid value')
    this.position += match[0].length
    const value = Number(match[0])
    // BRC-207 integer fields are integers, not fractions: 1.0 and 1e0 are not the integer 1.
    // JSON.stringify writes every integer below 1e21 as plain digits, so only a literal in that
    // range can be a non-integer spelling of an integer.
    if (Number.isInteger(value) && Math.abs(value) < 1e21 && /[.eE]/.test(match[0]))
      this.fail('an integer written as a fraction or exponent')
    return value
  }

  private hex4(): number {
    const digits = this.text.slice(this.position, this.position + 4)
    if (!/^[0-9a-fA-F]{4}$/.test(digits)) this.fail('invalid unicode escape')
    this.position += 4
    return Number.parseInt(digits, 16)
  }

  private string(): string {
    this.position++
    let result = ''
    for (;;) {
      const char = this.text[this.position++]
      if (char === undefined) this.fail('unterminated string')
      if (char === '"') return result
      if (char < ' ') this.fail('control character in string')
      result += char === '\\' ? this.escape() : char
    }
  }

  /** Decodes the escape after a backslash; a surrogate pair decodes to its one code point. */
  private escape(): string {
    const escape = this.text[this.position++]
    if (escape !== 'u') {
      const decoded = ESCAPES[escape]
      if (decoded === undefined) this.fail('invalid escape')
      return decoded
    }
    const unit = this.hex4()
    if (unit >= 0xdc00 && unit <= 0xdfff) this.fail('unpaired surrogate')
    if (unit < 0xd800 || unit > 0xdbff) return String.fromCodePoint(unit)
    if (this.text.slice(this.position, this.position + 2) !== String.raw`\u`)
      this.fail('unpaired surrogate')
    this.position += 2
    const low = this.hex4()
    if (low < 0xdc00 || low > 0xdfff) this.fail('unpaired surrogate')
    return String.fromCodePoint(0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00))
  }

  private array(depth: number): JsonValue[] {
    this.position++
    const result: JsonValue[] = []
    this.whitespace()
    if (this.text[this.position] === ']') {
      this.position++
      return result
    }
    for (;;) {
      result.push(this.value(depth + 1))
      this.whitespace()
      const next = this.text[this.position++]
      if (next === ']') return result
      if (next !== ',') this.fail('expected , or ]')
    }
  }

  private object(depth: number): JsonObject {
    this.position++
    const result: JsonObject = Object.create(null)
    this.whitespace()
    if (this.text[this.position] === '}') {
      this.position++
      return result
    }
    for (;;) {
      this.whitespace()
      if (this.text[this.position] !== '"') this.fail('expected member name')
      const name = this.string()
      if (Object.hasOwn(result, name)) this.fail(`duplicate member ${name}`)
      this.whitespace()
      if (this.text[this.position++] !== ':') this.fail('expected :')
      result[name] = this.value(depth + 1)
      this.whitespace()
      const next = this.text[this.position++]
      if (next === '}') return result
      if (next !== ',') this.fail('expected , or }')
    }
  }
}

/** Parses strict JSON text; member objects have no prototype. */
export function parseStrictJson(text: string, label: string): JsonValue {
  return new Parser(text, label).parse()
}

/** Decodes strict UTF-8 bytes and parses them as strict JSON. */
export function parseStrictJsonBytes(
  bytes: readonly number[] | Uint8Array,
  label: string
): JsonValue {
  let text: string
  try {
    text = UTF8_DECODER.decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
  } catch {
    throw new Error(`BRC-207: ${label} is not strict UTF-8`)
  }
  return parseStrictJson(text, label)
}

export function jsonObject(value: JsonValue | undefined, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`BRC-207: ${label} must be a JSON object`)
  }
  return value
}

/** Requires exactly the named members: every required one, any optional ones, nothing else. */
export function exactMembers(
  object: JsonObject,
  required: readonly string[],
  optional: readonly string[],
  label: string
): void {
  for (const member of required) {
    if (!Object.hasOwn(object, member)) throw new Error(`BRC-207: ${label} is missing ${member}`)
  }
  for (const member of Object.keys(object)) {
    if (!required.includes(member) && !optional.includes(member)) {
      throw new Error(`BRC-207: ${label} has unknown member ${member}`)
    }
  }
}

export function jsonArray(value: JsonValue | undefined, label: string): JsonValue[] {
  if (!Array.isArray(value)) throw new Error(`BRC-207: ${label} must be an array`)
  return value
}

export function jsonUint32(value: JsonValue | undefined, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new Error(`BRC-207: ${label} must be an integer in 0..2^32-1`)
  }
  return value
}

/** A nonempty array of integer bytes, bounded before it is copied. */
export function jsonByteArray(
  value: JsonValue | undefined,
  label: string,
  maxBytes: number
): number[] {
  const array = jsonArray(value, label)
  if (array.length === 0 || array.length > maxBytes) {
    throw new Error(`BRC-207: ${label} must hold 1..${maxBytes} bytes`)
  }
  for (const byte of array) {
    if (typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new Error(`BRC-207: ${label} must contain integer bytes`)
    }
  }
  return array as number[]
}
