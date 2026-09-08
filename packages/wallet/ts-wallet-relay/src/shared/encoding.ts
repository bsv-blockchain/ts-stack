import { Utils, toBRC100PortableByteArray } from '@bsv/sdk'

/** Convert a byte array to a base64url string using @bsv/sdk Utils. */
export function bytesToBase64url(value: unknown): string {
  const bytes = toBRC100PortableByteArray(value)
  if (bytes == null) throw new TypeError('Invalid BRC-100 byte payload')
  return Utils.toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

/** Decode a base64url string to a byte array using @bsv/sdk Utils. */
export function base64urlToBytes(str: string): number[] {
  return Utils.toArray(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64') as number[]
}
