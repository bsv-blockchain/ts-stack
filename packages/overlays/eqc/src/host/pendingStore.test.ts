import { describe, expect, it } from 'vitest'

import type { Attestation } from '../protocol/attestation.js'
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
    const store = new InMemoryPendingStore({ maxBytes: 80 }, () => 0)
    expect(await store.put(record(1, clientA, 1000, 11))).toBe('too-large')
    expect(await store.put(record(2, clientA, 1000, 6))).toBe('stored')
    expect(await store.put(record(3, clientA, 1000, 4))).toBe('stored')
    expect(await store.put(record(4, clientB, 1000, 1))).toBe('too-many-pending')
  })

  it('never overwrites a stored queryId', async () => {
    // Room for exactly two ten-element records, so a charged duplicate would crowd the second out.
    const store = new InMemoryPendingStore({ maxBytes: 160 }, () => 0)
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
})
