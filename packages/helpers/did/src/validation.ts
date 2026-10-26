import type { JsonObject, JsonValue } from './types.js'

export const MAX_SD_JWT_BYTES = 1_048_576
export const MAX_JWT_BYTES = 524_288
export const MAX_DISCLOSURE_BYTES = 65_536
export const MAX_DISCLOSURES = 1_024
export const MAX_JSON_DEPTH = 32
export const MAX_JSON_NODES = 20_000
export const MAX_JSON_STRING_BYTES = 262_144
export const MAX_IDENTIFIER_BYTES = 2_048

interface JsonBudget {
  nodes: number
  strings: number
  seen: WeakSet<object>
}

export function assertBoundedString(
  value: unknown,
  label: string,
  maximumBytes: number,
  allowEmpty = false
): asserts value is string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
  const byteLength = new TextEncoder().encode(value).length
  if ((!allowEmpty && byteLength === 0) || byteLength > maximumBytes) {
    throw new TypeError(`${label} has an invalid length`)
  }
}

export function assertNumericDate(value: unknown, label: string): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    Math.abs(value) > Number.MAX_SAFE_INTEGER
  ) {
    throw new TypeError(`${label} must be a finite NumericDate`)
  }
}

export function assertDuration(
  value: unknown,
  label: string,
  maximum: number
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new TypeError(`${label} must be a bounded non-negative integer`)
  }
}

export function snapshotBytes(
  value: Uint8Array | number[],
  label: string,
  maximumLength: number,
  allowedLengths?: readonly number[]
): number[] {
  if (value instanceof Uint8Array) {
    if (value.byteLength > maximumLength) throw new TypeError(`${label} exceeds the byte limit`)
    const copy = Array.from(value)
    assertAllowedLength(copy.length, label, allowedLengths)
    return copy
  }
  if (!Array.isArray(value) || value.length > maximumLength) {
    throw new TypeError(`${label} must be a bounded byte array`)
  }
  assertAllowedLength(value.length, label, allowedLengths)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const copy = Array.from({ length: value.length }, () => 0)
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[String(index)]
    if (descriptor == null || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${label}[${index}] must be an own data byte`)
    }
    const byte = descriptor.value
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new TypeError(`${label}[${index}] must be a byte`)
    }
    copy[index] = byte
  }
  return copy
}

export function snapshotJsonObject(value: unknown, label: string): JsonObject {
  const snapshot = snapshotJsonValue(value, label)
  if (!isPlainRecord(snapshot)) throw new TypeError(`${label} must be a plain JSON object`)
  return snapshot
}

export function snapshotJsonValue(value: unknown, label: string): JsonValue {
  return cloneJsonValue(value, label, 0, {
    nodes: 0,
    strings: 0,
    seen: new WeakSet<object>()
  })
}

export function parseStrictJson<T extends JsonValue>(text: string, label: string): T {
  assertBoundedString(text, label, MAX_JSON_STRING_BYTES, true)
  new JsonScanner(text, label).parse()
  const parsed = JSON.parse(text) as unknown
  return snapshotJsonValue(parsed, label) as T
}

export function getOwnDataProperties(
  value: unknown,
  label: string,
  allowedKeys: ReadonlySet<string>
): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new TypeError(`${label} must be a plain object`)
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${label} must not contain symbol properties`)
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowedKeys.has(key)) throw new TypeError(`${label} contains unknown property "${key}"`)
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${label}.${key} must be an enumerable own data property`)
    }
    defineOwn(out, key, descriptor.value)
  }
  return out
}

export function defineOwn(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true
  })
}

export function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function cloneJsonValue(
  value: unknown,
  label: string,
  depth: number,
  budget: JsonBudget
): JsonValue {
  if (depth > MAX_JSON_DEPTH) throw new TypeError(`${label} exceeds the JSON depth limit`)
  budget.nodes += 1
  if (budget.nodes > MAX_JSON_NODES) throw new TypeError(`${label} exceeds the JSON node limit`)

  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    assertWellFormedUnicode(value, label)
    budget.strings += new TextEncoder().encode(value).length
    if (budget.strings > MAX_JSON_STRING_BYTES) {
      throw new TypeError(`${label} exceeds the JSON string-data limit`)
    }
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${label} contains a non-finite number`)
    return value
  }

  if (typeof value !== 'object' || value === undefined) {
    throw new TypeError(`${label} contains a non-JSON value`)
  }
  if (budget.seen.has(value)) throw new TypeError(`${label} contains a cycle or repeated object`)
  budget.seen.add(value)

  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_NODES) throw new TypeError(`${label} array is too large`)
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      throw new TypeError(`${label} must not contain symbol properties`)
    }
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const expectedKeys = new Set(['length'])
    const out: JsonValue[] = []
    for (let index = 0; index < value.length; index++) {
      const key = String(index)
      expectedKeys.add(key)
      const descriptor = descriptors[key]
      if (descriptor == null || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError(`${label}[${index}] must be an enumerable own data property`)
      }
      out.push(cloneJsonValue(descriptor.value, `${label}[${index}]`, depth + 1, budget))
    }
    for (const key of Object.keys(descriptors)) {
      if (!expectedKeys.has(key)) throw new TypeError(`${label} array has an unexpected property`)
    }
    budget.seen.delete(value)
    return out
  }

  if (!isPlainRecord(value)) throw new TypeError(`${label} must contain only plain JSON objects`)
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${label} must not contain symbol properties`)
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const out: JsonObject = {}
  for (const [key, descriptor] of Object.entries(descriptors)) {
    assertWellFormedUnicode(key, label)
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${label}.${key} must be an enumerable own data property`)
    }
    budget.strings += new TextEncoder().encode(key).length
    if (budget.strings > MAX_JSON_STRING_BYTES) {
      throw new TypeError(`${label} exceeds the JSON string-data limit`)
    }
    defineOwn(out, key, cloneJsonValue(descriptor.value, `${label}.${key}`, depth + 1, budget))
  }
  budget.seen.delete(value)
  return out
}

