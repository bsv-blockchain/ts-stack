import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KnowledgeStore, MemoryJournal, knowledgeMutation } from '../src/index.js'
import { LookupSourceGuard } from '../src/sources/LookupSourceGuard.js'
import { LookupSourceFraming, lookupSourceCheckpoint } from '../src/sources/LookupSourceFraming.js'
import { normalizeLiveLookupConfiguration } from '../src/sources/LiveLookupConfiguration.js'
import { context } from './evidence-fixture.js'
import { liveFixture, liveStores } from './live-lookup-fixture.js'
import { asyncValues } from '../src/internal/asyncValues.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  jest.restoreAllMocks()
  for await (const close of asyncValues(cleanup.splice(0).reverse())) await close()
})
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), 'lookup-guard-'))
  cleanup.push(() => rm(path, { recursive: true, force: true }))
  const wire = liveFixture()
  const stores = await liveStores(path, wire)
  cleanup.push(
    () => stores.core.close(),
    () => stores.control.close()
  )
  const config = normalizeLiveLookupConfiguration(wire.config)
  const framing = new LookupSourceFraming({ ...config, authentication: 'configured-transport' })
  const batch = framing.fromLookup(wire.packet, wire.open.limits.maxBytes, '1000')
  const guard = new LookupSourceGuard(stores.core, config)
  const empty = { previous: null, previousReceipt: null }
  const signal = new AbortController().signal
  return { wire, stores, config, framing, batch, guard, empty, signal }
}

describe('durable lookup core binding', () => {
  it('rejects a volatile, wrong-journal or wrong-account core', async () => {
    const h = await fixture()
    const volatile = new KnowledgeStore(new MemoryJournal('test'), h.stores.worker, {
      partition: h.config.partition
    })
    expect(() => new LookupSourceGuard(volatile, h.config)).toThrow(
      expect.objectContaining({
        code: 'unsupported',
        message: expect.stringContaining('durable core')
      })
    )
    expect(
      () => new LookupSourceGuard(h.stores.core, { ...h.config, journalId: 'another' })
    ).toThrow(
      expect.objectContaining({
        code: 'context-changed',
        message: expect.stringContaining('binding changed')
      })
    )
    expect(
      () =>
        new LookupSourceGuard(h.stores.core, {
          ...h.config,
          partition: { ...h.config.partition, account: 'another' }
        })
    ).toThrow(
      expect.objectContaining({
        code: 'context-changed',
        message: expect.stringContaining('binding changed')
      })
    )
    await volatile.close()
  })

  it('requires a verification context for the selected partition and chain', async () => {
    const h = await fixture()
    const history = await h.stores.core.inspect()
    const inspect = jest.spyOn(h.stores.core, 'inspect')
    inspect.mockResolvedValueOnce({
      ...history,
      entries: [],
      revision: { received: '0', accepted: '0' }
    })
    await expect(h.guard.inspect('0', undefined, h.signal, h.empty)).rejects.toMatchObject({
      code: 'revision-unavailable'
    })
    for await (const changed of asyncValues([
      { ...context(), partition: { ...h.config.partition, account: 'another' } },
      {
        ...context(),
        view: { ...context().view, chain: { ...h.config.scope.chain, network: 'another' } }
      }
    ])) {
      const entry = {
        ...history.entries[0],
        ...knowledgeMutation({ kind: 'context', context: changed })
      }
      inspect.mockResolvedValueOnce({ ...history, entries: [entry] })
      await expect(h.guard.inspect('1', undefined, h.signal, h.empty)).rejects.toThrow(
        'chain changed'
      )
    }
  })

  it('requires the original receive body, cursor and position, not an arbitrary committed key', async () => {
    const h = await fixture()
    const mutation = knowledgeMutation({ kind: 'receive', batch: h.batch })
    await h.stores.core.commit('1', mutation)
    const previous = lookupSourceCheckpoint(h.batch)
    const valid = { previous, previousReceipt: { key: mutation.key, received: '2' } }
    await expect(h.guard.inspect('2', previous.scope, h.signal, valid)).resolves.toBe('2')
    const history = await h.stores.core.inspect()
    for await (const continuity of asyncValues([
      { ...valid, previousReceipt: { key: mutation.key, received: '1' } },
      { ...valid, previousReceipt: { key: history.entries[0].key, received: '1' } },
      { ...valid, previous: { ...previous, cursor: 'another' } }
    ]))
      await expect(h.guard.inspect('2', previous.scope, h.signal, continuity)).rejects.toThrow(
        'exact core receipt'
      )
  })

  it('ignores unrelated sources and older generations but fences changed epochs and resets', async () => {
    const h = await fixture()
    const history = await h.stores.core.inspect()
    const inspect = jest.spyOn(h.stores.core, 'inspect')
    const check = async (batch: typeof h.batch) => {
      const entry = {
        ...knowledgeMutation({ kind: 'receive', batch }),
        revision: { received: '2', accepted: '1' }
      }
      inspect.mockResolvedValueOnce({
        ...history,
        entries: [...history.entries, entry],
        revision: entry.revision
      })
      return h.guard.inspect('1', h.batch.provenance.scope, h.signal, h.empty)
    }
    const other = structuredClone(h.batch)
    other.provenance.scope.provider = 'https://other.example.test'
    other.coverage.scope.provider = other.provenance.scope.provider
    await expect(check(other)).resolves.toBe('2')
    const older = structuredClone(h.batch)
    older.provenance.generation = '2'
    older.coverage.status = 'reset-required'
    await expect(check(older)).resolves.toBe('2')
    const changed = structuredClone(h.batch)
    changed.provenance.scope.epoch = 'another'
    await expect(check(changed)).rejects.toMatchObject({ code: 'context-changed' })
    const reset = h.framing.reset(lookupSourceCheckpoint(h.batch), '1300')
    await expect(check(reset)).rejects.toMatchObject({ code: 'reset-required' })
  })
})
