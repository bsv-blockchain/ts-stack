import { BitcoinKnowledgeState, verifiedAnchorClosure } from '../src/BitcoinKnowledgeState.js'
import type { ReconciliationCandidate } from '../src/SpendReconciler.js'
import { OutputKnowledge } from '../src/OutputKnowledge.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SQLiteJournal } from '../src/storage/SQLiteJournal.js'
import type { JournalStorage } from '../src/storage/Journal.js'
import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { type OutputObservation, type OutputSignedProposal } from '@bsv/sdk'
import { BitcoinKnowledge } from '../src/BitcoinKnowledge.js'
import { KnowledgeStore } from '../src/KnowledgeStore.js'
import { MemoryJournal } from '../src/storage/MemoryJournal.js'
import { knowledgeMutation } from '../src/storage/Journal.js'
import { ProposalSourcePolicy } from '../src/proposals/ProposalSourcePolicy.js'
import { proposalLocalFrame } from '../src/proposals/ProposalLocalFrame.js'
import { knowledgeLocalFrame } from '../src/VerificationLedger.js'
import { SDKEvidenceVerifier } from '../src/SDKEvidenceVerifier.js'
import type { SourceBatch } from '../src/ports.js'
import {
  author,
  recipient,
  registry,
  reference,
  signed,
  scope as proposalScope
} from './proposal-fixture.js'
import { chain, partition, context, resolver, candidate } from './evidence-fixture.js'
const source = {
  chain,
  provider: author,
  service: proposalScope.service,
  queryDigest: '03'.repeat(32),
  rulesDigest: '04'.repeat(32),
  access: 'public',
  epoch: 'one'
}
function policy(reader = recipient) {
  const { epoch: _epoch, ...selected } = source
  return new ProposalSourcePolicy(registry, reader, [
    {
      source: selected,
      proposalService: proposalScope.service,
      policy: reference,
      maxLifetimeSeconds: '90',
      futureSkewSeconds: '2'
    }
  ])
}
function observation(
  proposal: OutputSignedProposal = signed({ chain }),
  id = 'head'
): OutputObservation {
  return { id, scope: source, kind: 'proposal', payload: { proposal } }
}
function batch(observations: OutputObservation[]): SourceBatch {
  return {
    provenance: {
      partition,
      generation: '0',
      adapter: 'test',
      scope: source,
      authentication: 'configured-transport',
      peer: author,
      receivedAt: '999'
    },
    groups: [{ id: 'one', sequence: '0', observations }],
    coverage: { scope: source, phase: 'finite', status: 'complete' }
  }
}
const stores: KnowledgeStore[] = []
const directories: string[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function open(
  options: {
    enabled?: boolean
    clock?: () => number
    storage?: JournalStorage
    maximumChecks?: number
    reader?: string
  } = {}
) {
  const storage = options.storage ?? new MemoryJournal('proposals'),
    clock = options.clock ?? (() => 10000),
    verifier = new SDKEvidenceVerifier(resolver),
    verify = jest.spyOn(verifier, 'verify')
  const worker = new BitcoinKnowledge({
    journalId: storage.namespace,
    partition,
    nonFinal: true,
    verifier,
    now: clock,
    maximumChecks: options.maximumChecks,
    ...(options.enabled === false ? {} : { proposals: policy(options.reader) })
  })
  const store = new KnowledgeStore(storage, worker, { partition, now: clock })
  stores.push(store)
  return { storage, worker, store, verify }
}
async function initialize(store: KnowledgeStore) {
  await store.commit('0', knowledgeMutation({ kind: 'context', context: context() }))
}
async function receive(store: KnowledgeStore, observations: OutputObservation[]) {
  const rev = await store.revision()
  return store.commit(
    rev.received,
    knowledgeMutation({ kind: 'receive', batch: batch(observations) })
  )
}
const signal = () => new AbortController().signal
describe('opt-in proposal qualification inside the Bitcoin journal', () => {
  it.each([0, -1, 4097, 1.5, Number.NaN])(
    'rejects an invalid proof-check budget %s',
    maximumChecks => {
      expect(() => open({ maximumChecks })).toThrow('proof-check budget')
    }
  )

  it.each([-1, 0.5, Number.NaN])(
    'refuses an invalid local clock before sealing any proposal context: %s',
    now => {
      const { store } = open({ clock: () => now })
      return expect(initialize(store)).rejects.toMatchObject({ code: 'invalid' })
    }
  )

  it('rejects a pre-cancelled pass and a worker used with another journal', async () => {
    const one = open(),
      two = open({ storage: new MemoryJournal('other-journal') })
    await initialize(one.store)
    await initialize(two.store)
    const abort = new AbortController()
    abort.abort()
    await expect(one.worker.advance(one.store, abort.signal)).rejects.toMatchObject({
      code: 'cancelled'
    })
    await expect(one.worker.advance(two.store, signal())).rejects.toMatchObject({
      code: 'unauthorized'
    })
    expect((await one.store.revision()).received).toBe('1')
    expect((await two.store.revision()).received).toBe('1')
  })

  it('allows only one pass at a time and releases the guard after a held read completes', async () => {
    const { store, worker } = open()
    await initialize(store)
    const inspect = store.inspect.bind(store)
    let release!: () => void, entered!: () => void
    const held = new Promise<void>(resolve => {
        release = resolve
      }),
      reached = new Promise<void>(resolve => {
        entered = resolve
      })
    const pending = jest.spyOn(store, 'inspect').mockImplementationOnce(async abort => {
      entered()
      await held
      return inspect(abort)
    })
    const first = worker.advance(store, signal())
    try {
      await reached
      await expect(worker.advance(store, signal())).rejects.toMatchObject({ code: 'limited' })
    } finally {
      release()
      pending.mockRestore()
    }
    await first
    await worker.advance(store, signal())
    expect((await store.revision()).received).toBe('1')
  })

  it.each(['attempts', 'deadline'] as const)(
    'bounds repeated CAS conflicts by %s while preserving received work for retry',
    async mode => {
      let now = 10000
      const { store, worker } = open({ clock: () => now })
      await initialize(store)
      await receive(store, [observation()])
      const before = await store.revision()
      const commit = jest.spyOn(store, 'commit').mockImplementation(() => {
        if (mode === 'deadline') now = 30000
        return Promise.resolve({ status: 'conflict', reason: 'Concurrent writer won' })
      })
      try {
        await expect(worker.advance(store, signal())).rejects.toMatchObject({
          code: mode === 'attempts' ? 'conflict' : 'limited',
          retryable: true
        })
        expect(commit).toHaveBeenCalledTimes(mode === 'attempts' ? 8 : 1)
        expect(await store.revision()).toEqual(before)
        expect((await store.read()).proposals?.heads).toEqual([])
      } finally {
        commit.mockRestore()
      }
      await worker.advance(store, signal())
      expect((await store.read()).proposals?.heads).toHaveLength(1)
    }
  )

  it('rejects loss of retained proposal material while keeping the actual journal recoverable', async () => {
    const { store, worker } = open()
    await initialize(store)
    await receive(store, [observation()])
    const history = await store.inspect()
    delete history.entries[1].local
    await expect(worker.reduce(history.entries, signal())).rejects.toMatchObject({
      code: 'reset-required'
    })
    await expect(worker.prepare([], signal())).rejects.toMatchObject({ code: 'invalid' })
    await worker.advance(store, signal())
    expect((await store.read()).proposals?.heads).toHaveLength(1)
  })

  it('retains receipt first and publishes authenticated intent separately without invoking Bitcoin verification', async () => {
    const { store, worker, verify } = open()
    await initialize(store)
    await receive(store, [observation()])
    expect((await store.read()).proposals?.heads).toEqual([])
    await worker.advance(store, signal())
    const result = await store.read()
    expect(result.proposals?.heads[0]).toMatchObject({
      firstReceivedAt: '10',
      lifetime: 'unexpired'
    })
    expect(result.facts).toEqual([])
    expect(result.assessments).toEqual([])
    expect(verify).not.toHaveBeenCalled()
    expect((await store.inspect()).entries.every(entry => entry.local?.version === 4)).toBe(true)
  })
  it('preserves default rejection of proposal groups and old local frame3', async () => {
    const { store, worker } = open({ enabled: false })
    await initialize(store)
    await receive(store, [observation()])
    await worker.advance(store, signal())
    const result = await store.read()
    expect(result.proposals).toBeUndefined()
    expect(result.pendingGroups).toHaveLength(1)
    expect((await store.inspect()).entries[0].local?.version).toBe(3)
  })
  it('closes current and historical direct reads at expiry until durable reevaluation, then survives rollback of the clock', async () => {
    let now = 99000
    const { store, worker } = open({ clock: () => now })
    await initialize(store)
    await receive(store, [observation()])
    await worker.advance(store, signal())
    const revision = (await store.read()).revision.accepted
    now = 100000
    await expect(store.read()).rejects.toMatchObject({ code: 'expired' })
    await expect(store.read(revision)).rejects.toMatchObject({ code: 'expired' })
    await worker.advance(store, signal())
    expect((await store.read()).proposals?.heads[0].lifetime).toBe('expired')
    now = 98000
    await worker.advance(store, signal())
    expect((await store.read()).proposals?.heads[0].lifetime).toBe('expired')
  })
  it('replays retained exact receipt and verification with no new crypto on reopening', async () => {
    const one = open()
    await initialize(one.store)
    await receive(one.store, [observation()])
    await one.worker.advance(one.store, signal())
    const expected = await one.store.read(),
      two = open({ storage: one.storage })
    expect(await two.store.read()).toEqual(expected)
    expect(two.verify).not.toHaveBeenCalled()
  })
  it('refuses silent upgrade, downgrade or a changed installed reader in the same retained namespace', async () => {
    const one = open()
    await initialize(one.store)
    await expect(open({ storage: one.storage, enabled: false }).store.read()).rejects.toBeDefined()
    await expect(open({ storage: one.storage, reader: author }).store.read()).rejects.toMatchObject(
      { code: 'reset-required' }
    )
    const legacy = open({ enabled: false })
    await initialize(legacy.store)
    await expect(open({ storage: legacy.storage }).store.read()).rejects.toMatchObject({
      code: 'reset-required'
    })
  })
  it('quarantines mixed Bitcoin siblings when the proposal signature fails', async () => {
    const { store, worker, verify } = open()
    await initialize(store)
    const bad = signed({ chain })
    bad.signature = 'AQ=='
    await receive(store, [
      observation(bad),
      {
        id: 'output',
        scope: source,
        kind: 'output',
        payload: { evidence: candidate('A').evidence }
      }
    ])
    await worker.advance(store, signal())
    const view = await store.read()
    expect(view.facts).toEqual([])
    expect(view.observations).toEqual([])
    expect(view.proposals?.heads).toEqual([])
    expect(verify).not.toHaveBeenCalled()
  })
  it('accepts independent Bitcoin evidence without borrowing from or publishing a quarantined proposal group', async () => {
    const { store, worker, verify } = open({ clock: Date.now })
    await initialize(store)
    const bad = signed({ chain })
    bad.signature = 'AQ=='
    await receive(store, [
      observation(bad),
      {
        id: 'output',
        scope: source,
        kind: 'output',
        payload: { evidence: candidate('A').evidence }
      }
    ])
    await worker.advance(store, signal())
    expect((await store.read()).facts).toEqual([])
    expect(verify).not.toHaveBeenCalled()
    const independent = { ...source, provider: recipient }
    const next = batch([
      {
        id: 'independent-output',
        scope: independent,
        kind: 'output',
        payload: { evidence: candidate('A').evidence }
      }
    ])
    next.provenance.scope = independent
    next.provenance.peer = independent.provider
    next.coverage.scope = independent
    next.groups[0].id = 'independent'
    await store.commit(
      (await store.revision()).received,
      knowledgeMutation({ kind: 'receive', batch: next })
    )
    await worker.advance(store, signal())
    const accepted = await store.read()
    expect(accepted.facts.some(fact => fact.txid === candidate('A').evidence.txid)).toBe(true)
    expect(accepted.proposals?.heads).toEqual([])
    expect(accepted.observations.map(item => item.id)).toEqual(['independent-output'])
    expect(verify).toHaveBeenCalled()
  })
  it('uses one count budget and retains partial qualification for the next bounded pass', async () => {
    const { store, worker } = open({ maximumChecks: 1 })
    await initialize(store)
    await receive(store, [
      observation(),
      observation(signed({ chain, channel: '09'.repeat(32) }), 'two')
    ])
    await expect(worker.advance(store, signal())).rejects.toMatchObject({ code: 'limited' })
    expect((await store.read()).proposals?.heads).toEqual([])
    await worker.advance(store, signal())
    expect((await store.read()).proposals?.heads).toHaveLength(2)
  })
  it('recovers native SQLite receipts and delivers durable expiry to a watch across restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'proposal-core-'))
    directories.push(directory)
    const path = join(directory, 'knowledge.sqlite')
    let now = 10000
    const one = open({ storage: new SQLiteJournal(path, 'native-proposal'), clock: () => now })
    await initialize(one.store)
    await receive(one.store, [observation()])
    await one.store.close()
    stores.splice(stores.indexOf(one.store), 1)
    now = 99000
    const two = open({ storage: new SQLiteJournal(path, 'native-proposal'), clock: () => now })
    await two.worker.advance(two.store, signal())
    const active = await two.store.read()
    expect(active.proposals?.heads[0]).toMatchObject({
      firstReceivedAt: '10',
      lifetime: 'unexpired'
    })
    const abort = new AbortController()
    const watch = two.store.watch(active.revision.accepted, abort.signal)[Symbol.asyncIterator]()
    const change = watch.next()
    now = 100000
    await two.worker.advance(two.store, signal())
    expect((await change).value.proposals?.heads[0].lifetime).toBe('expired')
    abort.abort()
    await watch.return?.()
    await two.store.close()
    stores.splice(stores.indexOf(two.store), 1)
    now = 99000
    const three = open({ storage: new SQLiteJournal(path, 'native-proposal'), clock: () => now })
    expect((await three.store.read()).proposals?.heads[0]).toMatchObject({
      firstReceivedAt: '10',
      lifetime: 'expired'
    })
    expect(three.verify).not.toHaveBeenCalled()
  })

  it('rejects cross-service mappings before opening an observation journal', () => {
    const { epoch: _epoch, ...selected } = source
    const proposals = new ProposalSourcePolicy(registry, recipient, [
      {
        source: { ...selected, service: 'other-lookup' },
        proposalService: proposalScope.service,
        policy: reference,
        maxLifetimeSeconds: '90',
        futureSkewSeconds: '2'
      }
    ])
    expect(
      () =>
        new BitcoinKnowledge({
          journalId: 'new',
          partition,
          nonFinal: true,
          proposals,
          verifier: new SDKEvidenceVerifier(resolver)
        })
    ).toThrow('identical source and proposal service')
  })

  it('does not advance accepted proposal time merely because another source receipt arrives', async () => {
    let now = 10000
    const { store, worker } = open({ clock: () => now })
    await initialize(store)
    await receive(store, [observation()])
    await worker.advance(store, signal())
    const before = await store.read()
    now = 50000
    const next = batch([observation(signed({ chain, channel: '0a'.repeat(32) }), 'second')])
    next.provenance.generation = '1'
    next.groups[0].id = 'second'
    const revision = await store.revision()
    await store.commit(revision.received, knowledgeMutation({ kind: 'receive', batch: next }))
    const pending = await store.read()
    expect(pending.revision.accepted).toBe(before.revision.accepted)
    expect(pending.proposals?.evaluatedAt).toBe('10')
  })
  it('recovers automatically when expiry crosses between worker completion and the runtime read', async () => {
    let now = 99000,
      passes = 0
    const { store, worker } = open({ clock: () => now })
    await initialize(store)
    await receive(store, [observation()])
    const runtime = new OutputKnowledge({
      store,
      worker: {
        pendingBytes: (target, abort) => worker.pendingBytes(target, abort),
        async advance(target, abort) {
          await worker.advance(target, abort)
          if (++passes === 1) now = 100000
        },
        nextInvalidation: input => worker.nextInvalidation(input)
      },
      now: () => now
    })
    try {
      await runtime.flush()
      expect(passes).toBe(2)
      expect((await store.read()).proposals?.heads[0].lifetime).toBe('expired')
    } finally {
      await runtime.close()
      stores.splice(stores.indexOf(store), 1)
    }
  })

  it('bounds runtime recovery when an incorrect worker never commits the due invalidation', async () => {
    let now = 99000,
      passes = 0
    const { store, worker } = open({ clock: () => now })
    await initialize(store)
    await receive(store, [observation()])
    await worker.advance(store, signal())
    now = 100000
    const runtime = new OutputKnowledge({
      store,
      worker: {
        pendingBytes: (target, abort) => worker.pendingBytes(target, abort),
        async advance() {
          passes++
        },
        nextInvalidation: input => worker.nextInvalidation(input)
      },
      now: () => now
    })
    try {
      await expect(runtime.flush()).rejects.toMatchObject({ code: 'expired' })
      expect(passes).toBe(2)
      await new Promise<void>(resolve => setTimeout(resolve, 10))
      expect(passes).toBe(2)
    } finally {
      await runtime.close()
      stores.splice(stores.indexOf(store), 1)
    }
  })
})

