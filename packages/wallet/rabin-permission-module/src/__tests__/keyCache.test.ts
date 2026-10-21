import { KeyCache } from '../keyCache.js'
import type { RabinKey } from '../rabin.js'

const key = (i: number): RabinKey => ({
  bits: 2048,
  p: BigInt(1000 + i),
  q: BigInt(2000 + i),
  n: BigInt(3000 + i),
  pInvModQ: BigInt(i)
})

describe('KeyCache', () => {
  it('returns copies, so callers cannot alter or observe the stored key', () => {
    const cache = new KeyCache(32, 8)
    cache.set('a', key(1), 'app.example')
    const first = cache.get('a')!
    first.q = 0n
    expect(cache.get('a')!.q).toBe(2001n)
    expect(cache.get('missing')).toBeUndefined()
  })

  it('evicts an originator’s own least recently used key at its cap and leaves others alone', () => {
    const cache = new KeyCache(32, 8)
    for (let i = 0; i < 3; i++) cache.set(`other ${i}`, key(100 + i), 'other.example')
    const entries: RabinKey[] = []
    for (let i = 0; i < 8; i++) {
      const stored = key(i)
      entries.push(stored)
      cache.set(`flood ${i}`, stored, 'flood.example')
    }
    cache.get('flood 0') // flood 1 is now the least recently used flood key
    cache.set('flood 8', key(8), 'flood.example')

    expect(cache.countFor('flood.example')).toBe(8)
    expect(cache.get('flood 1')).toBeUndefined()
    expect(cache.get('flood 0')).toBeDefined()
    expect(cache.countFor('other.example')).toBe(3)
    // The evicted primes were overwritten before the reference was dropped.
    expect(entries[1]).toMatchObject({ p: 0n, q: 0n, n: 0n, pInvModQ: 0n })
  })

  it('evicts the global least recently used key at capacity', () => {
    const cache = new KeyCache(32, 8)
    const first: RabinKey[] = []
    for (let o = 0; o < 4; o++) {
      for (let i = 0; i < 8; i++) {
        const stored = key(o * 8 + i)
        if (o === 0 && i === 0) first.push(stored)
        cache.set(`${o}:${i}`, stored, `app-${o}.example`)
      }
    }
    expect(cache.size).toBe(32)
    cache.set('new', key(99), 'new.example')
    expect(cache.size).toBe(32)
    expect(cache.get('0:0')).toBeUndefined()
    expect(first[0].p).toBe(0n)
    expect(cache.get('0:1')).toBeDefined()
  })

  it('counts a shared identity once, for the originator that generated it', () => {
    const cache = new KeyCache(32, 8)
    cache.set('shared', key(1), 'first.example')
    expect(cache.get('shared')).toBeDefined()
    expect(cache.countFor('first.example')).toBe(1)
    expect(cache.countFor('second.example')).toBe(0)
  })

  it('zeroes every key on clear', () => {
    const cache = new KeyCache(32, 8)
    const stored = key(1)
    cache.set('a', stored, 'app.example')
    cache.clear()
    expect(cache.size).toBe(0)
    expect(stored.p).toBe(0n)
  })
})
