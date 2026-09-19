import { describe, expect, it } from 'vitest'

import { InMemoryReputationStore } from './reputation.js'

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

  it.each(['hash-mismatch', 'bad-signature', 'identity-mismatch', 'diverged-answer'] as const)(
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