describe('local proposal replay transition boundaries', () => {
  const stamp = () => ({
    reference: { group: 'local-group', observationId: 'head', envelope: '01'.repeat(32) },
    firstReceivedAt: '10'
  })

  it('requires an initial context before replaying a receive or accepted transition', () => {
    const selected = policy(),
      state = selected.createState(4096),
      frame = proposalLocalFrame(knowledgeLocalFrame(false, [], [], 3), selected, '10')
    expect(() => state.apply(frame, 'receive', [])).toThrow('initial context')
    expect(() => state.apply(frame, 'accept', [])).toThrow('initial context')
    expect(state.evaluatedAt).toBe('0')
    state.apply(frame, 'context', [])
    expect(state.evaluatedAt).toBe('10')
  })

  it('rejects backward accepted clocks and forward receive clocks without changing retained time', () => {
    const selected = policy(),
      state = selected.createState(4096)
    state.apply(
      proposalLocalFrame(knowledgeLocalFrame(false, [], [], 3), selected, '10'),
      'context',
      []
    )
    expect(() =>
      state.apply(
        proposalLocalFrame(knowledgeLocalFrame(false, [], [], 3), selected, '9'),
        'accept',
        []
      )
    ).toThrow('clock changed')
    expect(() =>
      state.apply(
        proposalLocalFrame(knowledgeLocalFrame(false, [], [], 3), selected, '11'),
        'receive',
        []
      )
    ).toThrow('clock changed')
    expect(state.evaluatedAt).toBe('10')
    state.apply(
      proposalLocalFrame(knowledgeLocalFrame(false, [], [], 3), selected, '10'),
      'receive',
      []
    )
    expect(state.evaluatedAt).toBe('10')
  })

  it('does not accept receipt creation or verification in unrelated replay transitions', () => {
    const selected = policy(),
      state = selected.createState(4096)
    state.apply(
      proposalLocalFrame(knowledgeLocalFrame(false, [], [], 3), selected, '10'),
      'context',
      []
    )
    expect(() =>
      state.apply(
        proposalLocalFrame(knowledgeLocalFrame(false, [], [], 3), selected, '11', [stamp()]),
        'accept',
        []
      )
    ).toThrow('stamps require a receive')
    expect(() =>
      state.apply(
        proposalLocalFrame(
          knowledgeLocalFrame(false, [], [], 3),
          selected,
          '11',
          [],
          [{ ...stamp(), status: 'verified' }]
        ),
        'context',
        []
      )
    ).toThrow('work requires an acceptance')
    expect(state.evaluatedAt).toBe('10')
    expect(state.pool.pending()).toEqual([])
  })
})

