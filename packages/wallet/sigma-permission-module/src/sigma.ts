import BigNumber from '@bsv/sdk/primitives/BigNumber'
import Curve from '@bsv/sdk/primitives/Curve'
import * as Hash from '@bsv/sdk/primitives/Hash'
import type PrivateKey from '@bsv/sdk/primitives/PrivateKey'
import * as Utils from '@bsv/sdk/primitives/utils'
import { scalar32 } from './encoding.js'

const n = new Curve().n

const utf8 = (text: string): number[] => Utils.toArray(text, 'utf8')

const uint32be = (value: number): number[] => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff
]

/** A 32-byte big-endian candidate in 0 < value < n, or undefined. Never reduced. */
const inRange = (candidate: number[]): BigNumber | undefined => {
  const value = new BigNumber(candidate)
  return value.gtn(0) && value.lt(n) ? value : undefined
}

/**
 * The proof scalar x: HKDF-SHA256 (RFC 5869) of the child key, taking the first
 * candidate x_j in range. Extract and a single Expand block are two HMAC calls.
 */
export function deriveScalar(childKey: PrivateKey): BigNumber {
  const prk = Hash.sha256hmac(utf8('p sigma v1'), childKey.toArray('be', 32))
  const info = utf8('p sigma v1 scalar')
  for (let j = 0; j < 256; j++) {
    const candidate = Hash.sha256hmac(prk, [...info, j, 1])
    const x = inRange(candidate)
    if (x !== undefined) return x
  }
  throw new Error('no scalar found')
}

/** e = LE(SHA256(transcript)) mod n. */
export function challenge(transcript: number[]): BigNumber {
  return new BigNumber([...Hash.sha256(transcript)].reverse()).umod(n)
}

/** q = SHA256("p sigma v1 request" || op || statement || uint32be(len(ctx)) || ctx). */
export function requestDigest(op: 1 | 2 | 3, statement: number[], ctx: number[]): number[] {
  return Hash.sha256([
    ...utf8('p sigma v1 request'),
    op,
    ...statement,
    ...uint32be(ctx.length),
    ...ctx
  ])
}

/** The first HMAC candidate for (attempt, label, pos) with 0 < value < n. */
export function streamScalar(
  x: BigNumber,
  q: number[],
  attempt: number,
  label: 1 | 2 | 3,
  pos: number
): BigNumber {
  const key = scalar32(x)
  const prefix = [...utf8('p sigma v1 nonce'), ...q, ...uint32be(attempt), label, pos]
  for (let c = 0; ; c++) {
    const value = inRange(Hash.sha256hmac(key, [...prefix, ...uint32be(c)]))
    if (value !== undefined) return value
  }
}
