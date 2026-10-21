/**
 * BRC-206 Rabin arithmetic: seed expansion, deterministic prime generation, canonical signing and
 * verification. Pure functions over bigint; the only dependency is @bsv/sdk's SHA-256 and HMAC, so
 * this file runs unchanged in Node and in browsers.
 *
 * The expensive operations are generators (`…Steps`) that pause every few dozen exponent bits or
 * sieve candidates, so a caller can drive them in short slices (see `scheduling.ts`). The plain
 * functions drive the same generators synchronously and return identical results.
 */
import { sha256, sha256hmac } from '@bsv/sdk/primitives/Hash'
import { runSync, type Steps } from './scheduling.js'
import type { RabinBits } from './types.js'

/** Exponent bits processed between pauses: about 0.2 ms for a 2048-bit modulus. */
const EXPONENT_BITS_PER_STEP = 32
/** Sieve candidates processed between pauses. */
const SIEVE_CANDIDATES_PER_STEP = 8
/** Small-prime residues computed between pauses while a sieve is built. */
const RESIDUES_PER_STEP = 1024

/** HKDF salt, and the prefix of the HKDF info string. */
export const DOMAIN_SALT = 'p rabin v1'
export const SUPPORTED_BITS: readonly RabinBits[] = Object.freeze([2048, 3072, 4096])
/** Exclusive upper bound on the padding, enforced on chain. */
export const PADDING_LIMIT = 65536n

const SIEVE_LIMIT = 1 << 16
const MR_BASE_COUNT = 32

function sieve(limit: number): number[] {
  const composite = new Uint8Array(limit)
  const primes: number[] = []
  for (let i = 2; i < limit; i++) {
    if (composite[i] !== 0) continue
    primes.push(i)
    for (let j = i * i; j < limit; j += i) composite[j] = 1
  }
  return primes
}

/** Every prime below 2^16 (6542 primes, 2 through 65521), used for normative trial division. */
export const SMALL_PRIMES: readonly number[] = Object.freeze(sieve(SIEVE_LIMIT))
/** The 32 Miller–Rabin bases: the first 32 primes, 2 through 131. */
export const MR_BASES: readonly bigint[] = Object.freeze(
  SMALL_PRIMES.slice(0, MR_BASE_COUNT).map(BigInt)
)

/** A generated Rabin private key. `p` and `q` never leave trusted module code. */
export interface RabinKey {
  bits: RabinBits
  p: bigint
  q: bigint
  n: bigint
  /** p⁻¹ mod q, for the CRT step. */
  pInvModQ: bigint
}

const UTF8 = new TextEncoder()

function beToBigInt(bytes: Iterable<number>): bigint {
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  return value
}

function leToBigInt(bytes: ArrayLike<number>): bigint {
  let value = 0n
  for (let i = bytes.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i])
  return value
}

function bitLength(value: bigint): number {
  return value === 0n ? 0 : value.toString(2).length
}

/** `base^exponent mod modulus` for a positive modulus and non-negative exponent, in steps. */
export function* modPowSteps(base: bigint, exponent: bigint, modulus: bigint): Steps<bigint> {
  if (modulus === 1n) return 0n
  let result = 1n
  let b = ((base % modulus) + modulus) % modulus
  let e = exponent
  let bits = 0
  while (e > 0n) {
    if ((e & 1n) === 1n) result = (result * b) % modulus
    e >>= 1n
    b = (b * b) % modulus
    bits++
    if (bits % EXPONENT_BITS_PER_STEP === 0) yield
  }
  return result
}

/** `base^exponent mod modulus` for a positive modulus and non-negative exponent. */
export function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  return runSync(modPowSteps(base, exponent, modulus))
}

function modInverse(a: bigint, m: bigint): bigint {
  let [oldR, r] = [((a % m) + m) % m, m]
  let [oldS, s] = [1n, 0n]
  while (r !== 0n) {
    const quotient = oldR / r
    ;[oldR, r] = [r, oldR - quotient * r]
    ;[oldS, s] = [s, oldS - quotient * s]
  }
  if (oldR !== 1n) throw new Error('RABIN: value is not invertible')
  return ((oldS % m) + m) % m
}

/** One Miller–Rabin round for odd `x` > `base`, as BRC-206 defines it, in steps. */
export function* millerRabinSteps(x: bigint, base: bigint): Steps<boolean> {
  let d = x - 1n
  let s = 0
  while ((d & 1n) === 0n) {
    d >>= 1n
    s++
  }
  let y = yield* modPowSteps(base, d, x)
  if (y === 1n || y === x - 1n) return true
  for (let i = 1; i < s; i++) {
    y = (y * y) % x
    if (y === x - 1n) return true
    if (i % EXPONENT_BITS_PER_STEP === 0) yield
  }
  return false
}

