import { createHash, timingSafeEqual } from 'node:crypto'

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

/** Compare a remote bearer token without exposing a prefix-match timing path. */
export function secureTokenEqual(expected: string, supplied: string | null | undefined): boolean {
  if (typeof supplied !== 'string' || supplied.length === 0) return false
  return timingSafeEqual(digest(expected), digest(supplied))
}
