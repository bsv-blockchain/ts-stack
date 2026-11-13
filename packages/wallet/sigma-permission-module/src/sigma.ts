import BigNumber from '@bsv/sdk/primitives/BigNumber'
import Curve from '@bsv/sdk/primitives/Curve'
import * as Hash from '@bsv/sdk/primitives/Hash'
import type PrivateKey from '@bsv/sdk/primitives/PrivateKey'
import * as Utils from '@bsv/sdk/primitives/utils'
import Point from '@bsv/sdk/primitives/Point'
import { point64, scalar32 } from './encoding.js'

const curve = new Curve()
const n = curve.n

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
  // j is a single byte, so 256 candidates is the whole space.
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

/** A 64-byte x then y point that is on the curve and not the identity, else undefined. */
const readPoint64 = (bytes: number[]): Point | undefined => {
  const x = new BigNumber(bytes.slice(0, 32))
  const y = new BigNumber(bytes.slice(32, 64))
  if (x.gte(curve.p) || y.gte(curve.p)) return undefined
  const point = new Point(x, y)
  return point.validate() ? point : undefined
}

/** A 32-byte big-endian scalar in [1, n), else undefined. */
const readScalar = (bytes: number[]): BigNumber | undefined => inRange(bytes)

/** Schnorr proof of knowledge of x for P = x·G. Result R || s, 96 bytes. */
export function proveSchnorr(x: BigNumber, ctx: number[]): number[] {
  const P = point64(curve.g.mul(x))
  const q = requestDigest(1, P, ctx)
  for (let a = 0; ; a++) {
    const k = streamScalar(x, q, a, 1, 0)
    const R = point64(curve.g.mul(k))
    const e = challenge([...R, ...P, ...ctx])
    const s = k.add(e.mul(x)).umod(n)
    if (!s.isZero()) return [...R, ...scalar32(s)]
  }
}

/** Verifies a Schnorr result against the statement point P. Never throws. */
export function verifySchnorr(P: Point, ctx: number[], result: number[]): boolean {
  if (result.length !== 96) return false
  const R = readPoint64(result.slice(0, 64))
  const s = readScalar(result.slice(64))
  if (R === undefined || s === undefined) return false
  const e = challenge([...result.slice(0, 64), ...point64(P), ...ctx])
  return curve.g.mul(s).eq(R.add(P.mul(e)))
}

/** Chaum-Pedersen proof that P = x·G and P2 = x·H share x. Result P2 || R1 || R2 || s, 224 bytes. */
export function proveDleq(x: BigNumber, H: Point, ctx: number[]): number[] {
  const P = point64(curve.g.mul(x))
  const P2 = point64(H.mul(x))
  const Hb = point64(H)
  const q = requestDigest(2, [...P, ...P2, ...Hb], ctx)
  for (let a = 0; ; a++) {
    const k = streamScalar(x, q, a, 1, 0)
    const R1 = point64(curve.g.mul(k))
    const R2 = point64(H.mul(k))
    const e = challenge([...R1, ...R2, ...P, ...P2, ...Hb, ...ctx])
    const s = k.add(e.mul(x)).umod(n)
    if (!s.isZero()) return [...P2, ...R1, ...R2, ...scalar32(s)]
  }
}

/** Verifies a DLEQ result against the statement points P and H. Never throws. */
export function verifyDleq(P: Point, H: Point, ctx: number[], result: number[]): boolean {
  if (result.length !== 224) return false
  const P2 = readPoint64(result.slice(0, 64))
  const R1 = readPoint64(result.slice(64, 128))
  const R2 = readPoint64(result.slice(128, 192))
  const s = readScalar(result.slice(192))
  if (P2 === undefined || R1 === undefined || R2 === undefined || s === undefined) return false
  const e = challenge([
    ...result.slice(64, 192),
    ...point64(P),
    ...result.slice(0, 64),
    ...point64(H),
    ...ctx
  ])
  return curve.g.mul(s).eq(R1.add(P.mul(e))) && H.mul(s).eq(R2.add(P2.mul(e)))
}
