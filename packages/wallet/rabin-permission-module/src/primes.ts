import { beToBigint, bigintToBe, bitLength, wipe } from './bytes.js'
import { hkdfExpand, rabinPrimeInfo } from './hkdf.js'

/** First 16 primes. Miller-Rabin witnesses for the BRC-206 probable-prime test. */
export const RABIN_MR_WITNESSES: readonly bigint[] = [
  2n,
  3n,
  5n,
  7n,
  11n,
  13n,
  17n,
  19n,
  23n,
  29n,
  31n,
  37n,
  41n,
  43n,
  47n,
  53n
]

const TRIAL_LIMIT = 4096
const MAX_CANDIDATES = 8192

function sieve(limit: number): number[] {
  const composite = new Uint8Array(limit + 1)
  const primes: number[] = []
  for (let value = 2; value <= limit; value++) {
    if (composite[value] === 1) continue
    primes.push(value)
    for (let multiple = value * value; multiple <= limit; multiple += value) composite[multiple] = 1
  }
  return primes
}

const TRIAL_PRIMES = sieve(TRIAL_LIMIT)

export function mod(value: bigint, modulus: bigint): bigint {
  const remainder = value % modulus
  return remainder >= 0n ? remainder : remainder + modulus
}

export function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  if (modulus <= 0n) throw new RangeError('Rabin: modulus must be positive')
  if (exponent < 0n) throw new RangeError('Rabin: exponent must be non-negative')
  let result = 1n
  let factor = mod(base, modulus)
  let remaining = exponent
  while (remaining > 0n) {
    if ((remaining & 1n) === 1n) result = (result * factor) % modulus
    remaining >>= 1n
    if (remaining > 0n) factor = (factor * factor) % modulus
  }
  return result
}

/**
 * Strong probable-prime test. A candidate is accepted only after trial division by every prime
 * through 4096 and Miller-Rabin at the fixed witnesses above. The same test is the Python checker.
 */
function passesTrialDivision(value: bigint): boolean {
  for (const prime of TRIAL_PRIMES) {
    const small = BigInt(prime)
    if (value === small) return true
    if (value % small === 0n) return false
  }
  return true
}

function splitTwos(even: bigint): { odd: bigint; powers: number } {
  let odd = even
  let powers = 0
  while ((odd & 1n) === 0n) {
    odd >>= 1n
    powers++
  }
  return { odd, powers }
}

function witnessAccepts(value: bigint, odd: bigint, powers: number, witness: bigint): boolean {
  const base = witness % value
  if (base === 0n) return true
  let power = modPow(base, odd, value)
  if (power === 1n || power === value - 1n) return true
  for (let round = 1; round < powers; round++) {
    power = (power * power) % value
    if (power === value - 1n) return true
    if (power === 1n) return false
  }
  return false
}

export function isProbablePrime(value: bigint): boolean {
  if (value < 2n || !passesTrialDivision(value)) return false
  const { odd, powers } = splitTwos(value - 1n)
  for (const witness of RABIN_MR_WITNESSES) {
    if (!witnessAccepts(value, odd, powers, witness)) return false
  }
  return true
}

/**
 * Forces a big-endian block to an exact-width integer ≡ 3 (mod 4) whose top two bits are set.
 * The top-two-bit rule makes the product of the two primes have exactly `2 * primeBits` bits.
 */
export function forcePrimeShape(block: Uint8Array): bigint {
  const shaped = block.slice()
  const first = shaped[0] as number
  const lastIndex = shaped.length - 1
  shaped[0] = first | 0xc0
  shaped[lastIndex] = (shaped[lastIndex] as number) | 0x03
  const value = beToBigint(shaped)
  wipe(shaped)
  return value
}

async function nextPrime(prk: Uint8Array, modulusBits: number, primeIndex: 0 | 1): Promise<bigint> {
  const primeBits = modulusBits / 2
  const byteLength = primeBits / 8
  for (let counter = 0; counter < MAX_CANDIDATES; counter++) {
    const info = rabinPrimeInfo(modulusBits, primeIndex, counter)
    const block = await hkdfExpand(prk, info, byteLength)
    const candidate = forcePrimeShape(block)
    wipe(block)
    if (bitLength(candidate) === primeBits && candidate % 4n === 3n && isProbablePrime(candidate)) {
      return candidate
    }
  }
  throw new Error('Rabin: prime search exceeded 8192 candidates')
}

export interface RabinFactors {
  p: Uint8Array
  q: Uint8Array
  n: bigint
  wipe: () => void
}

/** Derives ordered Rabin factors from an HKDF PRK. `p < q`, both ≡ 3 (mod 4). */
export async function deriveFactors(prk: Uint8Array, modulusBits: number): Promise<RabinFactors> {
  const primeBits = modulusBits / 2
  const byteLength = primeBits / 8
  let first = await nextPrime(prk, modulusBits, 0)
  let second = await nextPrime(prk, modulusBits, 1)
  if (first === second) throw new Error('Rabin: degenerate prime pair')
  if (first > second) {
    const swap = first
    first = second
    second = swap
  }
  const n = first * second
  if (bitLength(n) !== modulusBits)
    throw new Error('Rabin: modulus does not have the requested width')
  const p = bigintToBe(first, byteLength)
  const q = bigintToBe(second, byteLength)
  return {
    p,
    q,
    n,
    wipe() {
      wipe(p)
      wipe(q)
    }
  }
}
