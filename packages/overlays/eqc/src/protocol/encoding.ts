import { Utils } from '@bsv/sdk'

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/** True for standard (not URL-safe) base64 that re-encodes to itself. */
export function isCanonicalBase64(value: unknown): value is string {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !BASE64.test(value)) return false
  return Utils.toBase64(Utils.toArray(value, 'base64')) === value
}
