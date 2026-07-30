/**
 * Unpadded base64url, kept local so this package has no runtime dependencies.
 *
 * base64url rather than base64 because a part string ends up in QR alphanumeric
 * mode, URLs and log lines, and `+` / `/` / `=` are hostile in all three.
 * Encoding runs through `globalThis.btoa` / `atob`, which exist in browsers and
 * in Node 22+, so the same code path serves both.
 */

/**
 * `String.fromCharCode` is variadic and each argument occupies a stack slot, so
 * a whole 64 KiB buffer in one call can blow the argument limit. Chunking keeps
 * the fast native path without that risk.
 */
const CHUNK = 0x8000

/** `true` for a well-formed unpadded base64url body (including the empty string). */
const BASE64URL = /^[\w-]*$/

/** Unpadded base64url text for `bytes`. */
export function toB64url(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    // Every byte is below 0x100, so a code point is a single code unit here.
    binary += String.fromCodePoint(...bytes.subarray(i, i + CHUNK))
  }
  return globalThis.btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/**
 * The bytes behind unpadded base64url `text`.
 *
 * Rejects anything outside the base64url alphabet, and any length that cannot
 * be a base64 body, before handing the string to `atob` — runtimes disagree on
 * how lenient `atob` is, and the decoder's soft-reject contract needs the
 * answer to be the same everywhere.
 *
 * @throws {Error} when `text` is not valid unpadded base64url.
 */
export function fromB64url(text: string): Uint8Array {
  if (!BASE64URL.test(text)) throw new Error('invalid base64url')
  // A trailing group of one character carries 6 bits and cannot encode a byte.
  if (text.length % 4 === 1) throw new Error('invalid base64url length')
  const padded = text.replaceAll('-', '+').replaceAll('_', '/')
  const binary = globalThis.atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)
  // `atob` yields one code unit below 0x100 per byte, so this cannot truncate.
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.codePointAt(i)!
  return bytes
}