describe('bounded client acceptance recovery', () => {
  it('bounds retained replay without changing the original journal', async () => {
    let now = 10000,
      advancing = false
    const { store, worker } = open({
      clock: () => {
        if (advancing) now += 20000
        return now
      }
    })
    await initialize(store)
    const history = await store.inspect()
    advancing = true
    await expect(worker.reduce(history.entries, signal())).rejects.toThrow(
      'journal replay deadline'
    )
    advancing = false
    now = 10000
    expect((await store.read()).revision).toEqual(history.revision)
  })

  it('rejects an unsupported retained transition before accepting its state', async () => {
    const { store, worker } = open()
    await initialize(store)
    const history = await store.inspect()
    const malformed = structuredClone(history.entries[0])
    malformed.body = { kind: 'unknown-transition' } as unknown as typeof malformed.body
    malformed.revision = { received: '2', accepted: '2' }
    await expect(worker.reduce([...history.entries, malformed], signal())).rejects.toMatchObject({
      code: 'unsupported'
    })
    expect((await store.read()).revision).toEqual(history.revision)
  })

  it('rejects a source from another configured chain before retaining its Bitcoin evidence', async () => {
    const { store, worker, verify } = open()
    await initialize(store)
    const foreign = { ...source, chain: { ...chain, genesisHash: 'ff'.repeat(32) } }
    const next = batch([
      {
        id: 'other-chain',
        scope: foreign,
        kind: 'output',
        payload: { evidence: candidate('A').evidence }
      }
    ])
    next.provenance.scope = next.coverage.scope = foreign
    await expect(
      store.commit('1', knowledgeMutation({ kind: 'receive', batch: next }))
    ).rejects.toMatchObject({ code: 'context-changed' })
    expect((await store.revision()).received).toBe('1')
    await worker.advance(store, signal())
    expect(verify).not.toHaveBeenCalled()
    expect((await store.read()).facts).toEqual([])
  })

  it.each(['write-failure', 'deadline'] as const)(
    'retains an accepted first group and recovers the remaining group after %s',
    async failure => {
      let now = 10000
      const { store, worker } = open({ clock: () => now })
      await initialize(store)
      const next = batch([observation()])
      next.groups.push({
        id: 'second',
        sequence: '0',
        observations: [observation(signed({ chain, channel: '0e'.repeat(32) }), 'second-head')]
      })
      await store.commit('1', knowledgeMutation({ kind: 'receive', batch: next }))
      const commit = store.commit.bind(store)
      let writes = 0
      const failing = jest.spyOn(store, 'commit').mockImplementation(async (...args) => {
        writes++
        if (writes === 2 && failure === 'write-failure')
          return { status: 'context-changed', reason: 'Synthetic writer context changed' }
        const result = await commit(...args)
        if (writes === 1 && failure === 'deadline') now = 30000
        return result
      })
      try {
        await expect(worker.advance(store, signal())).rejects.toMatchObject({
          code: failure === 'write-failure' ? 'context-changed' : 'limited'
        })
        const partial = await store.read()
        expect(partial.proposals?.heads).toHaveLength(1)
        expect(partial.pendingGroups).toHaveLength(1)
      } finally {
        failing.mockRestore()
      }
      await worker.advance(store, signal())
      const recovered = await store.read()
      expect(recovered.proposals?.heads).toHaveLength(2)
      expect(recovered.pendingGroups).toEqual([])
    }
  )
})