class JsonScanner {
  private offset = 0
  private nodes = 0

  constructor(
    private readonly text: string,
    private readonly label: string
  ) {}

  parse(): void {
    this.parseValue(0)
    this.skipWhitespace()
    if (this.offset !== this.text.length) this.invalid()
  }

  private parseValue(depth: number): void {
    if (depth > MAX_JSON_DEPTH) throw new TypeError(`${this.label} exceeds the JSON depth limit`)
    this.nodes += 1
    if (this.nodes > MAX_JSON_NODES) {
      throw new TypeError(`${this.label} exceeds the JSON node limit`)
    }
    this.skipWhitespace()
    const token = this.text[this.offset]
    if (token === '{') return this.parseObject(depth)
    if (token === '[') return this.parseArray(depth)
    if (token === '"') {
      this.parseString()
      return
    }
    if (token === 't') return this.consumeKeyword('true')
    if (token === 'f') return this.consumeKeyword('false')
    if (token === 'n') return this.consumeKeyword('null')
    this.parseNumber()
  }

  private parseObject(depth: number): void {
    this.offset += 1
    this.skipWhitespace()
    if (this.text[this.offset] === '}') {
      this.offset += 1
      return
    }
    const keys = new Set<string>()
    while (true) {
      this.skipWhitespace()
      if (this.text[this.offset] !== '"') this.invalid()
      const key = this.parseString()
      if (keys.has(key)) throw new TypeError(`${this.label} contains duplicate JSON key "${key}"`)
      keys.add(key)
      this.skipWhitespace()
      if (this.text[this.offset] !== ':') this.invalid()
      this.offset += 1
      this.parseValue(depth + 1)
      this.skipWhitespace()
      const separator = this.text[this.offset]
      if (separator === '}') {
        this.offset += 1
        return
      }
      if (separator !== ',') this.invalid()
      this.offset += 1
    }
  }

  private parseArray(depth: number): void {
    this.offset += 1
    this.skipWhitespace()
    if (this.text[this.offset] === ']') {
      this.offset += 1
      return
    }
    while (true) {
      this.parseValue(depth + 1)
      this.skipWhitespace()
      const separator = this.text[this.offset]
      if (separator === ']') {
        this.offset += 1
        return
      }
      if (separator !== ',') this.invalid()
      this.offset += 1
    }
  }

  private parseString(): string {
    const start = this.offset
    this.offset += 1
    while (this.offset < this.text.length) {
      const code = this.text.charCodeAt(this.offset)
      if (code === 0x22) {
        this.offset += 1
        return JSON.parse(this.text.slice(start, this.offset)) as string
      }
      if (code < 0x20) this.invalid()
      if (code === 0x5c) {
        this.offset += 1
        const escape = this.text[this.offset]
        if (escape === 'u') {
          if (!/^[0-9A-Fa-f]{4}$/.test(this.text.slice(this.offset + 1, this.offset + 5))) {
            this.invalid()
          }
          this.offset += 5
          continue
        }
        if (escape == null || !'"\\/bfnrt'.includes(escape)) this.invalid()
      }
      this.offset += 1
    }
    this.invalid()
  }

  private parseNumber(): void {
    if (this.text[this.offset] === '-') this.offset += 1
    if (this.text[this.offset] === '0') {
      this.offset += 1
      if (isDigit(this.text[this.offset])) this.invalid()
    } else {
      if (!isDigitOneToNine(this.text[this.offset])) this.invalid()
      while (isDigit(this.text[this.offset])) this.offset += 1
    }
    if (this.text[this.offset] === '.') {
      this.offset += 1
      if (!isDigit(this.text[this.offset])) this.invalid()
      while (isDigit(this.text[this.offset])) this.offset += 1
    }
    if (this.text[this.offset] === 'e' || this.text[this.offset] === 'E') {
      this.offset += 1
      if (this.text[this.offset] === '+' || this.text[this.offset] === '-') this.offset += 1
      if (!isDigit(this.text[this.offset])) this.invalid()
      while (isDigit(this.text[this.offset])) this.offset += 1
    }
  }

  private consumeKeyword(keyword: string): void {
    if (this.text.slice(this.offset, this.offset + keyword.length) !== keyword) this.invalid()
    this.offset += keyword.length
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.text[this.offset] ?? '') && ' \n\r\t'.includes(this.text[this.offset])) {
      this.offset += 1
    }
  }

  private invalid(): never {
    throw new TypeError(`${this.label} is not canonical JSON`)
  }
}

function isDigit(value: string | undefined): boolean {
  return value !== undefined && value >= '0' && value <= '9'
}

function assertAllowedLength(
  length: number,
  label: string,
  allowedLengths?: readonly number[]
): void {
  if (allowedLengths != null && !allowedLengths.includes(length)) {
    throw new TypeError(`${label} has an invalid length`)
  }
}

function isDigitOneToNine(value: string | undefined): boolean {
  return value !== undefined && value >= '1' && value <= '9'
}

function assertWellFormedUnicode(value: string, label: string): void {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new TypeError(`${label} contains an unpaired Unicode surrogate`)
      }
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`${label} contains an unpaired Unicode surrogate`)
    }
  }
}
