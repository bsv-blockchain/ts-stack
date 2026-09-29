import { afterEach, describe, expect, it } from '@jest/globals'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { canonicalOutputJSON } from '@bsv/sdk'
import {
  BitcoinKnowledge,
  KnowledgeStore,
  SDKEvidenceVerifier,
  SourceMembershipLedger,
  knowledgeMutation,
  parseSourceBatch,
  runtimeLimits,
  type OutputObservation,
  type OutputScope,
  type SourceBatch,
  type SourceCurrentnessRule
} from '../src/index.js'
import { SQLiteJournal } from '../src/storage/SQLiteJournal.js'
import { SourceQuarantine } from '../src/SourceQuarantine.js'
import { candidate, chain, context, partition, resolver } from './evidence-fixture.js'

const scope: OutputScope = {
  chain,
  provider: 'host-a',
  service: 'records',
  queryDigest: '11'.repeat(32),
  rulesDigest: '22'.repeat(32),
  access: 'public',
  epoch: 'original'
}
const now = Date.now(),
  receivedAt = String(Math.floor(now / 1000))
function output(id = 'stable', selectedScope = scope): OutputObservation {
  return {
    id,
    scope: selectedScope,
    kind: 'output',
    payload: { evidence: candidate('A').evidence }
  }
}
function batch(id: string, generation = '0', selectedScope = scope): SourceBatch {
  const value: SourceBatch = {
    provenance: {
      partition,
      generation,
      adapter: selectedScope.provider,
      scope: selectedScope,
      authentication: 'configured-transport',
      peer: selectedScope.provider,
      receivedAt
    },
    groups: [{ id, sequence: '10', observations: [output('stable', selectedScope)] }],
    coverage: {
      scope: selectedScope,
      phase: 'snapshot',
      status: 'complete',
      through: '10',
      highWater: '10'
    }
  }
  return parseSourceBatch(value, value.provenance, runtimeLimits())
}
function changed(generation = '1'): SourceBatch {
  const value = batch('changed', generation)
  value.groups[0].observations[0] = {
    id: 'stable',
    scope,
    kind: 'withdraw',
    payload: {
      outpoint: { chain, txid: candidate('A').evidence.txid, outputIndex: 0 },
      reason: 'Private conflicting assertion'
    }
  }
  return value
}
function seed(ledger: SourceMembershipLedger): void {
  ledger.receive(batch('seed'), '1')
  ledger.decide(scope, '0', 'seed', 'accepted')
}
const stores: KnowledgeStore[] = [],
  directories: string[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('bounded source equivocation quarantine', () => {
  it('keeps an identical retained claim idempotent without changing its first receipt', () => {
    const quarantine = new SourceQuarantine({ receipts: 1 }),
      fault = changed()
    quarantine.retain(fault, '2', 'First reason')
    const original = quarantine.entries(),
      bytes = quarantine.bytes
    quarantine.retain(fault, '3', 'Repeated')
    expect(quarantine.entries()).toEqual(original)
    expect(quarantine.bytes).toBe(bytes)
  })
  it('retains the full claim, preserves the first identity, and fences the entire failed generation', () => {
    const ledger = new SourceMembershipLedger()
    seed(ledger)
    const fault = changed()
    fault.groups[0].observations.unshift(output('innocent-sibling'))
    expect(ledger.receiveRetainingEquivocation(fault, '2')).toBe('quarantined')
    const saved = ledger.quarantines()
    expect(saved).toEqual([
      {
        batch: fault,
        received: '2',
        reason: 'Observation identity changed within the source epoch',
        mutationKey: knowledgeMutation({ kind: 'receive', batch: fault }).key
      }
    ])
    expect(ledger.quarantineBytes()).toBeGreaterThan(0)
    saved[0].batch.groups.splice(0)
    fault.groups.splice(0)
    expect(ledger.quarantines()[0].batch.groups).toHaveLength(1)
    expect(ledger.memberships()[0]).toMatchObject({ generation: '0', present: true })
    expect(ledger.observations().map(row => row.id)).toEqual(['stable'])
    expect(ledger.isContinuous(scope, '0')).toBe(false)
    expect(ledger.canAccept(scope, '1')).toBe(false)
    expect(ledger.hasPendingContinuity()).toBe(true)
    ledger.acceptContinuity()
    expect(ledger.hasPendingContinuity()).toBe(false)
    expect(() => ledger.receiveRetainingEquivocation(batch('retry', '1'), '3')).toThrow(
      'continuity'
    )
    expect(() => ledger.decide(scope, '0', 'seed', 'accepted')).toThrow('retired')
    const recovery = batch('recovery', '2')
    recovery.groups[0].observations.push(output('innocent-sibling'))
    expect(ledger.receiveRetainingEquivocation(recovery, '3')).toBe('received')
    ledger.decide(scope, '2', 'recovery', 'accepted')
    expect(ledger.isContinuous(scope, '2')).toBe(true)
    expect(ledger.pending()).toEqual([])
    expect(ledger.quarantines()).toHaveLength(1)
    expect(ledger.receiveRetainingEquivocation(changed('3'), '4')).toBe('quarantined')
  })

  it('quarantines pending siblings without deleting already accepted facts or other providers', () => {
    const ledger = new SourceMembershipLedger(),
      other = { ...scope, provider: 'host-b' }
    seed(ledger)
    ledger.receive(batch('b', '0', other), '2')
    ledger.decide(other, '0', 'b', 'accepted')
    const pending = batch('pending')
    pending.groups[0] = { id: 'pending', sequence: '11', observations: [output('pending')] }
    pending.coverage = { scope, phase: 'live', status: 'partial', through: '11' }
    ledger.receive(pending, '3')
    const fault = structuredClone(pending)
    fault.groups[0].observations[0] = output('different')
    expect(ledger.receiveRetainingEquivocation(fault, '4')).toBe('quarantined')
    expect(ledger.groups().find(row => row.group.id === 'pending')?.status).toBe('quarantined')
    expect(ledger.groups().find(row => row.group.id === 'seed')?.status).toBe('accepted')
    expect(ledger.memberships()).toHaveLength(2)
    expect(ledger.isContinuous(other, '0')).toBe(true)
    expect(ledger.isContinuous(scope, '0')).toBe(false)
    expect(ledger.pending()).toHaveLength(1)
  })

  it('retains watermark equivocation even when a response has no groups', () => {
    const ledger = new SourceMembershipLedger()
    seed(ledger)
    const fault = batch('unused')
    fault.groups = []
    fault.coverage.through = '11'
    fault.coverage.highWater = '11'
    expect(ledger.receiveRetainingEquivocation(fault, '2')).toBe('quarantined')
    expect(ledger.pending()).toEqual([
      {
        scope,
        groupId: `quarantine:${knowledgeMutation({ kind: 'receive', batch: fault }).key}`,
        reason: 'Source equivocation quarantined; generation reset required'
      }
    ])
  })

  it('enforces exact byte and receipt bounds before any generation or identity mutation', () => {
    const fault = changed(),
      bytes = new TextEncoder().encode(
        canonicalOutputJSON({ kind: 'receive', batch: fault })
      ).length
    const short = new SourceMembershipLedger({ bytes: bytes - 1 })
    seed(short)
    expect(() => short.receiveRetainingEquivocation(fault, '2')).toThrow('capacity')
    expect(short.isContinuous(scope, '0')).toBe(true)
    expect(short.quarantines()).toEqual([])
    const exact = new SourceMembershipLedger({ bytes })
    seed(exact)
    expect(exact.receiveRetainingEquivocation(fault, '2')).toBe('quarantined')
    expect(exact.quarantineBytes()).toBe(bytes)
    const bounded = new SourceMembershipLedger({ receipts: 1 })
    seed(bounded)
    bounded.receiveRetainingEquivocation(fault, '2')
    expect(() => bounded.receiveRetainingEquivocation(changed('2'), '3')).toThrow('capacity')
    expect(bounded.isCurrent(scope, '1')).toBe(true)
    expect(bounded.quarantines()).toHaveLength(1)
    for (const limits of [
      { receipts: 0 },
      { receipts: 65 },
      { bytes: -1 },
      { bytes: 16 * 1024 * 1024 + 1 },
      { bytes: 1.5 }
    ])
      expect(() => new SourceMembershipLedger(limits)).toThrow('bound')
  })

  it('records explicit reset coverage as pending reconciliation without treating an outage as a reset', () => {
    const ledger = new SourceMembershipLedger()
    seed(ledger)
    const status = batch('unused')
    status.groups = []
    status.coverage.phase = 'live'
    status.coverage.status = 'unavailable'
    ledger.receiveRetainingEquivocation(status, '2')
    expect(ledger.hasPendingContinuity()).toBe(false)
    expect(ledger.isContinuous(scope, '0')).toBe(true)
    status.coverage.status = 'reset-required'
    ledger.receiveRetainingEquivocation(status, '3')
    expect(ledger.hasPendingContinuity()).toBe(true)
    expect(ledger.isContinuous(scope, '0')).toBe(false)
    expect(ledger.pending()).toEqual([
      {
        scope,
        groupId: 'continuity-reset:0',
        reason: 'Source continuity unavailable; generation reset required'
      }
    ])
  })

  it('persists source-scoped invalidation and recovery through SQLite with offline replay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'source-quarantine-'))
    directories.push(dir)
    const path = join(dir, 'knowledge.sqlite'),
      other = { ...scope, provider: 'host-b' }
    const rules = [scope, other].map(({ epoch: _epoch, ...source }): SourceCurrentnessRule => ({
      source,
      maximumAgeSeconds: '600'
    }))
    const open = (offline = false) => {
      const worker = new BitcoinKnowledge({
        journalId: 'journal',
        partition,
        nonFinal: true,
        sourceCurrentness: rules,
        verifier: offline
          ? {
              async verify() {
                throw new Error('Offline replay must use retained proofs')
              }
            }
          : new SDKEvidenceVerifier(resolver)
      })
      const store = new KnowledgeStore(new SQLiteJournal(path, 'journal'), worker, {
        partition,
        now: () => now
      })
      stores.push(store)
      return { worker, store }
    }
    const { worker, store } = open(),
      signal = new AbortController().signal
    const receive = async (selected: KnowledgeStore, input: SourceBatch) =>
      selected.commit(
        (await selected.revision()).received,
        knowledgeMutation({ kind: 'receive', batch: input })
      )
    await store.commit('0', knowledgeMutation({ kind: 'context', context: context() }))
    await receive(store, batch('a'))
    await worker.advance(store, signal)
    await receive(store, batch('b', '0', other))
    await worker.advance(store, signal)
    const before = await store.read(),
      fault = changed()
    const committed = await receive(store, fault)
    expect(committed.status).toBe('committed')
    expect(
      (await store.read()).assessments
        .filter(row => row.origin.kind === 'source')
        .map(row => row.state)
        .sort()
    ).toEqual(['reported-unspent', 'stale'])
    expect((await store.revision()).accepted).toBe(before.revision.accepted)
    await store.close()
    const restored = open(true)
    await restored.worker.advance(restored.store, signal)
    const result = await restored.store.read()
    expect(BigInt(result.revision.accepted)).toBe(BigInt(before.revision.accepted) + 1n)
    expect(result.facts).toEqual(before.facts)
    expect(result.reconciled.transactions).toEqual(before.reconciled.transactions)
    expect(result.reconciled.memberships).toEqual(before.reconciled.memberships)
    expect(result.pendingGroups).toHaveLength(1)
    expect(canonicalOutputJSON(result)).not.toContain('Private conflicting assertion')
    const journal = await restored.store.inspect()
    expect(
      journal.entries.find(
        row => row.key === knowledgeMutation({ kind: 'receive', batch: fault }).key
      )?.body
    ).toEqual({ kind: 'receive', batch: fault })
    expect(await receive(restored.store, fault)).toMatchObject({ status: 'replayed' })
    await restored.worker.advance(restored.store, signal)
    expect(await restored.store.read()).toEqual(result)
    await expect(receive(restored.store, batch('same-generation', '1'))).rejects.toMatchObject({
      code: 'reset-required'
    })
    await restored.store.close()
    const recovery = open()
    await receive(recovery.store, batch('fresh-seed', '2'))
    await recovery.worker.advance(recovery.store, signal)
    const recovered = await recovery.store.read()
    expect(recovered.pendingGroups).toEqual([])
    expect(
      recovered.assessments
        .filter(row => row.origin.kind === 'source')
        .every(row => row.state === 'reported-unspent')
    ).toBe(true)
    expect(recovered.facts).toEqual(before.facts)
  })

  it('rejects malformed or foreign-scope claims before they can invalidate a trusted source', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'source-boundary-'))
    directories.push(dir)
    const worker = new BitcoinKnowledge({
      journalId: 'journal',
      partition,
      nonFinal: true,
      verifier: new SDKEvidenceVerifier(resolver)
    })
    const store = new KnowledgeStore(
      new SQLiteJournal(join(dir, 'knowledge.sqlite'), 'journal'),
      worker,
      { partition }
    )
    stores.push(store)
    await store.commit('0', knowledgeMutation({ kind: 'context', context: context() }))
    await store.commit('1', knowledgeMutation({ kind: 'receive', batch: batch('seed') }))
    await worker.advance(store, new AbortController().signal)
    const before = await store.read(),
      revision = await store.revision()
    const foreign = changed()
    foreign.groups[0].observations[0].scope = { ...scope, access: 'other-account' }
    await expect(
      store.commit(revision.received, knowledgeMutation({ kind: 'receive', batch: foreign }))
    ).rejects.toMatchObject({ code: 'invalid' })
    expect(await store.read()).toEqual(before)
    expect(await store.revision()).toEqual(revision)
  })
})
