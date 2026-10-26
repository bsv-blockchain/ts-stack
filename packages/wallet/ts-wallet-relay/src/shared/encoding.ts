import { toBRC100PortableByteArray } from '@bsv/sdk/wallet/BRC100ByteEncoding'
import { base64ToBytes, bytesToBase64 } from '@bsv/sdk/wallet/WalletByteEncoding'

/** Convert a byte array to a canonical unpadded base64url string. */
export function bytesToBase64url(value: unknown): string {
  const bytes = toBRC100PortableByteArray(value)
  if (bytes == null) throw new TypeError('Invalid BRC-100 byte payload')
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

/** Decode a canonical unpadded base64url string to a byte array. */
export function base64urlToBytes(str: string): number[] {
  if (
    typeof str !== 'string' ||
    str.length === 0 ||
    str.length % 4 === 1 ||
    !/^[A-Za-z0-9_-]+$/u.test(str)
  ) {
    throw new TypeError('Invalid canonical base64url payload')
  }
  const standard = str.replace(/-/g, '+').replace(/_/g, '/')
  let bytes: number[]
  try {
    bytes = base64ToBytes(standard.padEnd(Math.ceil(standard.length / 4) * 4, '='))
  } catch {
    throw new TypeError('Invalid canonical base64url payload')
  }
  if (bytesToBase64url(bytes) !== str) throw new TypeError('Invalid canonical base64url payload')
  return bytes
}
