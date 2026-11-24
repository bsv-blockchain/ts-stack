import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Beef, Utils } from '@bsv/sdk'
import { BitcoinKnowledge } from '../src/BitcoinKnowledge.js'
import { KnowledgeStore } from '../src/KnowledgeStore.js'
import { MemoryJournal } from '../src/storage/MemoryJournal.js'
import { SQLiteJournal } from '../src/storage/SQLiteJournal.js'
import { knowledgeMutation, type JournalStorage } from '../src/storage/Journal.js'
import { SDKEvidenceVerifier } from '../src/SDKEvidenceVerifier.js'
import { OutputKnowledge } from '../src/OutputKnowledge.js'
import { runtimeLimits } from '../src/validation.js'
import type { EvidenceVerifier, OutputObservation, OutputScope, SourceBatch } from '../src/ports.js'
import { candidate, chain, context, corpus, partition, resolver } from './evidence-fixture.js'

const scope: OutputScope = {
  chain,
  provider: 'local-source',
  service: 'records',
  queryDigest: '03'.repeat(32),
  rulesDigest: '04'.repeat(32),
  access: 'public',
  epoch: 'initial'
}
function output(name: string, id = name, partial = false): OutputObservation {
  const evidence = candidate(name).evidence
  if (partial) {
    const beef = new Beef()
    beef.mergeRawTx(Utils.toArray(corpus.transactions[name].raw, 'hex'))
    evidence.beef = Utils.toBase64(beef.toBinary())
  }
  return { id, scope, kind: 'output', payload: { evidence } }
}
function batch(
  id: string,
  observations: OutputObservation[],
  sequence = '0',
  generation = '0',
  phase: SourceBatch['coverage']['phase'] = 'finite'
): SourceBatch {
  return {
    provenance: {
      partition,
      generation,
      adapter: 'fixture',
      scope,
      authentication: 'configured-transport',
      peer: scope.provider,
      receivedAt: '1'
    },
    groups: [{ id, sequence, observations }],
    coverage: {
      scope,
      phase,
      status: 'complete',
      ...(phase === 'finite' ? {} : { through: sequence, highWater: sequence })
    }
  }
}
const signal = () => new AbortController().signal
const stores: KnowledgeStore[] = [],
  dirs: string[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function open(
  storage: JournalStorage = new MemoryJournal('journal'),
  verifier: EvidenceVerifier = new SDKEvidenceVerifier(resolver),
  maximumChecks?: number
) {
  const worker = new BitcoinKnowledge({
      journalId: storage.namespace,
      partition,
      nonFinal: true,
      verifier,
      maximumChecks
    }),
    store = new KnowledgeStore(storage, worker, { partition })
  stores.push(store)
  return { worker, store }
}
async function initialize(store: KnowledgeStore) {
  await store.commit('0', knowledgeMutation({ kind: 'context', context: context() }))
}
async function receive(store: KnowledgeStore, value: SourceBatch) {
  const revision = await store.revision()
  return store.commit(revision.received, knowledgeMutation({ kind: 'receive', batch: value }))
}
const tx = (name: string) => corpus.transactions[name].txid

describe('default Bitcoin knowledge journal and worker', () => {
  it('retains dependency-limited evidence without verifying it and quarantines an invalid sibling atomically', async () => {
    const storage = new MemoryJournal('evidence-capacity'),
      verifier = new SDKEvidenceVerifier(resolver),
      verify = jest.spyOn(verifier, 'verify'),
      worker = new BitcoinKnowledge({
        journalId: storage.namespace,
        partition,
        nonFinal: true,
        verifier,
        limits: { dependencies: 1 }
      }),
      store = new KnowledgeStore(storage, worker, { partition }),
      malformed: OutputObservation = {
        id: 'malformed',
        scope,
        kind: 'output',
        payload: { evidence: { ...candidate('Q').evidence, beef: 'AA==' } }
      }
    stores.push(store)
    await initialize(store)
    expect(
      (await receive(store, batch('bounded-group', [output('A', 'limited'), malformed]))).status
    ).toBe('committed')
    await worker.advance(store, signal())
    const history = await store.inspect(),
      acceptance = history.entries.find(entry => entry.body.kind === 'accept')!.body
    expect(acceptance.kind).toBe('accept')
    if (acceptance.kind !== 'accept') throw new Error('Missing quarantined group decision')
    expect(acceptance.results.map(result => result.status)).toEqual(['limited', 'invalid'])
    expect(acceptance.results).toEqual([
      expect.objectContaining({
        contextId: context().id,
        reason: 'Whole-group cryptographic evidence is incomplete',
        dependencies: []
      }),
      expect.objectContaining({
        contextId: context().id,
        reason: 'Source evidence does not fulfill its asserted observation',
        dependencies: []
      })
    ])
    expect(verify).not.toHaveBeenCalled()
    expect(await store.read()).toMatchObject({ facts: [], reconciled: { memberships: [] } })
  })

  it('accepts a genuine multi-input spend claim for any one consumed outpoint', async () => {
    const { store, worker } = open(),
      previous = { chain, txid: tx('P'), outputIndex: 1 }
    await initialize(store)
    await receive(
      store,
      batch('multi-input-spend', [
        {
          id: 'spend',
          scope,
          kind: 'spend',
          payload: {
            previous,
            spendingTxid: tx('allFinal'),
            beef: candidate('allFinal').evidence.beef
          }
        }
      ])
    )
    await worker.advance(store, signal())
    const result = await store.read(),
      acceptance = (await store.inspect()).entries.find(entry => entry.body.kind === 'accept')!.body
    expect(result.pendingGroups).toEqual([])
    expect(result.facts.some(fact => fact.txid === tx('allFinal'))).toBe(true)
    expect(
      result.assessments.find(
        row => row.outpoint.txid === previous.txid && row.outpoint.outputIndex === 1
      )
    ).toMatchObject({ state: 'spent', origin: { kind: 'local' } })
    expect(acceptance.kind).toBe('accept')
    if (acceptance.kind !== 'accept') throw new Error('Missing genuine spend acceptance')
    expect(acceptance.results[0]).toMatchObject({
      status: 'verified',
      fact: { txid: tx('allFinal') }
    })
  })

  it('owns the installed critical-extension vocabulary across later caller mutations', async () => {
    const extension = 'urn:example:record-extension',
      installed = [extension],
      storage = new MemoryJournal('extensions'),
      worker = new BitcoinKnowledge({
        journalId: storage.namespace,
        partition,
        nonFinal: true,
        verifier: new SDKEvidenceVerifier(resolver),
        supportedExtensions: installed
      }),
      store = new KnowledgeStore(storage, worker, { partition })
    stores.push(store)
    installed.length = 0
    await initialize(store)
    const observation = {
      ...output('Q'),
      extensions: { [extension]: { version: 1 } },
      critical: [extension]
    }
    expect((await receive(store, batch('extended', [observation]))).status).toBe('committed')
    await worker.advance(store, signal())
    expect((await store.read()).reconciled.memberships).toHaveLength(1)
    const unsupported = {
      ...output('A'),
      extensions: { 'urn:example:uninstalled': {} },
      critical: ['urn:example:uninstalled']
    }
    await expect(receive(store, batch('unsupported', [unsupported]))).rejects.toMatchObject({
      code: 'unsupported'
    })
    expect((await store.read()).reconciled.memberships).toHaveLength(1)
  })

  it('refuses the same journal name in another account before reading or verifying it', async () => {
    const first = open(),
      otherStorage = new MemoryJournal(first.store.journalId),
      other = new KnowledgeStore(otherStorage, first.worker, {
        partition: { ...partition, account: 'other' }
      })
    stores.push(other)
    await initialize(first.store)
    await expect(first.worker.advance(other, signal())).rejects.toMatchObject({
      code: 'unauthorized',
      message: expect.stringContaining('another journal partition')
    })
    await expect(first.worker.pendingBytes(other, signal())).rejects.toMatchObject({
      code: 'unauthorized'
    })
    expect(await otherStorage.head()).toMatchObject({ received: '0', entries: 0 })
    expect(await first.store.revision()).toEqual({ received: '1', accepted: '1' })
  })

  it('rejects cancelled replay and enforces the inclusive replay deadline without changing retained history', async () => {
    let now = 0,
      samplingDeadline = false
    const storage = new MemoryJournal('replay-deadline'),
      worker = new BitcoinKnowledge({
        journalId: storage.namespace,
        partition,
        nonFinal: true,
        verifier: new SDKEvidenceVerifier(resolver),
        limits: { deadlineMs: 100 },
        now: () => {
          const sampled = now
          if (samplingDeadline) now += 100
          return sampled
        }
      }),
      store = new KnowledgeStore(storage, worker, { partition })
    stores.push(store)
    await initialize(store)
    const retained = await store.inspect(),
      abort = new AbortController()
    abort.abort()
    await expect(worker.reduce(retained.entries, abort.signal)).rejects.toMatchObject({
      code: 'cancelled',
      message: expect.stringContaining('work cancelled')
    })
    samplingDeadline = true
    await expect(worker.reduce(retained.entries, signal())).rejects.toMatchObject({
      code: 'limited',
      retryable: true,
      message: expect.stringContaining('journal replay deadline')
    })
    samplingDeadline = false
    await expect(worker.reduce(retained.entries, signal())).resolves.toMatchObject({
      revision: retained.revision
    })
    expect(await store.inspect()).toEqual(retained)
  })

  it('owns configured receipt limits and retains them when the caller changes its options', async () => {
    const limits = runtimeLimits({ observations: 1 }),
      storage = new MemoryJournal('owned-limits'),
      worker = new BitcoinKnowledge({
        journalId: storage.namespace,
        partition,
        nonFinal: true,
        verifier: new SDKEvidenceVerifier(resolver),
        limits
      }),
      store = new KnowledgeStore(storage, worker, { partition })
    stores.push(store)
    limits.observations = 2
    await initialize(store)
    await expect(
      receive(store, batch('oversized', [output('Q'), output('A')]))
    ).rejects.toMatchObject({
      code: 'limited'
    })
    expect(await store.revision()).toEqual({ received: '1', accepted: '1' })
    expect((await receive(store, batch('bounded', [output('Q')]))).status).toBe('committed')
    await worker.advance(store, signal())
    expect((await store.read()).reconciled.memberships).toHaveLength(1)
  })

  it('rejects an accepted transition before an initial context without appending it', async () => {
    const origin = open()
    await initialize(origin.store)
    await receive(origin.store, batch('accepted', [output('Q')]))
    await origin.worker.advance(origin.store, signal())
    const transition = (await origin.store.inspect()).entries.find(
      entry => entry.body.kind === 'accept' || entry.body.kind === 'reconcile'
    )
    expect(transition).toBeDefined()
    const empty = open()
    await expect(
      empty.store.commit('0', knowledgeMutation(transition!.body))
    ).rejects.toMatchObject({
      code: 'revision-unavailable'
    })
    expect(await empty.store.revision()).toEqual({ received: '0', accepted: '0' })
    expect((await empty.store.inspect()).entries).toEqual([])
  })

  it('requires a retained spend policy and rejects reopening it with a different policy', async () => {
    const unsealed = new MemoryJournal('journal')
    await unsealed.append('0', knowledgeMutation({ kind: 'context', context: context() }))
    await expect(open(unsealed).store.read()).rejects.toMatchObject({ code: 'reset-required' })
    const storage = new MemoryJournal('sealed'),
      first = open(storage)
    await initialize(first.store)
    const changed = new KnowledgeStore(
      storage,
      new BitcoinKnowledge({
        journalId: storage.namespace,
        partition,
        nonFinal: false,
        verifier: new SDKEvidenceVerifier(resolver)
      }),
      { partition }
    )
    stores.push(changed)
    await expect(changed.read()).rejects.toMatchObject({ code: 'reset-required' })
  })

  it('persists receipt before actual SDK verification and recovers accepted facts and selection without network access', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bitcoin-knowledge-'))
    dirs.push(dir)
    const path = join(dir, 'knowledge.sqlite'),
      { store, worker } = open(new SQLiteJournal(path, 'journal'))
    await initialize(store)
    await receive(store, batch('initial', [output('A'), output('B')]))
    const pending = await store.read()
    expect(pending.revision).toEqual({ received: '2', accepted: '1' })
    expect(pending.facts).toEqual([])
    expect(pending.pendingGroups).toHaveLength(1)
    await worker.advance(store, signal())
    const accepted = await store.read()
    expect(
      accepted.reconciled.transactions.find(row => row.txid === tx('A'))?.status ===
        'selected-final' ||
        accepted.reconciled.transactions.find(row => row.txid === tx('B'))?.status ===
          'selected-final'
    ).toBe(true)
    expect(
      accepted.reconciled.transactions.filter(row => row.status === 'conflicting')
    ).toHaveLength(1)
    expect(accepted.reconciled.memberships).toHaveLength(2)
    expect(accepted.pendingGroups).toEqual([])
    expect((await store.inspect()).entries.at(-1)?.local).toBeDefined()
    await store.close()
    const reopened = open(new SQLiteJournal(path, 'journal'), {
      async verify() {
        throw new Error('Replay must not call the network')
      }
    })
    expect(await reopened.store.read()).toEqual(accepted)
    await reopened.worker.advance(reopened.store, signal())
    expect(await reopened.store.read()).toEqual(accepted)
  })

  it('joins a successor received before its predecessor across two authenticated source scopes', async () => {
    const { store, worker } = open()
    await initialize(store)
    await receive(store, batch('child', [output('QC', 'child', true)]))
    await worker.advance(store, signal())
    expect(
      (await store.read()).reconciled.transactions.find(row => row.txid === tx('QC'))?.order
    ).toBeUndefined()
    const parent = batch('parent', [output('Q')])
    parent.provenance.scope = { ...scope, provider: 'other-source' }
    parent.provenance.peer = 'other-source'
    parent.coverage.scope = parent.provenance.scope
    parent.groups[0].observations[0].scope = parent.provenance.scope
    await receive(store, parent)
    await worker.advance(store, signal())
    const result = await store.read(),
      child = result.reconciled.transactions.find(row => row.txid === tx('QC'))!
    expect(child).toMatchObject({
      status: 'selected-final',
      firstRaw: { position: '2' },
      order: { readyAt: '3', depth: 1 }
    })
    expect(result.assessments.find(row => row.outpoint.txid === tx('Q'))?.state).toBe('spent')
    expect(result.assessments.find(row => row.outpoint.txid === tx('QC'))?.state).toBe('unknown')
    expect(result.reconciled.memberships).toHaveLength(2)
  })

  it('recovers epoch identities across SQLite restart and durably quarantines changed refresh bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bitcoin-identities-'))
    dirs.push(dir)
    const path = join(dir, 'knowledge.sqlite'),
      original = open(new SQLiteJournal(path, 'journal'))
    await initialize(original.store)
    await receive(original.store, batch('initial', [output('A', 'stable')]))
    await original.worker.advance(original.store, signal())
    await receive(original.store, batch('refresh', [output('A', 'stable')], '0', '1'))
    await original.worker.advance(original.store, signal())
    const accepted = await original.store.read()
    await original.store.close()
    const restored = open(new SQLiteJournal(path, 'journal'))
    expect(await restored.store.read()).toEqual(accepted)
    await expect(
      receive(
        restored.store,
        batch(
          'changed',
          [
            {
              id: 'stable',
              scope,
              kind: 'withdraw',
              payload: {
                outpoint: { chain, txid: tx('A'), outputIndex: 0 },
                reason: 'Changed meaning'
              }
            }
          ],
          '0',
          '2'
        )
      )
    ).resolves.toMatchObject({ status: 'committed' })
    await restored.worker.advance(restored.store, signal())
    const quarantined = await restored.store.read()
    expect(quarantined.facts).toEqual(accepted.facts)
    expect(quarantined.reconciled.memberships).toEqual(accepted.reconciled.memberships)
    expect(quarantined.pendingGroups).toEqual([
      {
        scope,
        groupId: 'changed',
        reason: 'Source equivocation quarantined; generation reset required'
      }
    ])
    expect(BigInt(quarantined.revision.accepted)).toBe(BigInt(accepted.revision.accepted) + 1n)
    await restored.store.close()
    expect(await open(new SQLiteJournal(path, 'journal')).store.read()).toEqual(quarantined)
  })

  it('quarantines a source group with a malformed sibling while retaining independent valid evidence', async () => {
    const { store, worker } = open()
    await initialize(store)
    const malformed = output('Q', 'malformed')
    if (malformed.kind === 'output') malformed.payload.evidence.beef = 'AA=='
    await receive(store, batch('bad', [output('A'), malformed]))
    await worker.advance(store, signal())
    const bad = await store.read()
    expect(bad.reconciled.memberships).toEqual([])
    expect(bad.pendingGroups[0].reason).toContain('quarantined')
    const replacement = batch('replacement', [output('A', 'good')], '0', '1')
    await receive(store, replacement)
    await worker.advance(store, signal())
    const good = await store.read()
    expect(good.reconciled.transactions.find(row => row.txid === tx('A'))).toMatchObject({
      status: 'selected-final',
      firstRaw: { position: '2' },
      order: { readyAt: '4' }
    })
    expect(good.reconciled.memberships[0].generation).toBe('1')
  })

  it('rejects fabricated acceptance or generation/partition transitions before storage mutation', async () => {
    const { store, worker } = open()
    await initialize(store)
    await receive(store, batch('initial', [output('A')]))
    await worker.advance(store, signal())
    const snapshot = await store.read(),
      before = await store.revision()
    const falseState = {
      ...snapshot.reconciled,
      through: String(BigInt(before.received) + 1n),
      transactions: []
    }
    await expect(
      store.commit(
        before.received,
        knowledgeMutation({
          kind: 'reconcile',
          generation: '0',
          contextId: snapshot.context.id,
          reconciled: falseState,
          assessments: []
        })
      )
    ).rejects.toThrow('deterministic')
    const foreign = context()
    foreign.partition = { ...partition, account: 'another-account' }
    foreign.id = 'other-context'
    await expect(
      store.commit(before.received, knowledgeMutation({ kind: 'context', context: foreign }))
    ).rejects.toThrow('partition')
    expect(await store.revision()).toEqual(before)
  })

  it('retains a bounded verification pass and resumes without changing transaction arrival order', async () => {
    const { store, worker } = open(undefined, undefined, 1)
    await initialize(store)
    await receive(store, batch('initial', [output('A')]))
    await expect(worker.advance(store, signal())).rejects.toMatchObject({ code: 'limited' })
    const partial = await store.read()
    expect(partial.pendingGroups).toHaveLength(1)
    expect(
      partial.reconciled.transactions.find(row => row.txid === tx('A'))?.firstRaw.position
    ).toBe('2')
    await worker.advance(store, signal())
    const ready = await store.read()
    expect(ready.pendingGroups).toEqual([])
    expect(ready.reconciled.transactions.find(row => row.txid === tx('A'))?.order?.readyAt).toBe(
      '2'
    )
  })

  it('preserves the historical non-final replacement journal while revalidating a new context', async () => {
    const { store, worker } = open()
    await initialize(store)
    await receive(store, batch('n', [output('N')], '10', '0', 'snapshot'))
    await worker.advance(store, signal())
    await receive(store, batch('r', [output('R')], '11', '0', 'live'))
    await worker.advance(store, signal())
    const before = await store.read()
    expect(before.reconciled.replacements).toHaveLength(1)
    expect(before.reconciled.replacements[0]).toMatchObject({
      previous: tx('N'),
      replacement: tx('R')
    })
    await store.commit(
      (await store.revision()).received,
      knowledgeMutation({ kind: 'context', context: context('mature') })
    )
    const pending = await store.read()
    expect(pending.reconciled.replacements).toEqual(before.reconciled.replacements)
    expect(pending.facts).toEqual(before.facts)
    expect(pending.reconciled.transactions.find(row => row.txid === tx('R'))?.status).toBe(
      'unresolved'
    )
    await worker.advance(store, signal())
    const after = await store.read()
    expect(after.reconciled.replacements).toEqual(before.reconciled.replacements)
    expect(after.reconciled.transactions.find(row => row.txid === tx('N'))?.status).toBe(
      'conflicting'
    )
    expect(after.reconciled.transactions.find(row => row.txid === tx('R'))?.status).toBe(
      'selected-final'
    )
  })

  it('requires a spend observation to identify an actual consumed input', async () => {
    const { store, worker } = open()
    await initialize(store)
    await receive(
      store,
      batch('false-spend', [
        {
          id: 'assertion',
          kind: 'spend',
          scope,
          payload: {
            previous: { chain, txid: tx('Q'), outputIndex: 0 },
            spendingTxid: tx('A'),
            beef: candidate('A').evidence.beef
          }
        }
      ])
    )
    await worker.advance(store, signal())
    const result = await store.read()
    expect(result.pendingGroups[0].reason).toContain('quarantined')
    expect(result.facts).toEqual([])
    expect(result.assessments).toEqual([])
  })

  it('retains a consumed output as spent when a live source reports it again', async () => {
    const { store, worker } = open()
    await initialize(store)
    await receive(store, batch('p', [output('P')], '10', '0', 'snapshot'))
    await worker.advance(store, signal())
    await receive(store, batch('a', [output('A')], '11', '0', 'live'))
    await worker.advance(store, signal())
    await receive(store, batch('p-again', [output('P', 'new-report')], '12', '0', 'live'))
    await worker.advance(store, signal())
    const result = await store.read()
    expect(result.reconciled.memberships.find(row => row.outpoint.txid === tx('P'))).toMatchObject({
      present: true,
      sequence: '12'
    })
    expect(result.assessments.find(row => row.outpoint.txid === tx('P'))?.state).toBe('spent')
  })

  it('holds a newly verified chain override while a known ancestor still needs current-context evidence', async () => {
    const actual = new SDKEvidenceVerifier(resolver)
    let postpone = false
    const verifier: EvidenceVerifier = {
      async verify(input, selected, abort) {
        if (postpone && input.evidence.txid === tx('P') && selected.view.id === 'included')
          return {
            status: 'limited',
            contextId: selected.id,
            variantId: input.variantId,
            reason: 'Ancestry backend temporarily unavailable',
            dependencies: []
          }
        return actual.verify(input, selected, abort)
      }
    }
    const { store, worker } = open(undefined, verifier)
    await initialize(store)
    await receive(store, batch('a', [output('A')], '10', '0', 'snapshot'))
    await worker.advance(store, signal())
    await store.commit(
      (await store.revision()).received,
      knowledgeMutation({ kind: 'context', context: context('included') })
    )
    const included = output('B')
    if (included.kind === 'output') included.payload.evidence.beef = corpus.inclusion.beef
    await receive(store, batch('b', [included], '11', '0', 'live'))
    postpone = true
    await expect(worker.advance(store, signal())).rejects.toMatchObject({ code: 'limited' })
    const waiting = await store.read()
    expect(waiting.reconciled.transactions.find(row => row.txid === tx('B'))?.status).toBe(
      'unresolved'
    )
    postpone = false
    await worker.advance(store, signal())
    const result = await store.read()
    expect(result.reconciled.transactions.find(row => row.txid === tx('B'))?.status).toBe(
      'included'
    )
    expect(result.reconciled.transactions.find(row => row.txid === tx('A'))?.status).toBe(
      'conflicting'
    )
  })

  it('commits an empty replacement snapshot as a separate accepted boundary', async () => {
    const { store, worker } = open()
    await initialize(store)
    await receive(store, batch('initial', [output('A')]))
    await worker.advance(store, signal())
    const initial = await store.read(),
      empty = batch('unused', [], '0', '1')
    empty.groups = []
    await receive(store, empty)
    const received = await store.read()
    expect(received.revision.accepted).toBe(initial.revision.accepted)
    expect(received.reconciled.memberships).toEqual(initial.reconciled.memberships)
    await worker.advance(store, signal())
    const accepted = await store.read()
    expect(BigInt(accepted.revision.accepted)).toBe(BigInt(initial.revision.accepted) + 1n)
    expect(accepted.reconciled.memberships).toEqual([])
    expect(accepted.facts).toEqual(initial.facts)
    expect(accepted.assessments[0].state).toBe('unknown')
  })

  it('uses the public runtime for snapshot and live withdrawal without confusing membership with a Bitcoin spend', async () => {
    const { store, worker } = open(),
      runtime = new OutputKnowledge({ store, worker })
    await runtime.setContext(context())
    const first = batch('snapshot', [output('A')], '7', '0', 'snapshot'),
      removed = batch(
        'removed',
        [
          {
            kind: 'withdraw',
            id: 'withdraw-a',
            scope,
            payload: {
              outpoint: { chain, txid: tx('A'), outputIndex: 0 },
              reason: 'Catalogue removal'
            }
          }
        ],
        '8',
        '0',
        'live'
      )
    const subscription = runtime.attach(
      {
        id: 'fixture',
        async *open() {
          yield first
          yield removed
        }
      },
      { partition, generation: '0', scope, limits: runtime.limits }
    )
    await subscription.done
    await runtime.flush()
    const result = await store.read()
    expect(result.reconciled.memberships[0]).toMatchObject({ present: false, sequence: '8' })
    expect(result.assessments[0].state).toBe('unknown')
    expect(result.facts.some(row => row.txid === tx('A'))).toBe(true)
    await runtime.close()
  })
  it('durably invalidates an assessment while preserving Bitcoin facts and source membership', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bitcoin-invalidation-'))
    dirs.push(dir)
    const path = join(dir, 'knowledge.sqlite'),
      { store, worker } = open(new SQLiteJournal(path, 'journal'))
    await initialize(store)
    await receive(store, batch('initial', [output('A')]))
    await worker.advance(store, signal())
    const before = await store.read(),
      assessment = before.assessments.find(row => row.outpoint.txid === tx('A'))!
    expect(assessment.state).toBe('unknown')
    await store.commit(
      before.revision.received,
      knowledgeMutation({
        kind: 'invalidate',
        generation: '0',
        assessmentIds: [assessment.id],
        reason: 'Application trust policy expired'
      })
    )
    const invalidated = await store.read()
    expect(invalidated.assessments.find(row => row.outpoint.txid === tx('A'))).toMatchObject({
      state: 'stale'
    })
    expect(invalidated.facts).toEqual(before.facts)
    expect(invalidated.reconciled.memberships).toEqual(before.reconciled.memberships)
    expect(BigInt(invalidated.revision.accepted)).toBe(BigInt(before.revision.accepted) + 1n)
    await store.close()
    const recovered = open(new SQLiteJournal(path, 'journal'), {
      async verify() {
        throw new Error('Offline recovery must retain invalidation')
      }
    })
    expect(await recovered.store.read()).toEqual(invalidated)
  })

  it('rejects unknown, duplicated and foreign-generation invalidations without committing a prefix', async () => {
    const { store, worker } = open()
    await initialize(store)
    await receive(store, batch('initial', [output('A')]))
    await worker.advance(store, signal())
    const before = await store.read(),
      id = before.assessments[0].id
    for (const change of [
      { generation: '0', assessmentIds: ['ff'.repeat(32)], reason: 'Unknown identity' },
      { generation: '0', assessmentIds: [id, id], reason: 'Duplicated identity' },
      { generation: '1', assessmentIds: [id], reason: 'Wrong generation' },
      { generation: '0', assessmentIds: [id], reason: '' }
    ]) {
      await expect(
        store.commit(before.revision.received, knowledgeMutation({ kind: 'invalidate', ...change }))
      ).rejects.toMatchObject({ code: change.generation === '1' ? 'context-changed' : 'invalid' })
      expect(await store.read()).toEqual(before)
    }
  })

  it('fences receipts before initialization and immutable context identities across generations', async () => {
    const { store } = open()
    await expect(receive(store, batch('early', [output('A')]))).rejects.toMatchObject({
      code: 'revision-unavailable'
    })
    expect(await store.revision()).toEqual({ received: '0', accepted: '0' })
    const initial = context()
    initial.generation = '2'
    await store.commit('0', knowledgeMutation({ kind: 'context', context: initial }))
    const before = await store.read()
    const reused = { ...initial, generation: '3' }
    await expect(
      store.commit(
        before.revision.received,
        knowledgeMutation({ kind: 'context', context: reused })
      )
    ).rejects.toMatchObject({ code: 'equivocation' })
    const reversed = { ...initial, id: 'reversed', generation: '1' }
    await expect(
      store.commit(
        before.revision.received,
        knowledgeMutation({ kind: 'context', context: reversed })
      )
    ).rejects.toMatchObject({ code: 'context-changed' })
    const changedChain = {
      ...initial,
      id: 'foreign-chain',
      view: { ...initial.view, chain: { ...chain, network: 'foreign' } }
    }
    await expect(
      store.commit(
        before.revision.received,
        knowledgeMutation({ kind: 'context', context: changedChain })
      )
    ).rejects.toMatchObject({ code: 'context-changed' })
    expect(await store.read()).toEqual(before)
  })

  it('rejects acceptance referring to another context, generation or unavailable group', async () => {
    const { store, worker } = open()
    await initialize(store)
    await receive(store, batch('initial', [output('A')]))
    await worker.advance(store, signal())
    const before = await store.read()
    const accepted = (await store.inspect()).entries.find(
      entry => entry.body.kind === 'accept'
    )!.body
    if (accepted.kind !== 'accept') throw new Error('Expected actual worker acceptance')
    for (const altered of [
      { ...accepted, contextId: 'unknown' },
      { ...accepted, generation: '1' },
      { ...accepted, groupId: 'missing' },
      { ...accepted, results: [] }
    ]) {
      await expect(
        store.commit(before.revision.received, knowledgeMutation(altered))
      ).rejects.toBeDefined()
      expect(await store.read()).toEqual(before)
    }
    await expect(
      store.commit(
        before.revision.received,
        knowledgeMutation({
          kind: 'reconcile',
          generation: '1',
          contextId: before.context.id,
          reconciled: before.reconciled,
          assessments: before.assessments
        })
      )
    ).rejects.toMatchObject({ code: 'context-changed' })
  })
})

