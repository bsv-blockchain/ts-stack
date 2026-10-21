import { createHash } from 'node:crypto'
import { IncrementalSieve, isAcceptedPrime, nextAcceptedPrime, SMALL_PRIMES } from '../rabin.js'

const hasSmallFactor = (x: bigint): boolean => SMALL_PRIMES.some(prime => x % BigInt(prime) === 0n)

const start = (seed: string, bits: number): bigint => {
  const digest = createHash('sha256').update(seed).digest('hex')
  const top = 1n << BigInt(bits - 1)
  return (BigInt(`0x${digest}`) % top) | top | (1n << BigInt(bits - 2)) | 3n
}

describe('incremental trial division', () => {
  it('agrees with direct trial division for every prime, including 2 and 3', () => {
    // 7 ≡ 1 (mod 3): stepping by 4 reaches a multiple of 3 every third candidate.
    const starts = [7n, 11n, 65539n, start('a', 64), start('b', 512), start('c', 1024)]
    for (const x0 of starts) {
      const sieve = IncrementalSieve.from(x0)
      for (let step = 0, x = x0; step < 300; step++, x += 4n) {
        expect([x, sieve.hasSmallFactor()]).toEqual([x, hasSmallFactor(x)])
        sieve.advance()
      }
    }
  }, 30_000)

  it('finds the same prime as a naive isAcceptedPrime search', () => {
    const starts = [start('x', 48), start('y', 48), start('z', 48), 0xc000_0000_0003n + 4n]
    for (let i = 0; i < 20; i++) starts.push(start(`random ${i}`, 48))
    for (const x0 of starts) {
      let naive = x0
      while (!isAcceptedPrime(naive)) naive += 4n
      expect(nextAcceptedPrime(x0, 48)).toBe(naive)
    }
  })
})