describe('bounded verified ancestor publication', () => {
  it('visits a shared retained ancestor once and leaves external proof anchors to evidence verification', () => {
    const graph = new Map([
      ['root', ['left', 'right']],
      ['left', ['shared']],
      ['right', ['shared']],
      ['shared', ['external-anchor']]
    ])
    const candidates = new Map(
      [...graph.keys()].map(id => [id, { validation: 'verified' as const }])
    )
    const parents = jest.fn((id: string) => graph.get(id) ?? [])
    expect(verifiedAnchorClosure('root', candidates, parents)).toBe(true)
    expect(parents.mock.calls.filter(([id]) => id === 'shared')).toHaveLength(1)
    expect(parents.mock.calls.some(([id]) => id === 'external-anchor')).toBe(false)
  })

  it.each(['invalid', 'unsupported', 'unresolved', 'limited'] as const)(
    'withholds publication when a retained ancestor is %s',
    validation => {
      const candidates = new Map<string, { validation: ReconciliationCandidate['validation'] }>([
        ['root', { validation: 'verified' }],
        ['parent', { validation }]
      ])
      expect(
        verifiedAnchorClosure('root', candidates, id => (id === 'root' ? ['parent'] : []))
      ).toBe(false)
    }
  )

  it('charges every queued edge, including shared ancestors, and accepts exactly 16384 units of publication work', () => {
    // 1 root + 255 children + 252 * 64 shared-ancestor edges = 16384 work units.
    const children = Array.from({ length: 255 }, (_, n) => `child-${n}`)
    const ancestors = Array.from({ length: 64 }, (_, n) => `anchor-${n}`)
    const graph = new Map<string, string[]>([['root', children]])
    children.forEach((id, n) => graph.set(id, n < 252 ? ancestors : []))
    ancestors.forEach(id => graph.set(id, []))
    const candidates = new Map(
      [...graph.keys()].map(id => [id, { validation: 'verified' as const }])
    )
    expect(verifiedAnchorClosure('root', candidates, id => graph.get(id)!)).toBe(true)
    graph.set(children[254], [ancestors[0]])
    expect(() => verifiedAnchorClosure('root', candidates, id => graph.get(id)!)).toThrow(
      expect.objectContaining({ code: 'limited' })
    )
  })
})

it('does not prepare an acceptance before a received group has qualified locally', async () => {
  const { store } = open()
  await initialize(store)
  await receive(store, [observation()])
  const history = await store.inspect()
  const state = new BitcoinKnowledgeState({
    journalId: store.journalId,
    partition,
    nonFinal: true,
    proposals: policy()
  })
  for (const entry of history.entries) state.apply(entry)
  const group = state.membership.groups()[0]
  expect(() => state.transition(history.revision, group)).toThrow(
    expect.objectContaining({ code: 'unavailable' })
  )
  expect(state.membership.groups()[0].status).toBe('pending')
  expect(state.snapshot().proposals?.heads).toEqual([])
})
