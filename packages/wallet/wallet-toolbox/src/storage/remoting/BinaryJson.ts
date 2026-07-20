export const BINARY_ENCODING_HEADER = 'X-BSV-Binary-Encoding'
export const BINARY_REQUEST_ENCODING_HEADER = 'X-BSV-Binary-Request-Encoding'
export const BINARY_ENCODING = 'base64'

const TAG = '$bsvBinary'
const ESCAPED = 'escaped'
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function getBufferCtor (): any {
  return typeof globalThis === 'undefined' ? undefined : (globalThis as any).Buffer
}

function toBase64 (bytes: Uint8Array): string {
  const BufferCtor = getBufferCtor()
  if (BufferCtor != null) return BufferCtor.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
  if (typeof globalThis.btoa === 'function') {
    let binary = ''
    const chunkSize = 0x8000
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)))
    }
    return globalThis.btoa(binary)
  }
  let encoded = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const first = bytes[i]
    const second = bytes[i + 1] ?? 0
    const third = bytes[i + 2] ?? 0
    encoded += BASE64[first >>> 2]
    encoded += BASE64[((first & 3) << 4) | (second >>> 4)]
    encoded += i + 1 < bytes.length ? BASE64[((second & 15) << 2) | (third >>> 6)] : '='
    encoded += i + 2 < bytes.length ? BASE64[third & 63] : '='
  }
  return encoded
}

function fromBase64 (base64: string): Uint8Array {
  if (base64.length % 4 !== 0) throw new TypeError('Invalid base64 binary JSON value')
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  const contentLength = base64.length - padding
  for (let i = 0; i < contentLength; i++) {
    if (!BASE64.includes(base64[i])) throw new TypeError('Invalid base64 binary JSON value')
  }
  for (let i = contentLength; i < base64.length; i++) {
    if (base64[i] !== '=') throw new TypeError('Invalid base64 binary JSON value')
  }
  if (
    (padding === 1 && (BASE64.indexOf(base64[contentLength - 1]) & 3) !== 0) ||
    (padding === 2 && (BASE64.indexOf(base64[contentLength - 1]) & 15) !== 0)
  ) throw new TypeError('Invalid base64 binary JSON value')

  const BufferCtor = getBufferCtor()
  if (BufferCtor != null) {
    const buffer = BufferCtor.from(base64, 'base64')
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  }
  if (typeof globalThis.atob === 'function') {
    const binary = globalThis.atob(base64)
    // Uint8Array.from performs the conversion in the native collection
    // primitive and avoids an attacker-controlled JavaScript loop bound.
    return Uint8Array.from(binary, character => character.charCodeAt(0))
  }
  const bytes = new Uint8Array(Math.floor(base64.length * 3 / 4) - padding)
  let offset = 0
  for (let i = 0; i < base64.length; i += 4) {
    const first = BASE64.indexOf(base64[i])
    const second = BASE64.indexOf(base64[i + 1])
    const third = base64[i + 2] === '=' ? 0 : BASE64.indexOf(base64[i + 2])
    const fourth = base64[i + 3] === '=' ? 0 : BASE64.indexOf(base64[i + 3])
    const value = (first << 18) | (second << 12) | (third << 6) | fourth
    if (offset < bytes.length) bytes[offset++] = value >>> 16
    if (offset < bytes.length) bytes[offset++] = value >>> 8
    if (offset < bytes.length) bytes[offset++] = value
  }
  return bytes
}

function isTaggedBinary (value: unknown): value is { [TAG]: typeof BINARY_ENCODING, data: string } {
  return value != null && typeof value === 'object' &&
    (value as any)[TAG] === BINARY_ENCODING && typeof (value as any).data === 'string' &&
    Object.keys(value).length === 2
}

function isBufferJson (value: unknown): value is { type: 'Buffer', data: number[] } {
  return value != null && typeof value === 'object' &&
    (value as any).type === 'Buffer' && Array.isArray((value as any).data) &&
    Object.keys(value).length === 2
}

function isEscapedJson (value: unknown): value is { [TAG]: typeof ESCAPED, entries: Array<[string, unknown]> } {
  return value != null && typeof value === 'object' &&
    (value as any)[TAG] === ESCAPED && Array.isArray((value as any).entries) &&
    Object.keys(value).length === 2 &&
    (value as any).entries.every((entry: unknown) =>
      Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string'
    )
}

function escapeJsonObject (value: object): unknown {
  return { [TAG]: ESCAPED, entries: Object.entries(value) }
}

export function binaryJsonReplacer (this: Record<string, unknown>, key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) return { [TAG]: BINARY_ENCODING, data: toBase64(value) }
  if (value == null || typeof value !== 'object') return value
  // Buffer.toJSON runs before a JSON replacer, but the holder still contains
  // the original Buffer. Literal Buffer-JSON objects must remain ordinary data.
  if (isBufferJson(value)) {
    const original = this[key]
    if (original instanceof Uint8Array) return { [TAG]: BINARY_ENCODING, data: toBase64(original) }
    return escapeJsonObject(value)
  }
  if (isTaggedBinary(value) || isEscapedJson(value)) return escapeJsonObject(value)
  return value
}

export function legacyBinaryJsonReplacer (_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) return Array.from(value)
  return value
}

export function binaryJsonReviver (_key: string, value: unknown): unknown {
  if (isTaggedBinary(value)) return fromBase64(value.data)
  if (isEscapedJson(value)) return Object.fromEntries(value.entries)
  return value
}

export function decodeBinaryJsonValue (value: unknown): unknown {
  if (isTaggedBinary(value)) return fromBase64(value.data)
  if (value == null || typeof value !== 'object') return value

  // JSON can be nested far more deeply than the JavaScript call stack. Walk it
  // iteratively so an authenticated peer cannot turn binary decoding into a
  // recursion overflow.
  const decoded = isEscapedJson(value) ? Object.fromEntries(value.entries) : value
  const stack: object[] = [decoded]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current == null) continue
    for (const [key, child] of Object.entries(current)) {
      if (isTaggedBinary(child)) {
        ;(current as Record<string, unknown>)[key] = fromBase64(child.data)
      } else if (isEscapedJson(child)) {
        const restored = Object.fromEntries(child.entries)
        ;(current as Record<string, unknown>)[key] = restored
        stack.push(restored)
      } else if (child != null && typeof child === 'object') {
        stack.push(child)
      }
    }
  }
  return decoded
}

export function stringifyJsonRpc (value: unknown, binary: boolean): string {
  return JSON.stringify(value, binary ? binaryJsonReplacer : legacyBinaryJsonReplacer)
}

export function parseJsonRpc (text: string, binary: boolean = false): any {
  return binary ? JSON.parse(text, binaryJsonReviver) : JSON.parse(text)
}
