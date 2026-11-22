import BigNumber from '@bsv/sdk/primitives/BigNumber'
import Curve from '@bsv/sdk/primitives/Curve'
import * as Hash from '@bsv/sdk/primitives/Hash'
import type PrivateKey from '@bsv/sdk/primitives/PrivateKey'
import * as Utils from '@bsv/sdk/primitives/utils'
import Point from '@bsv/sdk/primitives/Point'
import { isBytes, point64, scalar32 } from './encoding.js'

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

const CHALLENGE_TAG = utf8('p sigma v1 challenge')
const OPERATION_CODE = { schnorr: 1, dleq: 2, or: 3 } as const

/** e = LE(SHA256(tag_op || transcript)) mod n; ringSize is required for 'or'. */
export function challengeFor(
  op: 'schnorr' | 'dleq' | 'or',
  transcript: number[],
  ringSize?: number
): BigNumber {
  const tag = [...CHALLENGE_TAG, OPERATION_CODE[op]]
  if (op === 'or') {
    if (ringSize === undefined || !Number.isInteger(ringSize) || ringSize < 1 || ringSize > 255) {
      throw new Error('ring size must be a single byte')
    }
    tag.push(ringSize)
  }
  return challenge([...tag, ...transcript])
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
    const e = challengeFor('schnorr', [...R, ...P, ...ctx])
    const s = k.add(e.mul(x)).umod(n)
    if (!s.isZero()) return [...R, ...scalar32(s)]
  }
}

/** Verifies a Schnorr result against the statement point P. Never throws. */
export function verifySchnorr(P: Point, ctx: number[], result: number[]): boolean {
  try {
    if (!isBytes(result) || result.length !== 96) return false
    const R = readPoint64(result.slice(0, 64))
    const s = readScalar(result.slice(64))
    if (R === undefined || s === undefined) return false
    const e = challengeFor('schnorr', [...result.slice(0, 64), ...point64(P), ...ctx])
    return curve.g.mul(s).eq(R.add(P.mul(e)))
  } catch {
    return false
  }
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
    const e = challengeFor('dleq', [...R1, ...R2, ...P, ...P2, ...Hb, ...ctx])
    const s = k.add(e.mul(x)).umod(n)
    if (!s.isZero()) return [...P2, ...R1, ...R2, ...scalar32(s)]
  }
}

/** Verifies a DLEQ result against the statement points P and H. Never throws. */
export function verifyDleq(P: Point, H: Point, ctx: number[], result: number[]): boolean {
  try {
    if (!isBytes(result) || result.length !== 224) return false
    const P2 = readPoint64(result.slice(0, 64))
    const R1 = readPoint64(result.slice(64, 128))
    const R2 = readPoint64(result.slice(128, 192))
    const s = readScalar(result.slice(192))
    if (P2 === undefined || R1 === undefined || R2 === undefined || s === undefined) return false
    const e = challengeFor('dleq', [
      ...result.slice(64, 192),
      ...point64(P),
      ...result.slice(0, 64),
      ...point64(H),
      ...ctx
    ])
    return curve.g.mul(s).eq(R1.add(P.mul(e))) && H.mul(s).eq(R2.add(P2.mul(e)))
  } catch {
    return false
  }
}

const ringBytes = (ring: Point[]): number[] => ring.flatMap(point64)

/**
 * One-of-n proof (CDS OR-proof) that the prover knows x for the point at 1-based
 * `index` of `ring`. `ring[index - 1]` is trusted to be x·G. Result
 * R_1..R_n || s_1..s_n || e_1..e_(n-1), 64n + 32n + 32(n - 1) bytes.
 */
export function proveOr(x: BigNumber, ring: Point[], index: number, ctx: number[]): number[] {
  const count = ring.length
  if (count < 2 || count > 8 || !Number.isInteger(index) || index < 1 || index > count) {
    throw new Error('invalid ring or index')
  }
  const points = ringBytes(ring)
  const q = requestDigest(3, [count, index, ...points], ctx)
  attempts: for (let a = 0; ; a++) {
    const e: BigNumber[] = []
    const s: BigNumber[] = []
    const R: number[][] = []
    let sum = new BigNumber(0)
    for (let j = 1; j <= count; j++) {
      if (j === index) {
        e.push(new BigNumber(0))
        s.push(new BigNumber(0))
        R.push([])
        continue
      }
      const ej = streamScalar(x, q, a, 2, j)
      const sj = streamScalar(x, q, a, 3, j)
      const Rj = curve.g.mul(sj).add(ring[j - 1].mul(ej).neg())
      if (Rj.isInfinity()) continue attempts
      e.push(ej)
      s.push(sj)
      R.push(point64(Rj))
      sum = sum.add(ej).umod(n)
    }
    const k = streamScalar(x, q, a, 1, index)
    R[index - 1] = point64(curve.g.mul(k))
    const total = challengeFor('or', [...R.flat(), ...points, ...ctx], count)
    const ei = total.sub(sum).umod(n)
    if (ei.isZero()) continue
    const si = k.add(ei.mul(x)).umod(n)
    if (si.isZero()) continue
    e[index - 1] = ei
    s[index - 1] = si
    return [...R.flat(), ...s.flatMap(scalar32), ...e.slice(0, count - 1).flatMap(scalar32)]
  }
}

/** Verifies a one-of-n result against the ring. Never throws. */
export function verifyOr(ring: Point[], ctx: number[], result: number[]): boolean {
  try {
    const count = ring.length
    if (
      count < 2 ||
      count > 8 ||
      !isBytes(result) ||
      result.length !== 64 * count + 32 * count + 32 * (count - 1)
    ) {
      return false
    }
    const R: Point[] = []
    for (let j = 0; j < count; j++) {
      const point = readPoint64(result.slice(64 * j, 64 * j + 64))
      if (point === undefined) return false
      R.push(point)
    }
    const sOffset = 64 * count
    const eOffset = sOffset + 32 * count
    const s: BigNumber[] = []
    for (let j = 0; j < count; j++) {
      const v = readScalar(result.slice(sOffset + 32 * j, sOffset + 32 * j + 32))
      if (v === undefined) return false
      s.push(v)
    }
    const e: BigNumber[] = []
    let sum = new BigNumber(0)
    for (let j = 0; j < count - 1; j++) {
      const v = readScalar(result.slice(eOffset + 32 * j, eOffset + 32 * j + 32))
      if (v === undefined) return false
      e.push(v)
      sum = sum.add(v).umod(n)
    }
    const total = challengeFor(
      'or',
      [...result.slice(0, 64 * count), ...ringBytes(ring), ...ctx],
      count
    )
    const last = total.sub(sum).umod(n)
    if (last.isZero()) return false
    e.push(last)
    for (let j = 0; j < count; j++) {
      if (!curve.g.mul(s[j]).eq(R[j].add(ring[j].mul(e[j])))) return false
    }
    return true
  } catch {
    return false
  }
}
