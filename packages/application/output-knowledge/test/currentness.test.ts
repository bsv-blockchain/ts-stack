import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  BitcoinKnowledge,
  KnowledgeStore,
  MemoryJournal,
  OutputKnowledge,
  SDKEvidenceVerifier,
  knowledgeMutation,
  parseSourceCurrentnessRules,
  type SourceCurrentnessRule,
  type JournalStorage,
  type Currentness,
  type SourceBatch,
  type OutputObservation,
  type OutputScope
} from '../src/index.js'
import { SQLiteJournal } from '../src/storage/SQLiteJournal.js'
import { chain, partition, context, candidate, corpus, resolver } from './evidence-fixture.js'

const base = Math.floor(Date.now() / 1000) * 1000
const abort = () => new AbortController().signal
const scope = (provider = 'host-a'): OutputScope => ({
  chain,
  provider,
  service: 'unspent-index',
  queryDigest: '11'.repeat(32),
  rulesDigest: '22'.repeat(32),
  access: 'public',
  epoch: 'epoch-one'
})
const rule = (provider = 'host-a', maximumAgeSeconds = '2'): SourceCurrentnessRule => {
  const { epoch: _epoch, ...source } = scope(provider)
  return { source, maximumAgeSeconds }
}
const stores: KnowledgeStore[] = [],
  directories: string[] = []
