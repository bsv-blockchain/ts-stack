import { beToBigint, leToBigint } from './bytes.js'
import { RABIN_HKDF_SALT, hkdfExtract, sha256 } from './hkdf.js'
import { deriveFactors, mod, modPow, type RabinFactors } from './primes.js'
import { RABIN_PADDING_LIMIT } from './scriptNumber.js'

export type RabinModulusBits = 2048 | 3072 | 4096

export function isRabinModulusBits(value: number): value is RabinModulusBits {
  return value === 2048 || value === 3072 || value === 4096
}

/** Jacobi/Euler test. Zero is a residue so the square-root algorithm stays defined. */
export function isQuadraticResidue(value: bigint, prime: bigint): boolean {
  const reduced = mod(value, prime)
  if (reduced === 0n) return true
  return modPow(reduced, (prime - 1n) / 2n, prime) === 1n
}

/**
 * Principal CRT root. Each prime root is the canonical exponentiation root
 * `a^((p+1)/4) mod p` for `p ≡ 3 (mod 4)`, combined with the explicit two-prime CRT
 * used by Rúnar's signer. The result is the unique root in `[0, n)`.
 */
export function principalCrtRoot(rootModP: bigint, p: bigint, rootModQ: bigint, q: bigint): bigint {
  const n = p * q
  const inverseQ = modPow(q, p - 2n, p)
  const inverseP = modPow(p, q - 2n, q)
  return mod(rootModP * q * inverseQ + rootModQ * p * inverseP, n)
}

export interface RabinSignature {
  signature: bigint
  padding: bigint
  modulus: bigint
}

/**
 * Canonical Rabin signature: the smallest padding in `[0, 65536)` whose residue has a square
 * root, and the principal CRT root of that residue. Verification is
 * `(signature^2 + padding) mod n == LE(SHA-256(message))`.
 */
export async function rabinSign(
  message: Uint8Array,
  p: bigint,
  q: bigint
): Promise<RabinSignature> {
  if (p >= q) throw new Error('Rabin: primes must satisfy p < q')
  if (p % 4n !== 3n || q % 4n !== 3n) throw new Error('Rabin: primes must be 3 mod 4')
  const modulus = p * q
  const digest = await sha256(message)
  const hash = leToBigint(digest)
  const hashMod = mod(hash, modulus)
  for (let padding = 0n; padding < RABIN_PADDING_LIMIT; padding++) {
    const target = mod(hashMod - padding, modulus)
    if (!isQuadraticResidue(target, p) || !isQuadraticResidue(target, q)) continue
    const rootP = modPow(target, (p + 1n) / 4n, p)
    const rootQ = modPow(target, (q + 1n) / 4n, q)
    const signature = principalCrtRoot(rootP, p, rootQ, q)
    if (mod(signature * signature + padding, modulus) !== hashMod) {
      throw new Error('Rabin: principal CRT root failed verification')
    }
    return { signature, padding, modulus }
  }
  throw new Error('Rabin: no padding below 65536 makes the digest a quadratic residue')
}

/** Rúnar verification, including the on-chain padding bound that rejects the zero-signature forgery. */
export async function verifyRabinSignature(
  message: Uint8Array,
  signature: bigint,
  padding: bigint,
  modulus: bigint
): Promise<boolean> {
  if (modulus <= 0n || signature < 0n || padding < 0n || padding >= RABIN_PADDING_LIMIT)
    return false
  const hash = leToBigint(await sha256(message))
  return mod(signature * signature + padding, modulus) === mod(hash, modulus)
}

/** BRC-206 key derivation from the 32-byte BRC-42 scalar. Returns factors the caller must wipe. */
export async function deriveRabinFactors(
  seed: Uint8Array,
  bits: RabinModulusBits
): Promise<RabinFactors> {
  if (!isRabinModulusBits(bits)) {
    throw new Error('Rabin: modulus size must be 2048, 3072, or 4096')
  }
  if (seed.length !== 32) throw new Error('Rabin: seed must be 32 bytes')
  const prk = await hkdfExtract(RABIN_HKDF_SALT, seed)
  try {
    return await deriveFactors(prk, bits)
  } finally {
    prk.fill(0)
  }
}

export function factorsToBigints(factors: RabinFactors): { p: bigint; q: bigint; n: bigint } {
  return { p: beToBigint(factors.p), q: beToBigint(factors.q), n: factors.n }
}
