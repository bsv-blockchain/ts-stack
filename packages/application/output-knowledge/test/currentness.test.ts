import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'
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
import { BitcoinKnowledgeState } from '../src/BitcoinKnowledgeState.js'
import type { JournalEntry } from '../src/storage/Journal.js'
import type { Mutation } from '../src/ports.js'
import { proofReference, proofReferenceKey } from '../src/VerificationLedger.js'
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

async function replayState(store: KnowledgeStore, rules: SourceCurrentnessRule[]) {
  const state = new BitcoinKnowledgeState({
    journalId: store.journalId,
    partition,
    nonFinal: true,
    sourceCurrentness: rules
  })
  for (const entry of (await store.inspect()).entries) state.apply(entry)
  return state
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

describe('retained Bitcoin journal transition admission', () => {
  let entries: JournalEntry[]
  const replay = (prefix: readonly JournalEntry[]) => {
    const state = new BitcoinKnowledgeState({
      journalId: 'test',
      partition,
      nonFinal: true,
      sourceCurrentness: [rule()]
    })
    for (const entry of prefix) state.apply(structuredClone(entry))
    return state
  }
  beforeEach(async () => {
    // Obtain every baseline transition and proof through the real SDK-backed worker.
    const { store, worker } = open()
    await initialize(store)
    await ingest(store, worker, batch('admission', [output()], base))
    const state = await replayState(store, [rule()]),
      revision = await store.revision()
    await store.commit(
      revision.received,
      knowledgeMutation(
        state.transition({
          received: String(BigInt(revision.received) + 1n),
          accepted: String(BigInt(revision.accepted) + 1n)
        })
      )
    )
    const snapshot = await store.read()
    expect(snapshot.facts.some(fact => fact.txid === candidate('A').evidence.txid)).toBe(true)
    expect(reports(snapshot.assessments)[0].state).toBe('reported-unspent')
    await store.commit(
      snapshot.revision.received,
      knowledgeMutation({
        kind: 'invalidate',
        generation: snapshot.generation,
        assessmentIds: [reports(snapshot.assessments)[0].id],
        reason: 'Local admission test invalidation'
      })
    )
    entries = (await store.inspect()).entries
    expect(entries.map(entry => entry.body.kind)).toEqual([
      'context',
      'receive',
      'accept',
      'reconcile',
      'invalidate'
    ])
    await store.close()
  })

  it('rejects replay before an initial context with an actionable diagnostic', () => {
    const state = replay([])
    expect(() => state.snapshot()).toThrow(
      expect.objectContaining({
        code: 'revision-unavailable',
        message: expect.stringContaining('initial verification context')
      })
    )
  })

  it('requires the retained spend policy on an initial context', () => {
    const entry = structuredClone(entries[0])
    delete entry.local
    expect(() => replay([]).apply(entry)).toThrow(
      expect.objectContaining({
        code: 'reset-required',
        message: expect.stringContaining('retained spend policy')
      })
    )
  })

  it.each(['account', 'chain', 'generation', 'identity'] as const)(
    'rejects a second context that changes the established %s contract',
    fault => {
      const first = structuredClone(entries[0]),
        next = structuredClone(entries[0])
      if (first.body.kind !== 'context' || next.body.kind !== 'context')
        throw new Error('Context fixture')
      next.body.context.id = 'next-context'
      if (fault === 'account') next.body.context.partition.account = 'bob'
      if (fault === 'chain') next.body.context.view.chain.genesisHash = 'ab'.repeat(32)
      if (fault === 'generation') first.body.context.generation = '1'
      if (fault === 'identity') next.body.context.id = first.body.context.id
      next.revision = { received: '2', accepted: '2' }
      const expected = {
        account: ['unauthorized', 'account partition'],
        chain: ['context-changed', 'chain changed'],
        generation: ['context-changed', 'generation reversed'],
        identity: ['equivocation', 'identity was reused']
      }[fault]
      expect(() => replay([first]).apply(next)).toThrow(
        expect.objectContaining({
          code: expected[0],
          message: expect.stringContaining(expected[1])
        })
      )
    }
  )

  it('rejects an unknown retained mutation kind rather than silently advancing', () => {
    const entry = structuredClone(entries[1])
    entry.body = { kind: 'unknown' } as unknown as Mutation['body']
    expect(() => replay(entries.slice(0, 1)).apply(entry)).toThrow(
      expect.objectContaining({
        code: 'unsupported',
        message: expect.stringContaining('Unknown knowledge mutation')
      })
    )
  })

  it.each(['context', 'generation', 'assessments', 'reconciliation'] as const)(
    'independently rejects a reconciliation with altered %s',
    fault => {
      const index = entries.findIndex(entry => entry.body.kind === 'reconcile'),
        entry = structuredClone(entries[index])
      if (entry.body.kind !== 'reconcile') throw new Error('Reconciliation fixture')
      if (fault === 'context') entry.body.contextId = 'other-context'
      if (fault === 'generation') entry.body.generation = '1'
      if (fault === 'assessments') entry.body.assessments = []
      if (fault === 'reconciliation') entry.body.reconciled.memberships = []
      const expected =
        fault === 'context'
          ? ['context-changed', 'Acceptance context']
          : fault === 'generation'
            ? ['context-changed', 'Reconciliation generation']
            : ['invalid', 'deterministic protocol reconciliation']
      expect(() => replay(entries.slice(0, index)).apply(entry)).toThrow(
        expect.objectContaining({
          code: expected[0],
          message: expect.stringContaining(expected[1])
        })
      )
    }
  )

  it.each(['group', 'scope', 'generation', 'results'] as const)(
    'requires the exact verified group %s before acceptance',
    fault => {
      const index = entries.findIndex(entry => entry.body.kind === 'accept'),
        entry = structuredClone(entries[index])
      if (entry.body.kind !== 'accept') throw new Error('Acceptance fixture')
      if (fault === 'group') entry.body.groupId = 'unreceived-group'
      if (fault === 'scope') entry.body.scope.provider = 'different-provider'
      if (fault === 'generation') entry.body.generation = '1'
      if (fault === 'results') entry.body.results = []
      expect(() => replay(entries.slice(0, index)).apply(entry)).toThrow(
        expect.objectContaining({
          code: fault === 'results' ? 'invalid' : 'context-changed',
          message: expect.stringContaining(
            fault === 'results' ? 'verified whole-group' : 'unavailable or retired'
          )
        })
      )
    }
  )

  it.each([
    'generation',
    'not an array',
    'empty reason',
    'nontext reason',
    'unknown assessment',
    'duplicate assessment'
  ] as const)('rejects invalidation with %s', fault => {
    const index = entries.findIndex(entry => entry.body.kind === 'invalidate'),
      entry = structuredClone(entries[index])
    if (entry.body.kind !== 'invalidate') throw new Error('Invalidation fixture')
    if (fault === 'generation') entry.body.generation = '1'
    if (fault === 'not an array') entry.body.assessmentIds = {} as string[]
    if (fault === 'empty reason') entry.body.reason = ''
    if (fault === 'nontext reason') entry.body.reason = 1 as unknown as string
    if (fault === 'unknown assessment') entry.body.assessmentIds = ['ff'.repeat(32)]
    if (fault === 'duplicate assessment') entry.body.assessmentIds.push(entry.body.assessmentIds[0])
    const expected =
      fault === 'generation'
        ? ['context-changed', 'Invalidation generation']
        : fault === 'unknown assessment' || fault === 'duplicate assessment'
          ? ['invalid', 'Unknown or duplicated assessment']
          : ['invalid', 'Invalid assessment invalidation']
    expect(() => replay(entries.slice(0, index)).apply(entry)).toThrow(
      expect.objectContaining({
        code: expected[0],
        message: expect.stringContaining(expected[1])
      })
    )
  })

  it('replays a valid invalidation without changing Bitcoin facts or source membership', () => {
    const before = replay(entries.slice(0, -1)).snapshot(),
      after = replay(entries).snapshot()
    expect(after.facts).toEqual(before.facts)
    expect(after.reconciled.memberships).toEqual(before.reconciled.memberships)
    expect(reports(after.assessments)[0]).toMatchObject({
      state: 'stale',
      origin: { kind: 'source' }
    })
    expect(reports(after.assessments)[0].id).not.toBe(reports(before.assessments)[0].id)
    expect(after.revision).toEqual(entries.at(-1)!.revision)
  })

  it('requires every retained proof when rebuilding facts and provider freshness', () => {
    const state = replay(entries.slice(0, -1)),
      before = state.snapshot(),
      plan = state.plan(),
      txid = candidate('A').evidence.txid,
      target = plan.candidates.get(txid)!,
      proofs = target.bundles[0].proofs
    expect(before.facts.some(fact => fact.txid === txid)).toBe(true)
    expect(proofs.length).toBeGreaterThan(1)
    const missing = proofReferenceKey(proofReference(plan.proofs.get(proofs[0])!)),
      lookup = state.ledger.get.bind(state.ledger),
      retained = jest
        .spyOn(state.ledger, 'get')
        .mockImplementation((reference, contextId) =>
          proofReferenceKey(reference) === missing ? undefined : lookup(reference, contextId)
        )
    // Remove one lookup from the real retained proof set; never manufacture a verdict.
    try {
      const result = state.snapshot()
      expect(result.facts.some(fact => fact.txid === txid)).toBe(false)
      expect(reports(result.assessments)[0]).toMatchObject({ state: 'stale', evidenceIds: [] })
      expect(result.reconciled.memberships).toEqual(before.reconciled.memberships)
    } finally {
      retained.mockRestore()
    }
    expect(state.snapshot()).toEqual(before)
  })

  it('disables retired groups and prevents them from qualifying a transition', () => {
    const state = replay(entries.slice(0, 2)),
      retired = state.membership.groups()[0],
      replacement = batch('replacement', [output('Q', 'replacement')], base, 'host-a', '1')
    state.apply({
      ...knowledgeMutation({ kind: 'receive', batch: replacement }),
      revision: { received: '3', accepted: '1' }
    })
    const old = state.plan().groups.find(group => group.id.includes('admission'))!,
      current = state.plan().groups.find(group => group.id.includes('replacement'))!
    expect(old.enabled).toBe(false)
    expect(current.enabled).toBe(true)
    expect(state.groupDecision(retired)).toBeUndefined()
    expect(() => state.transition({ received: '4', accepted: '2' }, retired)).toThrow(
      expect.objectContaining({
        code: 'unavailable',
        message: expect.stringContaining('has not qualified')
      })
    )
    expect(state.snapshot()).toMatchObject({ facts: [], reconciled: { memberships: [] } })
  })

  it('retains an equivocal receipt without admitting any sibling evidence or freshness', () => {
    const state = replay(entries.slice(0, 2)),
      original = state.pool.entries(),
      equivocal = batch('admission', [output('Q', 'a'), output('R', 'new-sibling')], base)
    state.apply({
      ...knowledgeMutation({ kind: 'receive', batch: equivocal }),
      revision: { received: '3', accepted: '1' }
    })
    expect(state.membership.quarantines()).toHaveLength(1)
    expect(state.pool.entries()).toEqual(original)
    expect(state.plan().groups.every(group => !group.enabled)).toBe(true)
    expect(state.membership.groups().every(group => state.groupDecision(group) === undefined)).toBe(
      true
    )
    expect(state.snapshot()).toMatchObject({
      facts: [],
      assessments: [],
      reconciled: { memberships: [] }
    })
    expect(state.pendingBytes()).toBeGreaterThan(replay(entries.slice(0, 1)).pendingBytes())
  })
})

describe('explicit source currentness and durable expiry', () => {
  it('reports direct and inherited Bitcoin conflicts while unrelated outputs remain unspent', async () => {
    const { store, worker } = open()
    await initialize(store)
    await ingest(
      store,
      worker,
      batch(
        'conflicts',
        ['A', 'B', 'AC', 'BC', 'Q'].map(name => output(name, name)),
        base
      )
    )
    const result = await store.read(),
      local = result.assessments.filter(row => row.origin.kind === 'local'),
      status = (name: string) =>
        result.reconciled.transactions.find(row => row.txid === corpus.transactions[name].txid)!
          .status,
      assessment = (name: string) =>
        local.find(row => row.outpoint.txid === corpus.transactions[name].txid)!
    const winner = status('A') === 'selected-final' ? 'A' : 'B',
      loser = winner === 'A' ? 'B' : 'A'
    expect(status(loser)).toBe('conflicting')
    expect(status(loser + 'C')).toBe('dependent-conflict')
    expect(assessment(loser).state).toBe('conflicted')
    expect(assessment(loser + 'C').state).toBe('conflicted')
    expect(assessment(winner).state).toBe('spent')
    expect(assessment('Q').state).toBe('unknown')
    expect(
      reports(result.assessments).find(row => row.outpoint.txid === corpus.transactions.Q.txid)!
        .state
    ).toBe('reported-unspent')
    await store.commit(
      result.revision.received,
      knowledgeMutation({ kind: 'context', context: context('mature') })
    )
    const pending = await store.read()
    expect(pending.reconciled.transactions.every(row => row.status === 'unresolved')).toBe(true)
    expect(pending.assessments.every(row => row.state === 'stale')).toBe(true)
    expect(pending.facts).toEqual(result.facts)
  })

  it('withholds an observed input while an incomplete multi-input spender remains unresolved', async () => {
    const { store, worker } = open(),
      parent = output('P', 'parent')
    if (parent.kind !== 'output') throw new Error('Output fixture')
    parent.payload.evidence.outputIndex = 1
    await initialize(store)
    await ingest(store, worker, batch('parent', [parent, output('Q', 'unrelated')], base))
    const pending = output('extraInput', 'incomplete')
    if (pending.kind !== 'output') throw new Error('Output fixture')
    // Keep genuine raw Bitcoin input identities but deliberately omit its parent evidence.
    const { Beef, Utils } = await import('@bsv/sdk'),
      beef = new Beef()
    beef.mergeRawTx(Utils.toArray(corpus.transactions.extraInput.raw, 'hex'))
    pending.payload.evidence.beef = Utils.toBase64(beef.toBinary())
    await store.commit(
      (await store.revision()).received,
      knowledgeMutation({
        kind: 'receive',
        batch: batch('incomplete', [pending], base, 'host-a', '0', '2')
      })
    )
    const result = await store.read(),
      local = result.assessments.filter(row => row.origin.kind === 'local')
    expect(
      result.reconciled.transactions.find(row => row.txid === corpus.transactions.extraInput.txid)
    ).toMatchObject({
      status: 'unresolved',
      dependencies: expect.arrayContaining([
        { chain, txid: corpus.transactions.P.txid, outputIndex: 1 }
      ])
    })
    expect(
      local.find(
        row => row.outpoint.txid === corpus.transactions.P.txid && row.outpoint.outputIndex === 1
      )
    ).toMatchObject({ state: 'stale' })
    expect(local.find(row => row.outpoint.txid === corpus.transactions.Q.txid)).toMatchObject({
      state: 'unknown'
    })
  })

  it('keeps an unverified group pending when its restored planner lacks the receipt index', async () => {
    const rules = [rule()],
      { store } = open(undefined, rules)
    await initialize(store)
    await store.commit(
      (await store.revision()).received,
      knowledgeMutation({ kind: 'receive', batch: batch('pending', [output()], base) })
    )
    const state = await replayState(store, rules),
      pending = state.membership.groups().find(row => row.status === 'pending')!,
      plan = state.plan()
    expect(pending.group.id).toBe('pending')
    expect([...plan.slots.values()].some(bundles => bundles.length > 0)).toBe(true)
    // A partial restored plan must never invent a verified whole-group decision.
    const planner = jest.spyOn(state, 'plan').mockReturnValue({ ...plan, slots: new Map() })
    try {
      expect(state.groupDecision(pending)).toBeUndefined()
      expect(state.snapshot()).toMatchObject({ facts: [], reconciled: { memberships: [] } })
    } finally {
      planner.mockRestore()
    }
    expect(state.groupDecision(pending)).toBeUndefined()
  })

  it('withholds source freshness when a restored planner has no evidence-slot index', async () => {
    const rules = [rule()],
      { worker, store } = open(undefined, rules)
    await initialize(store)
    await ingest(store, worker, batch('a', [output()], base))
    const state = await replayState(store, rules),
      before = state.snapshot(),
      plan = state.plan(),
      missingIndex = new Map(plan.slots)
    expect(reports(before.assessments)[0].state).toBe('reported-unspent')
    missingIndex.clear()
    // Inject only the missing index; retain the actual SDK proofs and accepted journal.
    const planner = jest.spyOn(state, 'plan').mockReturnValue({ ...plan, slots: missingIndex })
    try {
      const result = state.snapshot()
      expect(result.facts).toEqual(before.facts)
      expect(reports(result.assessments)[0]).toMatchObject({ state: 'stale', evidenceIds: [] })
    } finally {
      planner.mockRestore()
    }
    expect(reports(state.snapshot().assessments)[0].state).toBe('reported-unspent')
  })

  it('does not lend another source Bitcoin proof to an orphan restored membership', async () => {
    const rules = [rule('host-a'), rule('host-b')],
      { worker, store } = open(undefined, rules)
    await initialize(store)
    await ingest(store, worker, batch('a', [output()], base))
    await ingest(store, worker, batch('empty', [], base, 'host-b'))
    const state = await replayState(store, rules),
      before = state.snapshot(),
      members = state.membership.memberships(),
      original = members[0]
    expect(original).toMatchObject({ present: true, scope: scope('host-a') })
    expect(state.membership.isContinuous(scope('host-b'), '0')).toBe(true)
    state.sourceCurrentness.receive(
      batch('unlinked', [output('A', 'unlinked', 'host-b')], base, 'host-b', '0', '2'),
      String(BigInt(before.revision.received) + 1n),
      state.context.id
    )
    // Model a restored component mismatch without inventing a successful proof.
    const membership = jest.spyOn(state.membership, 'memberships').mockReturnValue([
      ...members,
      {
        ...original,
        scope: scope('host-b'),
        observationId: 'unlinked',
        phase: 'live',
        sequence: '2'
      }
    ])
    try {
      const result = state.snapshot(),
        selected = reports(result.assessments)
      expect(result.facts).toEqual(before.facts)
      expect(
        selected.find(row => row.origin.kind === 'source' && row.origin.scope.provider === 'host-a')
          ?.state
      ).toBe('reported-unspent')
      expect(
        selected.find(row => row.origin.kind === 'source' && row.origin.scope.provider === 'host-b')
      ).toMatchObject({ state: 'stale', evidenceIds: [] })
    } finally {
      membership.mockRestore()
    }
    expect(state.snapshot()).toEqual(before)
  })

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

  it('seals configured rules and prevents changing an existing journal policy', async () => {
    const storage = new MemoryJournal('policy'),
      original = open(storage)
    await initialize(original.store)
    expect((await original.store.inspect()).entries[0].local).toMatchObject({
      version: 3,
      currentnessRules: [rule()]
    })
    await expect(open(storage, [rule('host-a', '3')]).store.read()).rejects.toMatchObject({
      code: 'reset-required'
    })
    await expect(open(storage, []).store.read()).rejects.toMatchObject({ code: 'reset-required' })
    const emptyStorage = new MemoryJournal('empty-policy'),
      empty = open(emptyStorage, [])
    await initialize(empty.store)
    expect((await empty.store.inspect()).entries[0].local).toMatchObject({
      version: 3,
      currentnessRules: []
    })
    expect((await open(emptyStorage, []).store.read()).revision.accepted).toBe('1')
    await expect(open(emptyStorage, [rule()]).store.read()).rejects.toMatchObject({
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

it('rejects an invalid currentness clock and permits a later valid pass', async () => {
  const { store, worker, clock } = open()
  await initialize(store)
  clock.now = -1
  await expect(worker.advance(store, abort())).rejects.toThrow('Invalid currentness clock')
  clock.now = base
  await worker.advance(store, abort())
  expect((await store.revision()).received).toBe('1')
})

it('does not publish expired currentness when its durable invalidation fails', async () => {
  const { store, worker, clock } = open()
  await initialize(store)
  await ingest(store, worker, batch('initial', [output()], base))
  const before = await store.revision()
  clock.now = base + 2000
  const failing = jest
    .spyOn(store, 'commit')
    .mockResolvedValueOnce({ status: 'context-changed', reason: 'Synthetic expiry write conflict' })
  try {
    await expect(worker.advance(store, abort())).rejects.toMatchObject({ code: 'context-changed' })
    expect(await store.revision()).toEqual(before)
    await expect(store.read()).rejects.toMatchObject({ code: 'expired' })
  } finally {
    failing.mockRestore()
  }
  await worker.advance(store, abort())
  expect(reports((await store.read()).assessments).every(row => row.state === 'stale')).toBe(true)
})

describe('Bitcoin currentness worker clock and durable expiry failures', () => {
  it('accepts the Unix epoch as a valid currentness clock', async () => {
    const { store, worker } = open(undefined, [rule()], { now: 0 })
    await initialize(store)
    await expect(worker.advance(store, abort())).resolves.toBeUndefined()
    expect(await store.revision()).toEqual({ received: '1', accepted: '1' })
  })

  it.each([
    [Number.NaN, 'invalid', 'Invalid currentness clock', false],
    [Number.POSITIVE_INFINITY, 'limited', 'Bitcoin journal replay deadline exhausted', true],
    [0.5, 'invalid', 'Invalid currentness clock', false]
  ] as const)(
    'rejects invalid currentness clock %s and permits recovery',
    async (invalid, code, message, retryable) => {
      const { store, worker, clock } = open()
      await initialize(store)
      const retained = await store.inspect()
      clock.now = invalid
      await expect(worker.advance(store, abort())).rejects.toMatchObject({
        code,
        message,
        retryable
      })
      expect(await store.inspect()).toEqual(retained)
      clock.now = base
      await expect(worker.advance(store, abort())).resolves.toBeUndefined()
    }
  )

  it.each(['limited', 'equivocation'] as const)(
    'preserves a %s expiry refusal without extending source freshness',
    async status => {
      const { store, worker, clock } = open()
      await initialize(store)
      await ingest(store, worker, batch('expiry-refusal', [output()], clock.now))
      const retained = await store.inspect(),
        reason = `Injected expiry ${status} refusal`,
        commit = jest.spyOn(store, 'commit').mockResolvedValue({ status, reason })
      clock.now += 2000
      try {
        await expect(worker.advance(store, abort())).rejects.toMatchObject({
          code: status,
          message: reason,
          retryable: false
        })
        expect(commit).toHaveBeenCalledTimes(1)
        expect(await store.inspect()).toEqual(retained)
        await expect(store.read()).rejects.toMatchObject({ code: 'expired' })
      } finally {
        commit.mockRestore()
      }
      await worker.advance(store, abort())
      expect(reports((await store.read()).assessments).every(row => row.state === 'stale')).toBe(
        true
      )
      expect((await store.inspect()).entries.at(-1)?.body.kind).toBe('invalidate')
    }
  )
})