afterEach(async () => {
  jest.useRealTimers()
  for (const store of stores.splice(0)) await store.close()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function output(name = 'A', id = 'a', provider = 'host-a'): OutputObservation {
  return {
    id,
    scope: scope(provider),
    kind: 'output',
    payload: { evidence: candidate(name).evidence }
  }
}
function batch(
  id: string,
  observations: OutputObservation[],
  now: number,
  provider = 'host-a',
  generation = '0',
  sequence = '1'
): SourceBatch {
  const selected = scope(provider)
  return {
    provenance: {
      partition,
      generation,
      adapter: provider,
      scope: selected,
      authentication: 'configured-transport',
      peer: provider,
      receivedAt: String(Math.floor(now / 1000))
    },
    groups: [{ id, sequence, observations }],
    coverage: {
      scope: selected,
      phase: sequence === '1' ? 'snapshot' : 'live',
      status: 'complete',
      through: sequence,
      highWater: sequence
    }
  }
}
function open(
  storage: JournalStorage = new MemoryJournal('test'),
  rules = [rule()],
  clock = { now: base },
  offline = false,
  nonFinal = true
) {
  const worker = new BitcoinKnowledge({
    journalId: storage.namespace,
    partition,
    nonFinal,
    sourceCurrentness: rules,
    now: () => clock.now,
    verifier: offline
      ? {
          async verify() {
            throw new Error('Offline journal replay must not verify')
          }
        }
      : new SDKEvidenceVerifier(resolver)
  })
  const store = new KnowledgeStore(storage, worker, { partition, now: () => clock.now })
  stores.push(store)
  return { worker, store, clock }
}
async function initialize(store: KnowledgeStore) {
  await store.commit('0', knowledgeMutation({ kind: 'context', context: context() }))
}
async function ingest(store: KnowledgeStore, worker: BitcoinKnowledge, value: SourceBatch) {
  await store.commit(
    (await store.revision()).received,
    knowledgeMutation({ kind: 'receive', batch: value })
  )
  await worker.advance(store, abort())
}
const reports = (assessments: Currentness[]) =>
  assessments.filter(row => row.origin.kind === 'source')

describe('explicit source currentness and durable expiry', () => {
  it('requires exact configured source rules and keeps each provider separate from local knowledge', async () => {
    const { worker, store } = open(undefined, [rule('host-a'), rule('host-b')])
    await initialize(store)
    await ingest(store, worker, batch('a', [output()], base))
    await ingest(store, worker, batch('b', [output('A', 'b', 'host-b')], base, 'host-b'))
    await ingest(store, worker, batch('untrusted', [output('A', 'c', 'host-c')], base, 'host-c'))
    const result = await store.read(),
      selected = reports(result.assessments)
    expect(selected).toHaveLength(2)
    expect(
      selected.map(row => (row.origin.kind === 'source' ? row.origin.scope.provider : '')).sort()
    ).toEqual(['host-a', 'host-b'])
    expect(
      selected.every(row => row.state === 'reported-unspent' && row.evidenceIds.length > 0)
    ).toBe(true)
    expect(selected.every(row => row.expiresAt === String(base / 1000 + 2))).toBe(true)
    expect(result.assessments.find(row => row.origin.kind === 'local')?.state).toBe('unknown')
    expect(result.assessments.map(row => row.id)).toEqual(
      result.assessments.map(row => row.id).sort()
    )
    const wrongRules = batch('wrong-rules', [output('A', 'other')], base)
    wrongRules.provenance.scope = { ...scope(), rulesDigest: '33'.repeat(32) }
    wrongRules.coverage.scope = wrongRules.provenance.scope
    wrongRules.groups[0].observations[0].scope = wrongRules.provenance.scope
    await ingest(store, worker, wrongRules)
    expect(reports((await store.read()).assessments)).toHaveLength(2)
  })

  it('expires at the exclusive boundary, commits invalidation, and recovers it offline without extending freshness', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'currentness-'))
    directories.push(dir)
    const path = join(dir, 'knowledge.sqlite'),
      clock = { now: base },
      first = open(new SQLiteJournal(path, 'test'), [rule()], clock)
    await initialize(first.store)
    await ingest(first.store, first.worker, batch('a', [output()], clock.now))
    const fresh = await first.store.read()
    clock.now += 1999
    expect(reports((await first.store.read()).assessments)[0].state).toBe('reported-unspent')
    clock.now++
    await expect(first.store.read()).rejects.toMatchObject({ code: 'expired' })
    await first.worker.advance(first.store, abort())
    const expired = await first.store.read()
    expect(reports(expired.assessments)[0].state).toBe('stale')
    expect(BigInt(expired.revision.accepted)).toBe(BigInt(fresh.revision.accepted) + 1n)
    expect((await first.store.inspect()).entries.at(-1)?.body.kind).toBe('invalidate')
    await first.store.close()
    const recovered = open(new SQLiteJournal(path, 'test'), [rule()], clock, true)
    expect(await recovered.store.read()).toEqual(expired)
    await recovered.worker.advance(recovered.store, abort())
    expect(await recovered.store.read()).toEqual(expired)
  })

  it('does not refresh a replayed observation, but accepts a new report with its own bounded lifetime', async () => {
    const { worker, store, clock } = open()
    await initialize(store)
    await ingest(store, worker, batch('a', [output()], clock.now))
    clock.now += 3000
    await ingest(store, worker, batch('refresh', [output()], clock.now, 'host-a', '1'))
    const old = reports((await store.read()).assessments)[0]
    expect(old).toMatchObject({ state: 'stale', expiresAt: String(base / 1000 + 2) })
    await ingest(
      store,
      worker,
      batch('new-report', [output('A', 'fresh')], clock.now, 'host-a', '1', '2')
    )
    expect(reports((await store.read()).assessments)[0]).toMatchObject({
      state: 'reported-unspent',
      expiresAt: String(base / 1000 + 5)
    })
  })

  it('limits remote invalidation to earlier reports in the same complete source scope and context', async () => {
    const { worker, store } = open(undefined, [rule('host-a'), rule('host-b')])
    await initialize(store)
    await ingest(store, worker, batch('a', [output()], base))
    await ingest(store, worker, batch('b', [output('A', 'b', 'host-b')], base, 'host-b'))
    const contextId = (await store.read()).context.id
    await ingest(
      store,
      worker,
      batch(
        'invalidate',
        [
          {
            id: 'invalidates-a',
            scope: scope(),
            kind: 'assessment-invalidated',
            payload: { contextId, reason: 'Source continuity lost' }
          }
        ],
        base,
        'host-a',
        '0',
        '2'
      )
    )
    const result = await store.read(),
      selected = reports(result.assessments)
    expect(
      selected.find(row => row.origin.kind === 'source' && row.origin.scope.provider === 'host-a')
        ?.state
    ).toBe('stale')
    expect(
      selected.find(row => row.origin.kind === 'source' && row.origin.scope.provider === 'host-b')
        ?.state
    ).toBe('reported-unspent')
    expect(result.assessments.find(row => row.origin.kind === 'local')?.state).toBe('unknown')
    await ingest(store, worker, batch('fresh', [output('A', 'fresh')], base, 'host-a', '0', '3'))
    expect(
      reports((await store.read()).assessments).every(row => row.state === 'reported-unspent')
    ).toBe(true)
  })

  it('never restores an unspent report over actual final or provisional input consumption', async () => {
    for (const spending of ['A', 'N']) {
      const { worker, store } = open()
      await initialize(store)
      const parent = output('P', 'p')
      if (parent.kind !== 'output') throw new Error('Expected output fixture')
      parent.payload.evidence.outputIndex = spending === 'N' ? 1 : 0
      await ingest(store, worker, batch('p', [parent], base))
      await ingest(
        store,
        worker,
        batch('spend', [output(spending, 'spend')], base, 'host-a', '0', '2')
      )
      const result = await store.read()
      expect(
        reports(result.assessments).find(row => row.outpoint.txid === corpus.transactions.P.txid)
          ?.state
      ).toBe('stale')
      expect(
        result.reconciled.transactions.find(row => row.txid === corpus.transactions[spending].txid)
          ?.status
      ).toBe(spending === 'A' ? 'selected-final' : 'selected-non-final')
    }
  })

  it('does not report an output usable while its creation is excluded by the configured non-final policy', async () => {
    const { worker, store } = open(undefined, [rule()], { now: base }, false, false)
    await initialize(store)
    await ingest(store, worker, batch('n', [output('N', 'n')], base))
    const result = await store.read()
    expect(
      result.reconciled.transactions.find(row => row.txid === corpus.transactions.N.txid)?.status
    ).toBe('unsupported')
    expect(reports(result.assessments)[0].state).toBe('stale')
  })

  it('does not reassess an old source claim as fresh just because a new chain context verifies its creation', async () => {
    const { worker, store } = open()
    await initialize(store)
    await ingest(store, worker, batch('a', [output()], base))
    const changed = context('mature')
    await store.commit(
      (await store.revision()).received,
      knowledgeMutation({ kind: 'context', context: changed })
    )
    await worker.advance(store, abort())
    expect(reports((await store.read()).assessments)[0]).toMatchObject({
      state: 'stale',
      contextId: changed.id
    })
    await ingest(store, worker, batch('fresh', [output('A', 'fresh')], base, 'host-a', '0', '2'))
    expect(reports((await store.read()).assessments)[0].state).toBe('reported-unspent')
  })

  it('makes only the affected source stale on quarantine, then recovers in a replacement generation', async () => {
    const { worker, store } = open(undefined, [rule('host-a'), rule('host-b')])
    await initialize(store)
    await ingest(store, worker, batch('a', [output()], base))
    await ingest(store, worker, batch('b', [output('A', 'b', 'host-b')], base, 'host-b'))
    const malformed = output('Q', 'invalid')
    if (malformed.kind !== 'output') throw new Error('Expected output fixture')
    malformed.payload.evidence.beef = 'AA=='
    await ingest(store, worker, batch('bad', [malformed], base, 'host-a', '0', '2'))
    const selected = reports((await store.read()).assessments)
    expect(
      selected.find(row => row.origin.kind === 'source' && row.origin.scope.provider === 'host-a')
        ?.state
    ).toBe('stale')
    expect(
      selected.find(row => row.origin.kind === 'source' && row.origin.scope.provider === 'host-b')
        ?.state
    ).toBe('reported-unspent')
    await ingest(store, worker, batch('replacement', [output('A', 'fresh')], base, 'host-a', '1'))
    expect(
      reports((await store.read()).assessments).every(row => row.state === 'reported-unspent')
    ).toBe(true)
    const withdrawal: OutputObservation = {
      id: 'withdraw',
      scope: scope(),
      kind: 'withdraw',
      payload: {
        outpoint: { chain, txid: corpus.transactions.A.txid, outputIndex: 0 },
        reason: 'No longer listed here'
      }
    }
    await ingest(store, worker, batch('withdraw', [withdrawal], base, 'host-a', '1', '2'))
    expect(reports((await store.read()).assessments)).toHaveLength(1)
  })

  it('seals the policy in a new local frame and preserves legacy empty-policy journals', async () => {
    const storage = new MemoryJournal('policy'),
      original = open(storage)
    await initialize(original.store)
    expect((await original.store.inspect()).entries[0].local).toMatchObject({
      version: 2,
      currentnessRules: [rule()]
    })
    await expect(open(storage, [rule('host-a', '3')]).store.read()).rejects.toMatchObject({
      code: 'reset-required'
    })
    await expect(open(storage, []).store.read()).rejects.toMatchObject({ code: 'reset-required' })
    const legacyStorage = new MemoryJournal('legacy'),
      legacy = open(legacyStorage, [])
    await initialize(legacy.store)
    expect((await legacy.store.inspect()).entries[0].local).toMatchObject({ version: 1 })
    expect((await open(legacyStorage, []).store.read()).revision.accepted).toBe('1')
    await expect(open(legacyStorage, [rule()]).store.read()).rejects.toMatchObject({
      code: 'reset-required'
    })
  })

  it('rejects ambiguous policy selection and overflowing lifetimes before committing a receipt', async () => {
    expect(() => parseSourceCurrentnessRules([rule(), rule()])).toThrow('Duplicate')
    expect(() => parseSourceCurrentnessRules([rule('host-a', '0')])).toThrow('positive')
    expect(() =>
      parseSourceCurrentnessRules([
        { ...rule(), source: { ...rule().source, epoch: 'not-a-wildcard' } }
      ])
    ).toThrow()
    expect(() => parseSourceCurrentnessRules({})).toThrow('count')
    const { worker, store } = open(undefined, [rule('host-a', '18446744073709551615')])
    await initialize(store)
    await expect(ingest(store, worker, batch('overflow', [output()], base))).rejects.toMatchObject({
      code: 'limited'
    })
    expect((await store.revision()).received).toBe('1')
  })

  it('publishes an expiry invalidation without new incoming data', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] })
    jest.setSystemTime(base)
    const worker = new BitcoinKnowledge({
      journalId: 'timer',
      partition,
      nonFinal: true,
      sourceCurrentness: [rule('host-a', '1')],
      verifier: new SDKEvidenceVerifier(resolver)
    })
    const store = new KnowledgeStore(new MemoryJournal('timer'), worker, { partition })
    stores.push(store)
    const runtime = new OutputKnowledge({ store, worker })
    await runtime.setContext(context())
    await runtime.flush()
    await ingest(store, worker, batch('a', [output()], base))
    await runtime.flush()
    const fresh = await store.read()
    const events = runtime.events()[Symbol.asyncIterator]()
    await jest.advanceTimersByTimeAsync(1000)
    await runtime.flush()
    const expired = await store.read()
    expect(BigInt(expired.revision.accepted)).toBe(BigInt(fresh.revision.accepted) + 1n)
    expect(reports(expired.assessments)[0].state).toBe('stale')
    expect((await events.next()).value?.kind).toBe('knowledge')
    await runtime.close()
  })
})
