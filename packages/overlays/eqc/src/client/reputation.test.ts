import { describe, expect, it } from 'vitest'

import { InMemoryReputationStore, orderByScore } from './reputation.js'

const url = 'https://host.example'

describe('InMemoryReputationStore', () => {
  it('starts neutral', () => {
    const store = new InMemoryReputationStore()
    expect(store.score(url)).toBe(0)
    expect(store.isExcluded(url, 0)).toBe(false)
  })

  it('scores success up and soft failures down without excluding', () => {
    const store = new InMemoryReputationStore()
    store.record(url, 'success', 0)
    store.record(url, 'success', 0)
    store.record(url, 'timeout', 0)
    store.record(url, 'late', 0)
    store.record(url, 'lagging', 0)
    expect(store.score(url)).toBe(-1)
    expect(store.isExcluded(url, 0)).toBe(false)
  })

  it('does not exclude on diverged-answer, which rests on anchors the winners report themselves', () => {
    const store = new InMemoryReputationStore()
    for (let count = 0; count < 50; count++) store.record(url, 'diverged-answer', 0)
    expect(store.score(url)).toBe(-50)
    expect(store.isExcluded(url, 0)).toBe(false)
  })

  it('does not exclude on unadvertised-identity, which rests on a third party advertisement', () => {
    const store = new InMemoryReputationStore()
    store.record(url, 'unadvertised-identity', 0)
    expect(store.score(url)).toBe(-1)
    expect(store.isExcluded(url, 0)).toBe(false)
  })

  it.each(['hash-mismatch', 'bad-signature', 'identity-mismatch', 'collect-failed'] as const)(
    'excludes a host for the cooldown after %s',
    event => {
      const store = new InMemoryReputationStore(1000)
      store.record(url, event, 500)
      expect(store.isExcluded(url, 1499)).toBe(true)
      expect(store.isExcluded(url, 1500)).toBe(false)
      expect(store.score(url)).toBeLessThan(0)
    }
  )

  it('defaults to a ten minute cooldown', () => {
    const store = new InMemoryReputationStore()
    store.record(url, 'hash-mismatch', 0)
    expect(store.isExcluded(url, 599_999)).toBe(true)
    expect(store.isExcluded(url, 600_000)).toBe(false)
  })
})

describe('orderByScore', () => {
  const scores: Record<string, number> = { a: 1, b: 1, c: 1, d: 0, e: 0, f: -1 }
  const items = Object.keys(scores)
  const score = (item: string): number => scores[item]

  it('keeps every higher-scored host ahead of every lower one, whatever the shuffle', () => {
    for (let run = 0; run < 200; run++) {
      const ordered = orderByScore(items, score)
      expect([...ordered].sort()).toEqual(items)
      expect(ordered.map(score)).toEqual([1, 1, 1, 0, 0, -1])
    }
  })

  it('shuffles hosts of equal score, so tracker order does not decide who is contacted', () => {
    const firsts = new Set<string>()
    for (let run = 0; run < 200; run++) firsts.add(orderByScore(items, score)[0])
    expect([...firsts].sort()).toEqual(['a', 'b', 'c'])
  })

  it('is a Fisher-Yates shuffle over the random source it is given', () => {
    // Always choosing index 0 rotates a run of equals left by one: [a, b, c] becomes [b, c, a].
    expect(orderByScore(items, score, () => 0)).toEqual(['b', 'c', 'a', 'e', 'd', 'f'])
    // Always choosing the last index leaves every element where it is.
    expect(orderByScore(items, score, bound => bound - 1)).toEqual(items)
  })

  it('does not reorder its input and handles the empty list', () => {
    const input = [...items]
    orderByScore(input, score)
    expect(input).toEqual(items)
    expect(orderByScore([], score)).toEqual([])
  })
})
