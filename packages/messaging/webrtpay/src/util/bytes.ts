import { WebRTPayError } from './errors.js'

const textEncoder = new TextEncoder()
// fatal: reject malformed UTF-8 instead of substituting U+FFFD.
// ignoreBOM: keep a leading U+FEFF so decode(encode(s)) === s.
const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** Encode a string as UTF-8. */
export function utf8Encode(s: string): Uint8Array {
  return textEncoder.encode(s)
}

/** Decode UTF-8, throwing `WebRTPayError('protocol')` on malformed input. */
export function utf8Decode(b: Uint8Array): string {
  try {
    return textDecoder.decode(b)
  } catch (cause) {
    throw new WebRTPayError('protocol', 'Invalid UTF-8', { cause })
  }
}

const HEX_DIGITS = '0123456789abcdef'

/** Lowercase hex. */
export function toHex(b: Uint8Array): string {
  let out = ''
  for (const byte of b) {
    out += HEX_DIGITS[byte >> 4] + HEX_DIGITS[byte & 15]
  }
  return out
}

/**
 * The code of the character at `s[i]` if it is ASCII, otherwise -1 (also past the end). The
 * hex and base64 decoders read through it: their alphabets are ASCII, so any other
 * character, an astral one or a lone surrogate included, is rejected as outside the alphabet.
 */
function asciiAt(s: string, i: number): number {
  const c = s.codePointAt(i) ?? -1
  return c < 128 ? c : -1
}

function hexValue(c: number): number {
  if (c >= 48 && c <= 57) return c - 48 // 0-9
  if (c >= 97 && c <= 102) return c - 87 // a-f
  if (c >= 65 && c <= 70) return c - 55 // A-F
  return -1
}

/** Decode hex (either case). Throws `WebRTPayError('protocol')` on odd length or non-hex. */
export function fromHex(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new WebRTPayError('protocol', 'Invalid hex: odd length')
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) {
    const hi = hexValue(asciiAt(s, 2 * i))
    const lo = hexValue(asciiAt(s, 2 * i + 1))
    if (hi < 0 || lo < 0) throw new WebRTPayError('protocol', 'Invalid hex character')
    out[i] = (hi << 4) | lo
  }
  return out
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function reverseTable(alphabet: string): Int8Array {
  const table = new Int8Array(128).fill(-1)
  for (let i = 0; i < alphabet.length; i++) table[asciiAt(alphabet, i)] = i
  return table
}

const B64_REV = reverseTable(B64)
const B64URL_REV = reverseTable(B64URL)

function encode(b: Uint8Array, alphabet: string, pad: boolean): string {
  const parts: string[] = []
  let chunk = ''
  let i = 0
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2]
    chunk +=
      alphabet[n >> 18] + alphabet[(n >> 12) & 63] + alphabet[(n >> 6) & 63] + alphabet[n & 63]
    if (chunk.length >= 8192) {
      parts.push(chunk)
      chunk = ''
    }
  }
  const rest = b.length - i
  if (rest === 1) {
    const n = b[i] << 16
    chunk += alphabet[n >> 18] + alphabet[(n >> 12) & 63] + (pad ? '==' : '')
  } else if (rest === 2) {
    const n = (b[i] << 16) | (b[i + 1] << 8)
    chunk +=
      alphabet[n >> 18] + alphabet[(n >> 12) & 63] + alphabet[(n >> 6) & 63] + (pad ? '=' : '')
  }
  parts.push(chunk)
  return parts.join('')
}

/**
 * Strict decoder shared by base64 and base64url: only the given alphabet, no
 * whitespace, canonical padding (required for base64, forbidden for base64url) and
 * zero trailing bits, so every byte string has exactly one accepted encoding.
 */
function decode(s: string, rev: Int8Array, padded: boolean, what: string): Uint8Array {
  const end = padded ? unpaddedLength(s, what) : s.length
  const full = end >> 2
  const rem = end & 3
  if (rem === 1) throw new WebRTPayError('protocol', `Invalid ${what}: bad length`)
  const out = new Uint8Array(full * 3 + (rem === 0 ? 0 : rem - 1))
  const val = (i: number): number => {
    const c = asciiAt(s, i)
    const v = c < 0 ? -1 : rev[c]
    if (v < 0) throw new WebRTPayError('protocol', `Invalid ${what} character`)
    return v
  }
  let o = 0
  let i = 0
  for (; i < full * 4; i += 4) {
    const n = (val(i) << 18) | (val(i + 1) << 12) | (val(i + 2) << 6) | val(i + 3)
    out[o++] = n >> 16
    out[o++] = (n >> 8) & 255
    out[o++] = n & 255
  }
  if (rem === 2) {
    const n = (val(i) << 18) | (val(i + 1) << 12)
    if ((n & 0xffff) !== 0) throw new WebRTPayError('protocol', `Invalid ${what}: trailing bits`)
    out[o++] = n >> 16
  } else if (rem === 3) {
    const n = (val(i) << 18) | (val(i + 1) << 12) | (val(i + 2) << 6)
    if ((n & 0xff) !== 0) throw new WebRTPayError('protocol', `Invalid ${what}: trailing bits`)
    out[o++] = n >> 16
    out[o++] = (n >> 8) & 255
  }
  // Any '=' left inside the counted region fails the alphabet lookup above.
  return out
}

/**
 * The length of padded base64 `s` without its padding: one or two trailing `=` are not
 * counted. Throws `WebRTPayError('protocol')` when the length is not a multiple of 4.
 */
function unpaddedLength(s: string, what: string): number {
  if (s.length % 4 !== 0) throw new WebRTPayError('protocol', `Invalid ${what}: bad length`)
  let end = s.length
  if (end > 0 && s.codePointAt(end - 1) === 61) end--
  if (end > 0 && s.codePointAt(end - 1) === 61) end--
  return end
}

/** Standard base64 with padding (RFC 4648 section 4). */
export function toBase64(b: Uint8Array): string {
  return encode(b, B64, true)
}

/** Strict standard base64: padded, canonical, no whitespace. Throws `WebRTPayError('protocol')`. */
export function fromBase64(s: string): Uint8Array {
  return decode(s, B64_REV, true, 'base64')
}

/** URL-safe base64 without padding (RFC 4648 section 5). */
export function toBase64Url(b: Uint8Array): string {
  return encode(b, B64URL, false)
}

/** Strict base64url: URL-safe alphabet only, no padding, canonical. Throws `WebRTPayError('protocol')`. */
export function fromBase64Url(s: string): Uint8Array {
  return decode(s, B64URL_REV, false, 'base64url')
}

const MAX_RANDOM_CALL = 65536 // getRandomValues quota per call

/** Cryptographically secure random bytes via `globalThis.crypto.getRandomValues`. */
export function randomBytes(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`Invalid byte count: ${n}`)
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i += MAX_RANDOM_CALL) {
    globalThis.crypto.getRandomValues(out.subarray(i, Math.min(i + MAX_RANDOM_CALL, n)))
  }
  return out
}

/** Concatenate byte arrays into a new array. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** Byte-wise equality; time depends only on the length, not on where the arrays differ. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}
