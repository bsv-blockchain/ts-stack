import { describe, expect, it } from 'vitest'

import type { Attestation } from '../protocol/attestation.js'
import { canonicalJson } from '../protocol/canonicalJson.js'
import type { EconomicQuery } from '../protocol/query.js'
import { InMemoryPendingStore, type PendingQuery } from './pendingStore.js'

const clientA = `02${'aa'.repeat(32)}`
const clientB = `02${'bb'.repeat(32)}`

function record(id: number, client: string, expiresAt: number, bytes = 10): PendingQuery {
  return {
    queryId: id.toString(16).padStart(64, '0'),
    query: {} as EconomicQuery,
    clientIdentityKey: client,
    attestation: {} as Attestation,
    payload: Array.from({ length: bytes }, () => 1),
    supplement: [],
    expiresAt,
    state: 'pending'
  }
}

describe('InMemoryPendingStore', () => {
  it('stores and returns records', async () => {
    const store = new InMemoryPendingStore({}, () => 0)
    const entry = record(1, clientA, 1000)
    expect(await store.put(entry)).toBe('stored')
    expect(await store.get(entry.queryId)).toBe(entry)
    expect(await store.get('ff'.repeat(32))).toBeUndefined()
  })

  it('caps pending queries per client without starving other clients', async () => {
    const store = new InMemoryPendingStore({ maxPendingPerClient: 2 }, () => 0)
    expect(await store.put(record(1, clientA, 1000))).toBe('stored')
    expect(await store.put(record(2, clientA, 1000))).toBe('stored')
    expect(await store.put(record(3, clientA, 1000))).toBe('too-many-pending')
    expect(await store.put(record(4, clientB, 1000))).toBe('stored')
  })

  it('rejects rather than evicts live records when full', async () => {
    // maxBytes counts estimated heap: 120 bytes is room for 15 payload elements.
    const store = new InMemoryPendingStore({ maxEntries: 1, maxBytes: 120 }, () => 0)
    expect(await store.put(record(1, clientA, 1000, 20))).toBe('too-large')
    expect(await store.put(record(2, clientA, 1000))).toBe('stored')
    expect(await store.put(record(3, clientB, 1000))).toBe('too-many-pending')
    expect(await store.get(record(2, clientA, 1000).queryId)).toBeDefined()
  })

  it('reclaims room from expired records', async () => {
    let now = 0
    const store = new InMemoryPendingStore({ maxEntries: 1, settledGraceMs: 0 }, () => now)
    expect(await store.put(record(1, clientA, 1000))).toBe('stored')
    now = 1000
    expect(await store.put(record(2, clientB, 2000))).toBe('stored')
    expect(await store.get(record(1, clientA, 1000).queryId)).toBeUndefined()
  })

  it('keeps an expired record visible during the grace period, then forgets it', async () => {
    let now = 0
    const store = new InMemoryPendingStore({ settledGraceMs: 500 }, () => now)
    const entry = record(1, clientA, 1000)
    await store.put(entry)
    await store.beginSettle(entry.queryId)
    await store.completeSettle(entry.queryId)
    now = 1200
    expect(await store.get(entry.queryId)).toBe(entry)
    now = 1500
    expect(await store.get(entry.queryId)).toBeUndefined()
  })

  it('lets exactly one caller settle, and releases the claim on abort', async () => {
    const store = new InMemoryPendingStore({}, () => 0)
    const entry = record(1, clientA, 1000)
    await store.put(entry)
    expect(await store.beginSettle(entry.queryId)).toBe(true)
    expect(await store.beginSettle(entry.queryId)).toBe(false)
    await store.abortSettle(entry.queryId)
    expect(entry.state).toBe('pending')
    expect(await store.beginSettle(entry.queryId)).toBe(true)
    await store.completeSettle(entry.queryId)
    expect(entry.state).toBe('settled')
    expect(entry.payload).toEqual([])
    expect(await store.beginSettle(entry.queryId)).toBe(false)
    expect(await store.beginSettle('ff'.repeat(32))).toBe(false)
  })

  it('frees a settled record from the per-client cap', async () => {
    const store = new InMemoryPendingStore({ maxPendingPerClient: 1 }, () => 0)
    const entry = record(1, clientA, 1000)
    await store.put(entry)
    await store.beginSettle(entry.queryId)
    await store.completeSettle(entry.queryId)
    expect(await store.put(record(2, clientA, 1000))).toBe('stored')
  })

  it('budgets eight estimated heap bytes per cached element', async () => {
    // Each record also carries 4 estimated bytes for its empty stored query: 52 + 36 = 88.
    const store = new InMemoryPendingStore({ maxBytes: 88 }, () => 0)
    expect(await store.put(record(1, clientA, 1000, 11))).toBe('too-large')
    expect(await store.put(record(2, clientA, 1000, 6))).toBe('stored')
    expect(await store.put(record(3, clientA, 1000, 4))).toBe('stored')
    expect(await store.put(record(4, clientB, 1000, 1))).toBe('too-many-pending')
  })

  it('never overwrites a stored queryId', async () => {
    // Room for exactly two ten-element records (80 payload bytes and 4 query bytes each), so a
    // charged duplicate would crowd the second out.
    const store = new InMemoryPendingStore({ maxBytes: 168 }, () => 0)
    const first = record(1, clientA, 1000)
    expect(await store.put(first)).toBe('stored')
    expect(await store.put(record(1, clientA, 5000))).toBe('duplicate')
    expect(await store.get(first.queryId)).toBe(first)

    expect(await store.beginSettle(first.queryId)).toBe(true)
    expect(await store.put(record(1, clientA, 1000))).toBe('duplicate')
    expect(first.state).toBe('settling')
    expect(await store.beginSettle(first.queryId)).toBe(false)

    expect(await store.put(record(2, clientB, 1000))).toBe('stored')
  })

  it('accepts a queryId again once the old record is purge-eligible', async () => {
    let now = 0
    const store = new InMemoryPendingStore({ settledGraceMs: 0 }, () => now)
    expect(await store.put(record(1, clientA, 1000))).toBe('stored')
    expect(await store.put(record(1, clientA, 1000))).toBe('duplicate')
    now = 1000
    const replacement = record(1, clientA, 2000)
    expect(await store.put(replacement)).toBe('stored')
    expect(await store.get(replacement.queryId)).toBe(replacement)
  })

  it('budgets the stored query, so bloated params cannot ride the free path', async () => {
    const junk = 'x'.repeat(60 * 1024)
    const bloated = (id: number, client: string): PendingQuery => ({
      ...record(id, client, 1000, 1),
      query: { type: 'relay-lookup', params: { key: 'k', junk } } as unknown as EconomicQuery
    })
    // One record: 8 payload bytes plus two estimated bytes per canonical character of the query.
    const one = 8 + canonicalJson(bloated(1, clientA).query).length * 2
    expect(one).toBeGreaterThan(120 * 1024)

    const tight = new InMemoryPendingStore({ maxBytes: one - 1 }, () => 0)
    expect(await tight.put(bloated(1, clientA))).toBe('too-large')
    expect(await tight.put(record(2, clientA, 1000, 1))).toBe('stored')

    const store = new InMemoryPendingStore({ maxBytes: one * 2 }, () => 0)
    expect(await store.put(bloated(1, clientA))).toBe('stored')
    expect(await store.put(bloated(2, clientB))).toBe('stored')
    expect(await store.put(record(3, clientB, 1000, 1))).toBe('too-many-pending')
  })

  it('keeps charging the stored query after settlement wipes the payload', async () => {
    const junk = 'x'.repeat(1000)
    const entry: PendingQuery = {
      ...record(1, clientA, 1000, 10),
      query: { params: { junk } } as unknown as EconomicQuery
    }
    const queryBytes = canonicalJson(entry.query).length * 2
    const store = new InMemoryPendingStore({ maxBytes: queryBytes + 80 + 12 }, () => 0)
    expect(await store.put(entry)).toBe('stored')
    expect(await store.put(record(2, clientB, 1000, 2))).toBe('too-many-pending')
    await store.beginSettle(entry.queryId)
    await store.completeSettle(entry.queryId)
    // The 80 payload bytes are free again; the tombstone still holds its query.
    expect(await store.put(record(3, clientB, 1000, 1))).toBe('stored')
    expect(await store.put(record(4, clientB, 1000, 10))).toBe('too-many-pending')
  })

  describe('an unsettled record whose expiry has passed', () => {
    it('releases its bytes on the next put and still answers get through the grace', async () => {
      let now = 0
      // Room for one ten-element record and its empty query.
      const store = new InMemoryPendingStore({ maxBytes: 84 + 4, settledGraceMs: 500 }, () => now)
      const entry = record(1, clientA, 1000)
      expect(await store.put(entry)).toBe('stored')
      expect(await store.put(record(2, clientB, 1000))).toBe('too-many-pending')
      now = 1000
      expect(await store.put(record(3, clientB, 2000))).toBe('stored')
      expect(entry.payload).toEqual([])
      expect(entry.supplement).toEqual([])
      expect(await store.get(entry.queryId)).toBe(entry)
      expect(entry.state).toBe('pending')
      now = 1500
      expect(await store.get(entry.queryId)).toBeUndefined()
    })

    it('stops counting toward the per-client cap at once, without waiting for the grace', async () => {
      let now = 0
      const store = new InMemoryPendingStore(
        { maxPendingPerClient: 1, settledGraceMs: 60_000 },
        () => now
      )
      expect(await store.put(record(1, clientA, 1000))).toBe('stored')
      now = 999
      expect(await store.put(record(2, clientA, 5000))).toBe('too-many-pending')
      now = 1000
      expect(await store.put(record(2, clientA, 5000))).toBe('stored')
    })

    it('still counts toward maxEntries until the grace has passed', async () => {
      let now = 0
      const store = new InMemoryPendingStore({ maxEntries: 1, settledGraceMs: 500 }, () => now)
      expect(await store.put(record(1, clientA, 1000))).toBe('stored')
      now = 1000
      expect(await store.put(record(2, clientB, 5000))).toBe('too-many-pending')
      now = 1500
      expect(await store.put(record(2, clientB, 5000))).toBe('stored')
    })

    it('is released by get', async () => {
      let now = 0
      const store = new InMemoryPendingStore({ settledGraceMs: 500 }, () => now)
      const entry = record(1, clientA, 1000)
      await store.put(entry)
      now = 999
      expect((await store.get(entry.queryId))?.payload).toHaveLength(10)
      now = 1000
      expect((await store.get(entry.queryId))?.payload).toEqual([])
    })

    it('is refused and released by beginSettle', async () => {
      let now = 0
      const store = new InMemoryPendingStore({ maxBytes: 88, settledGraceMs: 500 }, () => now)
      const entry = record(1, clientA, 1000)
      await store.put(entry)
      now = 1000
      expect(await store.beginSettle(entry.queryId)).toBe(false)
      expect(entry.state).toBe('pending')
      expect(entry.payload).toEqual([])
      expect(await store.put(record(2, clientB, 5000))).toBe('stored')
    })

    it('is released while settling, and a late completeSettle does not free the bytes twice', async () => {
      let now = 0
      const store = new InMemoryPendingStore({ maxBytes: 88, settledGraceMs: 500 }, () => now)
      const entry = record(1, clientA, 1000)
      await store.put(entry)
      expect(await store.beginSettle(entry.queryId)).toBe(true)
      now = 1000
      // The first put releases the settling record; its 80 bytes make room for this one.
      expect(await store.put(record(2, clientB, 5000))).toBe('stored')
      expect(entry.payload).toEqual([])
      await store.completeSettle(entry.queryId)
      expect(entry.state).toBe('settled')
      // A double subtraction would leave the budget 80 bytes too generous and admit this record.
      expect(await store.put(record(3, clientB, 5000))).toBe('too-many-pending')
    })

    it('is released only once however often it is touched', async () => {
      let now = 0
      const store = new InMemoryPendingStore({ maxBytes: 88, settledGraceMs: 500 }, () => now)
      const entry = record(1, clientA, 1000)
      await store.put(entry)
      now = 1000
      await store.get(entry.queryId)
      await store.get(entry.queryId)
      expect(await store.beginSettle(entry.queryId)).toBe(false)
      expect(await store.put(record(2, clientB, 5000))).toBe('stored')
      expect(await store.put(record(3, clientB, 5000))).toBe('too-many-pending')
    })
  })
})