/** One Miller–Rabin round for odd `x` > `base`, as BRC-206 defines it. */
export function millerRabin(x: bigint, base: bigint): boolean {
  return runSync(millerRabinSteps(x, base))
}

/**
 * The normative primality test: an odd integer with no prime factor below 2^16 that passes
 * Miller–Rabin for each of the 32 fixed bases.
 */
export function isAcceptedPrime(x: bigint): boolean {
  if (x <= 1n << 16n || (x & 1n) === 0n) return false
  for (const prime of SMALL_PRIMES) if (x % BigInt(prime) === 0n) return false
  return MR_BASES.every(base => millerRabin(x, base))
}

/**
 * Trial division for the candidates x0, x0 + 4, x0 + 8, …: keeps x mod p for every small prime and
 * updates the residues as the candidate advances, instead of dividing each candidate.
 */
export class IncrementalSieve {
  readonly #residues: Int32Array

  private constructor(residues: Int32Array) {
    this.#residues = residues
  }

  /** Builds the sieve for x0 in steps. */
  static *build(x0: bigint): Steps<IncrementalSieve> {
    const residues = new Int32Array(SMALL_PRIMES.length)
    for (let i = 0; i < SMALL_PRIMES.length; i++) {
      residues[i] = Number(x0 % BigInt(SMALL_PRIMES[i]))
      if ((i + 1) % RESIDUES_PER_STEP === 0) yield
    }
    return new IncrementalSieve(residues)
  }

  /** Builds the sieve for x0. */
  static from(x0: bigint): IncrementalSieve {
    return runSync(IncrementalSieve.build(x0))
  }

  /** True when the current candidate has a prime factor below 2^16. */
  hasSmallFactor(): boolean {
    return this.#residues.includes(0)
  }

  /** Moves to the next candidate, x + 4. */
  advance(): void {
    // A modulo, not a single subtraction: for 2 and 3 the step 4 exceeds the prime.
    for (let i = 0; i < this.#residues.length; i++) {
      this.#residues[i] = (this.#residues[i] + 4) % SMALL_PRIMES[i]
    }
  }
}

/**
 * First accepted prime among x0, x0 + 4, x0 + 8, … below 2^k, in steps. The result is identical
 * to calling `isAcceptedPrime` on each candidate in turn.
 */
export function* nextAcceptedPrimeSteps(x0: bigint, k: number): Steps<bigint> {
  const limit = 1n << BigInt(k)
  const sieve = yield* IncrementalSieve.build(x0)
  let x = x0
  let candidates = 0
  while (x < limit) {
    if (!sieve.hasSmallFactor() && (yield* passesMillerRabinSteps(x))) return x
    sieve.advance()
    x += 4n
    candidates++
    if (candidates % SIEVE_CANDIDATES_PER_STEP === 0) yield
  }
  throw new Error('RABIN: key generation failed: prime search exceeded 2^k')
}

/** Miller–Rabin for every one of the 32 fixed bases, stopping at the first failure, in steps. */
function* passesMillerRabinSteps(x: bigint): Steps<boolean> {
  for (const base of MR_BASES) {
    if (!(yield* millerRabinSteps(x, base))) return false
  }
  return true
}

/** First accepted prime among x0, x0 + 4, x0 + 8, … below 2^k. */
export function nextAcceptedPrime(x0: bigint, k: number): bigint {
  return runSync(nextAcceptedPrimeSteps(x0, k))
}

function assertBits(bits: unknown): asserts bits is RabinBits {
  if (!SUPPORTED_BITS.includes(bits as RabinBits)) {
    throw new RangeError('RABIN: bits must be 2048, 3072, or 4096')
  }
}

/** HKDF-SHA256 (RFC 5869): salt `p rabin v1`, info `p rabin v1 <bits>`, output bits/8 bytes. */
export function expandSeed(seed: ArrayLike<number>, bits: RabinBits): Uint8Array {
  assertBits(bits)
  if (seed.length !== 32) throw new RangeError('RABIN: the seed must be 32 bytes')
  const length = bits / 8
  const prk = sha256hmac(Array.from(UTF8.encode(DOMAIN_SALT)), Array.from(seed))
  const info = Array.from(UTF8.encode(`${DOMAIN_SALT} ${bits}`))
  const okm = new Uint8Array(length)
  // T(i) = HMAC(PRK, T(i-1) || info || i), concatenated until `length` bytes.
  let block: number[] = []
  let offset = 0
  let counter = 1
  while (offset < length) {
    block = sha256hmac(prk, [...block, ...info, counter])
    const take = Math.min(block.length, length - offset)
    okm.set(block.slice(0, take), offset)
    offset += take
    counter++
  }
  prk.fill(0)
  block.fill(0)
  return okm
}

