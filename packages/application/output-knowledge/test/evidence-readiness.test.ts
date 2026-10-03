import { describe, expect, it } from '@jest/globals'
import { Beef, Utils } from '@bsv/sdk'
import { EvidencePool, type EvidenceReceipt } from '../src/EvidencePool.js'
import {
  planKnowledgeEvidence,
  evaluateKnowledgeReadiness,
  type EvidenceGroupRequirement,
  type EvidenceWorkPlan
} from '../src/EvidenceReadiness.js'
import { SDKEvidenceVerifier } from '../src/SDKEvidenceVerifier.js'
import {
  VerificationLedger,
  checkRetainedProof,
  knowledgeLocalFrame,
  proofReference
} from '../src/VerificationLedger.js'
import { reconcileOutputSpends } from '../src/SpendReconciler.js'
import { candidate, chain, context, corpus, resolver } from './evidence-fixture.js'

function receipt(
  id: string,
  at: string,
  name: string,
  group = id,
  partial = false
): EvidenceReceipt {
  const evidence = candidate(name).evidence
  if (partial) {
    const beef = new Beef()
    beef.mergeRawTx(Utils.toArray(corpus.transactions[name].raw, 'hex'))
    evidence.beef = Utils.toBase64(beef.toBinary())
  }
  return { id, received: at, group, chain, evidence }
}
function groups(...rows: EvidenceReceipt[]): EvidenceGroupRequirement[] {
  const result = new Map<string, EvidenceGroupRequirement>()
  for (const row of rows) {
    const group = result.get(row.group) ?? {
      id: row.group,
      received: row.received,
      receipts: [],
      enabled: true
    }
    group.receipts.push(row.id)
    result.set(row.group, group)
  }
  return [...result.values()]
}
async function verify(
  pool: EvidencePool,
  plan: EvidenceWorkPlan,
  ledger: VerificationLedger,
  skip?: string,
  reverse = false
): Promise<void> {
  const selected = context(),
    verifier = new SDKEvidenceVerifier(resolver)
  const proofs = [...plan.proofs.values()]
  if (reverse) proofs.reverse()
  for (const support of proofs) {
    if (support.candidate.evidence.txid === skip) continue
    const check = await checkRetainedProof(
      verifier,
      support,
      selected,
      new AbortController().signal
    )
    ledger.apply(
      knowledgeLocalFrame(true, [{ proof: proofReference(support), checks: [check] }]),
      pool,
      new Map([[selected.id, selected]])
    )
  }
}
function evaluate(
  pool: EvidencePool,
  plan: EvidenceWorkPlan,
  ledger: VerificationLedger,
  through: string
) {
  return evaluateKnowledgeReadiness(pool, plan, ledger, [{ at: '0', context: context() }], through)
}
function selection(
  pool: EvidencePool,
  plan: EvidenceWorkPlan,
  ledger: VerificationLedger,
  through: string
) {
  const readiness = evaluate(pool, plan, ledger, through)
  return reconcileOutputSpends({
    journalId: pool.journalId,
    through,
    context: context(),
    contexts: [{ at: '0', context: context() }],
    nonFinal: true,
    candidates: readiness.candidates,
    memberships: []
  })
}
const tx = (name: string) => corpus.transactions[name].txid