it('derives spent currentness for an admitted spend observation from actual SDK-verified evidence', async () => {
  const { store, worker } = open()
  await initialize(store)
  await receive(
    store,
    batch('spend-only', [
      {
        id: 'spend',
        scope,
        kind: 'spend',
        payload: {
          previous: { chain, txid: tx('Q'), outputIndex: 0 },
          spendingTxid: tx('QC'),
          beef: candidate('QC').evidence.beef
        }
      }
    ])
  )
  await worker.advance(store, signal())
  const accepted = await store.read()
  expect(accepted.pendingGroups).toEqual([])
  expect(accepted.assessments.find(row => row.outpoint.txid === tx('Q'))?.state).toBe('spent')
  expect(accepted.facts.some(row => row.txid === tx('QC'))).toBe(true)
})

describe('Bitcoin worker admission and durable commit failures', () => {
  it.each([0, -1, 4097, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid proof-check budget %s before opening storage',
    maximumChecks => {
      expect(
        () =>
          new BitcoinKnowledge({
            journalId: 'invalid-budget',
            partition,
            nonFinal: true,
            verifier: new SDKEvidenceVerifier(resolver),
            maximumChecks
          })
      ).toThrow(
        expect.objectContaining({
          code: 'invalid',
          message: 'Invalid proof-check budget',
          retryable: false
        })
      )
    }
  )

  it('rejects an absent prospective transition with the protocol error identity', async () => {
    const { worker } = open()
    await expect(worker.prepare([], signal())).rejects.toMatchObject({
      code: 'invalid',
      message: 'Missing prospective journal transition',
      retryable: false
    })
  })

  it.each(['limited', 'equivocation'] as const)(
    'preserves a %s commit refusal and leaves received evidence retryable',
    async status => {
      const { store, worker } = open()
      await initialize(store)
      await receive(store, batch('refused', [output('Q')]))
      const retained = await store.inspect(),
        reason = `Injected durable ${status} refusal`,
        commit = jest.spyOn(store, 'commit').mockResolvedValue({ status, reason })
      try {
        await expect(worker.advance(store, signal())).rejects.toMatchObject({
          code: status,
          message: reason,
          retryable: false
        })
        expect(commit).toHaveBeenCalledTimes(1)
        expect(await store.inspect()).toEqual(retained)
      } finally {
        commit.mockRestore()
      }
      await worker.advance(store, signal())
      expect((await store.read()).reconciled.memberships).toHaveLength(1)
      expect((await store.read()).pendingGroups).toEqual([])
    }
  )

  it('retries a conflicted durable acceptance and eventually commits the genuine proof once', async () => {
    const actual = new SDKEvidenceVerifier(resolver),
      verify = jest.spyOn(actual, 'verify'),
      { store, worker } = open(undefined, actual)
    await initialize(store)
    await receive(store, batch('retry-conflict', [output('Q')]))
    const commit = jest.spyOn(store, 'commit').mockResolvedValueOnce({
      status: 'conflict',
      reason: 'Concurrent durable revision'
    })
    try {
      await worker.advance(store, signal())
      expect(commit).toHaveBeenCalledTimes(2)
      expect(verify).toHaveBeenCalled()
      const history = await store.inspect()
      expect(history.entries.filter(entry => entry.body.kind === 'accept')).toHaveLength(1)
      expect((await store.read()).pendingGroups).toEqual([])
      expect((await store.read()).reconciled.memberships).toHaveLength(1)
    } finally {
      commit.mockRestore()
    }
  })

  it('bounds durable revision contention to eight attempts and releases the next pass', async () => {
    const { store, worker } = open()
    await initialize(store)
    await receive(store, batch('contention', [output('Q')]))
    const retained = await store.inspect(),
      commit = jest.spyOn(store, 'commit').mockResolvedValue({
        status: 'conflict',
        reason: 'Concurrent durable revision'
      })
    try {
      await expect(worker.advance(store, signal())).rejects.toMatchObject({
        code: 'conflict',
        message: 'Knowledge contention attempt budget exhausted',
        retryable: true
      })
      expect(commit).toHaveBeenCalledTimes(8)
      expect(await store.inspect()).toEqual(retained)
    } finally {
      commit.mockRestore()
    }
    await worker.advance(store, signal())
    expect((await store.read()).pendingGroups).toEqual([])
  })

  it.each(['limited', 'equivocation'] as const)(
    'preserves a %s refusal on the second ordered group without accepting its prefix twice',
    async status => {
      const { store, worker } = open()
      await initialize(store)
      await receive(store, batch('first-group', [output('Q')], '0', '0', 'snapshot'))
      await receive(store, batch('second-group', [output('A')], '1', '0', 'live'))
      const original = store.commit.bind(store),
        reason = `Injected second-group ${status} refusal`
      let calls = 0
      const commit = jest.spyOn(store, 'commit').mockImplementation(async (...args) => {
        calls++
        return calls === 2 ? { status, reason } : original(...args)
      })
      try {
        await expect(worker.advance(store, signal())).rejects.toMatchObject({
          code: status,
          message: reason,
          retryable: false
        })
        expect(calls).toBe(2)
        expect(
          (await store.inspect()).entries.filter(entry => entry.body.kind === 'accept')
        ).toHaveLength(1)
        expect((await store.read()).pendingGroups).toHaveLength(1)
      } finally {
        commit.mockRestore()
      }
      await worker.advance(store, signal())
      const ready = await store.read()
      expect(ready.pendingGroups).toEqual([])
      expect(ready.reconciled.memberships).toHaveLength(2)
      expect(
        (await store.inspect()).entries.filter(entry => entry.body.kind === 'accept')
      ).toHaveLength(2)
    }
  )
})

describe('Bitcoin worker retained proof scheduling', () => {
  it.each(['Q', 'badSignature'])(
    'replays the genuine %s verdict without repeating cryptographic work or a durable transition',
    async name => {
      const verifier = new SDKEvidenceVerifier(resolver),
        verify = jest.spyOn(verifier, 'verify'),
        { worker, store } = open(undefined, verifier)
      await initialize(store)
      await receive(store, batch(`retained-${name}`, [output(name)]))
      await worker.advance(store, signal())
      const calls = verify.mock.calls.length,
        retained = await store.inspect(),
        snapshot = await store.read()
      expect(calls).toBeGreaterThan(0)
      expect(
        new Set(
          verify.mock.calls.map(([input, selected]) =>
            JSON.stringify([input.variantId, selected.view.id])
          )
        ).size
      ).toBe(calls)
      expect(verify.mock.results).toHaveLength(calls)
      if (name === 'badSignature')
        expect(snapshot.reconciled.transactions.find(row => row.txid === tx(name))?.status).toBe(
          'invalid'
        )
      else expect(snapshot.reconciled.memberships).toHaveLength(1)
      await worker.advance(store, signal())
      expect(verify).toHaveBeenCalledTimes(calls)
      expect(await store.inspect()).toEqual(retained)
      expect(await store.read()).toEqual(snapshot)
    }
  )

  it('does not append the same limited proof result on every bounded retry', async () => {
    const verify = jest.fn<EvidenceVerifier['verify']>(async (input, selected) => ({
        status: 'limited',
        contextId: selected.id,
        variantId: input.variantId,
        reason: 'Scheduled proof backend is temporarily unavailable',
        dependencies: []
      })),
      { worker, store } = open(undefined, { verify })
    await initialize(store)
    await receive(store, batch('limited-proof', [output('Q')]))
    await expect(worker.advance(store, signal())).rejects.toMatchObject({
      code: 'limited',
      message: 'Evidence work retained; another bounded pass is required',
      retryable: true
    })
    const retained = await store.inspect(),
      calls = verify.mock.calls.length
    await expect(worker.advance(store, signal())).rejects.toMatchObject({
      code: 'limited',
      message: 'Evidence work retained; another bounded pass is required',
      retryable: true
    })
    expect(verify.mock.calls.length).toBeGreaterThan(calls)
    expect(await store.inspect()).toEqual(retained)
    expect((await store.read()).pendingGroups).toHaveLength(1)
  })

  it('stops proof work at the inclusive pass deadline and retains it for a fresh bounded retry', async () => {
    const start = Date.now()
    let now = start,
      atBoundary = true
    const actual = new SDKEvidenceVerifier(resolver),
      verify = jest.fn<EvidenceVerifier['verify']>(async (...args) => {
        const result = await actual.verify(...args)
        if (atBoundary) now = start + 100
        return result
      }),
      storage = new MemoryJournal('proof-deadline'),
      worker = new BitcoinKnowledge({
        journalId: storage.namespace,
        partition,
        nonFinal: true,
        verifier: { verify },
        limits: { deadlineMs: 100 },
        now: () => now
      }),
      store = new KnowledgeStore(storage, worker, { partition })
    stores.push(store)
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      await initialize(store)
      await receive(store, batch('deadline-proof', [output('A')]))
      await expect(worker.advance(store, signal())).rejects.toMatchObject({
        code: 'limited',
        message: 'Evidence work retained; another bounded pass is required',
        retryable: true
      })
      expect(verify).toHaveBeenCalledTimes(1)
      expect((await store.read()).pendingGroups).toHaveLength(1)
      atBoundary = false
      await worker.advance(store, signal())
      expect(verify.mock.calls.length).toBeGreaterThan(1)
      expect((await store.read()).pendingGroups).toEqual([])
      expect((await store.read()).reconciled.memberships).toHaveLength(1)
    } finally {
      clock.mockRestore()
    }
  })
})

it('prepares an independently replayed acceptance with fresh genuine proof material', async () => {
  const { worker, store } = open()
  await initialize(store)
  await receive(store, batch('independent-prepare', [output('Q')]))
  await worker.advance(store, signal())
  const entries = (await store.inspect()).entries,
    acceptance = entries.findIndex(entry => entry.body.kind === 'accept'),
    prospective = entries.slice(0, acceptance + 1),
    actual = new SDKEvidenceVerifier(resolver),
    verify = jest.spyOn(actual, 'verify'),
    independent = new BitcoinKnowledge({
      journalId: store.journalId,
      partition,
      nonFinal: true,
      verifier: actual
    })
  expect(acceptance).toBeGreaterThan(0)
  const prepared = await independent.prepare(prospective, signal())
  expect(verify).toHaveBeenCalled()
  expect(prepared.local).toEqual(prospective.at(-1)!.local)
  const calls = verify.mock.calls.length
  expect(prepared.input).toEqual(await independent.reduce(prospective, signal()))
  expect(verify).toHaveBeenCalledTimes(calls)
  expect(await store.inspect()).toEqual({ entries, revision: entries.at(-1)!.revision })
})