function startingCandidate(bytes: Uint8Array, k: number): bigint {
  return beToBigInt(bytes) | (1n << BigInt(k - 1)) | (1n << BigInt(k - 2)) | 3n
}

/** Applies the BRC-206 rejection rules to a prime pair and builds the key. */
export function assembleKey(p: bigint, q: bigint, bits: RabinBits): RabinKey {
  assertBits(bits)
  const k = bits / 2
  if (p === q) throw new Error('RABIN: key generation failed: p equals q')
  const difference = p > q ? p - q : q - p
  if (difference <= 1n << BigInt(k - 100)) {
    throw new Error('RABIN: key generation failed: p and q are too close')
  }
  const n = p * q
  if (bitLength(n) !== bits) {
    throw new Error('RABIN: key generation failed: the modulus has the wrong size')
  }
  return { bits, p, q, n, pInvModQ: modInverse(p % q, q) }
}

/** Deterministic key generation from a 32-byte seed, in steps. */
export function* generateKeySteps(seed: ArrayLike<number>, bits: RabinBits): Steps<RabinKey> {
  assertBits(bits)
  const k = bits / 2
  const okm = expandSeed(seed, bits)
  try {
    const p = yield* nextAcceptedPrimeSteps(startingCandidate(okm.subarray(0, k / 8), k), k)
    const q = yield* nextAcceptedPrimeSteps(startingCandidate(okm.subarray(k / 8, k / 4), k), k)
    return assembleKey(p, q, bits)
  } finally {
    okm.fill(0)
  }
}

/** Deterministic key generation from a 32-byte seed. */
export function generateKey(seed: ArrayLike<number>, bits: RabinBits): RabinKey {
  return runSync(generateKeySteps(seed, bits))
}

/** `LE_uint256(SHA-256(message))`: the digest read as Bitcoin Script reads `OP_SHA256` output. */
export function digestValue(message: ArrayLike<number>): bigint {
  return leToBigInt(sha256(Uint8Array.from(message)))
}

/** Euler's criterion for `t` already reduced mod `prime`; `t ≡ 0` counts as a residue. */
function* isResidueSteps(t: bigint, prime: bigint): Steps<boolean> {
  return t === 0n || (yield* modPowSteps(t, (prime - 1n) >> 1n, prime)) === 1n
}

/**
 * The canonical BRC-206 signature, in steps: the smallest padding u for which h − u is a square
 * modulo p and modulo q, with the CRT combination of the principal roots. A pure function of
 * (p, q, M).
 */
export function* signSteps(
  message: ArrayLike<number>,
  key: RabinKey
): Steps<{ sig: bigint; padding: bigint }> {
  const { p, q, n, pInvModQ } = key
  const h = digestValue(message)
  if (h >= n) throw new Error('RABIN: signing failed: the digest is not below the modulus')
  for (let u = 0n; u < PADDING_LIMIT; u++) {
    const t = (((h - u) % n) + n) % n
    const tp = t % p
    if (!(yield* isResidueSteps(tp, p))) continue
    const tq = t % q
    if (!(yield* isResidueSteps(tq, q))) continue
    const sp = yield* modPowSteps(tp, (p + 1n) >> 2n, p)
    const sq = yield* modPowSteps(tq, (q + 1n) >> 2n, q)
    const sig = sp + p * ((((((sq - sp) % q) + q) % q) * pInvModQ) % q)
    // Never release a value that does not verify, for example after a computation fault.
    if (sig >= n || (sig * sig + u) % n !== h) throw new Error('RABIN: signing failed')
    return { sig, padding: u }
  }
  throw new Error('RABIN: signing failed: no padding below 65536')
}

/** The canonical BRC-206 signature; see `signSteps`. */
export function sign(message: ArrayLike<number>, key: RabinKey): { sig: bigint; padding: bigint } {
  return runSync(signSteps(message, key))
}

/**
 * Off-chain verification with the on-chain equation: `0 ≤ padding < 65536`, `0 ≤ sig < n`, and
 * `(sig² + padding) mod n == LE_uint256(SHA-256(message))`, the right-hand side not reduced.
 */
export function verify(
  message: ArrayLike<number>,
  sig: bigint,
  padding: bigint,
  n: bigint
): boolean {
  if (typeof sig !== 'bigint' || typeof padding !== 'bigint' || typeof n !== 'bigint') return false
  if (n <= 0n || padding < 0n || padding >= PADDING_LIMIT || sig < 0n || sig >= n) return false
  return (sig * sig + padding) % n === digestValue(message)
}