describe('durable evidence readiness across source groups', () => {
  it('selects by received complete support rather than verification completion, with identical restart replay', async () => {
    const pool = new EvidencePool('journal'),
      a = receipt('first', '2', 'A'),
      b = receipt('second', '4', 'B')
    pool.receive('2', [a])
    pool.receive('4', [b])
    const plan = planKnowledgeEvidence(pool, groups(a, b)),
      ledger = new VerificationLedger(true)
    await verify(pool, plan, ledger, tx('A'), true)
    const pending = selection(pool, plan, ledger, '4')
    expect(pending.transactions.find(row => row.txid === tx('B'))?.status).toBe('unresolved')
    expect(
      pending.pendingComponents.some(
        row => row.txids.includes(tx('A')) && row.txids.includes(tx('B'))
      )
    ).toBe(true)
    await verify(pool, plan, ledger)
    const ready = selection(pool, plan, ledger, '4')
    expect(ready.transactions.find(row => row.txid === tx('A'))).toMatchObject({
      status: 'selected-final',
      order: { readyAt: '2' }
    })
    expect(ready.transactions.find(row => row.txid === tx('B'))?.status).toBe('conflicting')
    const restored = new VerificationLedger(true)
    restored.apply(
      knowledgeLocalFrame(true, ledger.entries()),
      pool,
      new Map([[context().id, context()]])
    )
    expect(selection(pool, planKnowledgeEvidence(pool, groups(a, b)), restored, '4')).toEqual(ready)
  })

  it('does not reserve a missing predecessor, then assigns the later dependency receipt without changing first raw order', async () => {
    const pool = new EvidencePool('journal'),
      child = receipt('child', '2', 'QC', 'child', true)
    pool.receive('2', [child])
    const initial = planKnowledgeEvidence(pool, groups(child))
    expect(
      evaluate(pool, initial, new VerificationLedger(true), '2').candidates.find(
        row => row.txid === tx('QC')
      )
    ).toMatchObject({
      firstRaw: { position: '2' },
      pendingSupport: false,
      validation: 'unresolved'
    })
    const parent = receipt('parent', '5', 'Q')
    pool.receive('5', [parent])
    const plan = planKnowledgeEvidence(pool, groups(child, parent)),
      ledger = new VerificationLedger(true)
    await verify(pool, plan, ledger)
    const rows = evaluate(pool, plan, ledger, '5').candidates
    expect(rows.find(row => row.txid === tx('QC'))?.order).toMatchObject({
      readyAt: '5',
      depth: 1,
      firstRaw: { position: '2' }
    })
    expect(rows.find(row => row.txid === tx('Q'))?.order).toMatchObject({ readyAt: '5', depth: 0 })
  })

  it('holds a valid sibling and its dependencies until every observation in the original source group qualifies', async () => {
    const pool = new EvidencePool('journal'),
      a = receipt('a', '1', 'A', 'together'),
      q = receipt('q', '1', 'Q', 'together')
    pool.receive('1', [a, q])
    const plan = planKnowledgeEvidence(pool, groups(a, q)),
      ledger = new VerificationLedger(true)
    await verify(pool, plan, ledger, tx('Q'))
    const pending = evaluate(pool, plan, ledger, '1')
    expect(pending.groups.size).toBe(0)
    expect(pending.candidates.find(row => row.txid === tx('A'))).toMatchObject({
      validation: 'unresolved',
      pendingSupport: true
    })
    await verify(pool, plan, ledger)
    expect(evaluate(pool, plan, ledger, '1').groups.get('together')).toBe('1')
  })

  it('can qualify mutually supporting groups without depending on acceptance-job order', async () => {
    const pool = new EvidencePool('journal'),
      child = receipt('child', '1', 'QC', 'one', true),
      a = receipt('a', '1', 'A', 'one'),
      parent = receipt('parent', '3', 'Q', 'two', true)
    pool.receive('1', [child, a])
    pool.receive('3', [parent])
    const plan = planKnowledgeEvidence(pool, groups(child, a, parent)),
      ledger = new VerificationLedger(true)
    await verify(pool, plan, ledger)
    expect([...evaluate(pool, plan, ledger, '3').groups]).toEqual([
      ['one', '3'],
      ['two', '3']
    ])
  })

  it('does not let a malformed sibling contaminate independent support for the same valid transaction', async () => {
    const pool = new EvidencePool('journal'),
      a = receipt('a', '1', 'A', 'bad-group'),
      bad = receipt('bad', '1', 'Q', 'bad-group')
    bad.evidence.beef = 'AA=='
    pool.receive('1', [a, bad])
    const good = receipt('independent', '4', 'A')
    pool.receive('4', [good])
    const plan = planKnowledgeEvidence(pool, groups(a, bad, good)),
      ledger = new VerificationLedger(true)
    await verify(pool, plan, ledger)
    const result = evaluate(pool, plan, ledger, '4')
    expect(result.groups.has('bad-group')).toBe(false)
    expect(result.candidates.find(row => row.txid === tx('A'))).toMatchObject({
      pendingSupport: false,
      order: { readyAt: '4', firstRaw: { position: '1' } }
    })
  })

  it('excludes unrelated BEEF rows from the usable candidate graph', () => {
    const pool = new EvidencePool('journal'),
      a = receipt('a', '1', 'A')
    const beef = Beef.fromBinary(Utils.toArray(a.evidence.beef, 'base64'))
    beef.mergeBeef(Utils.toArray(candidate('Q').evidence.beef, 'base64'))
    a.evidence.beef = Utils.toBase64(beef.toBinary())
    pool.receive('1', [a])
    const plan = planKnowledgeEvidence(pool, groups(a))
    expect(plan.candidates.has(tx('A'))).toBe(true)
    expect(plan.candidates.has(tx('Q'))).toBe(false)
    expect(pool.firstRaw(chain, tx('Q'))?.position).toBe('1')
  })

  it('enforces independent planning, proof-count and replay bounds', () => {
    const pool = new EvidencePool('journal'),
      a = receipt('a', '1', 'A')
    pool.receive('1', [a])
    expect(() => planKnowledgeEvidence(pool, groups(a), { maximumWork: 1 })).toThrow(
      'work exhausted'
    )
    expect(() => planKnowledgeEvidence(pool, groups(a), { maximumProofs: 1 })).toThrow(
      'proof count'
    )
    const plan = planKnowledgeEvidence(pool, groups(a)),
      ledger = new VerificationLedger(true)
    expect(() =>
      evaluateKnowledgeReadiness(pool, plan, ledger, [{ at: '0', context: context() }], '1', {
        maximumWork: 1
      })
    ).toThrow('work exhausted')
    expect(() => evaluateKnowledgeReadiness(pool, plan, ledger, [], '1')).toThrow('Initial')
    expect(() => planKnowledgeEvidence(pool, [...groups(a), ...groups(a)])).toThrow('Duplicate')
  })
})
