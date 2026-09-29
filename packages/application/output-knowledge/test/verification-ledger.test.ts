import { describe, expect, it } from '@jest/globals'
import { EvidencePool, SDKEvidenceVerifier } from '../src/index.js'
import {
  VerificationLedger,
  checkRetainedProof,
  proofReference,
  knowledgeLocalFrame,
  parseKnowledgeLocalFrame,
  type VerifiedWork
} from '../src/VerificationLedger.js'
import { candidate, chain, context, corpus, resolver } from './evidence-fixture.js'

function prepared() {
  const pool = new EvidencePool('journal')
  pool.receive('1', [
    {
      id: 'receipt',
      group: 'whole-source-group',
      received: '1',
      chain,
      evidence: candidate('A').evidence
    }
  ])
  return { pool, support: pool.alternatives('receipt').supports[0] }
}

describe('local verification replay records', () => {
  it('rechecks an immutable historical view with a new work deadline without extending the saved context', async () => {
    const { pool, support } = prepared(),
      historical = context()
    historical.now = '0'
    historical.limits.deadline = '1'
    const before = JSON.stringify(historical)
    const check = await checkRetainedProof(
      new SDKEvidenceVerifier(resolver),
      support,
      historical,
      new AbortController().signal
    )
    expect(check).toEqual({ contextId: historical.id, status: 'verified' })
    expect(JSON.stringify(historical)).toBe(before)
    const frame = knowledgeLocalFrame(true, [{ proof: proofReference(support), checks: [check] }])
    const reopened = new VerificationLedger(true)
    reopened.apply(JSON.parse(JSON.stringify(frame)), pool, new Map([[historical.id, historical]]))
    expect(reopened.get(proofReference(support), historical.id)).toEqual(check)
  })

  it('retains a real anchor placement and refuses contradictory results for an immutable verified context', async () => {
    const { pool } = prepared(),
      selected = context()
    const support = pool.materialize('receipt', ['receipt'], {
      txid: corpus.transactions.P.txid,
      outputIndex: 0
    })
    const check = await checkRetainedProof(
      new SDKEvidenceVerifier(resolver),
      support,
      selected,
      new AbortController().signal
    )
    expect(check.placement).toBeDefined()
    const ledger = new VerificationLedger(true),
      proof = proofReference(support),
      contexts = new Map([[selected.id, selected]])
    ledger.apply(knowledgeLocalFrame(true, [{ proof, checks: [check] }]), pool, contexts)
    expect(() =>
      ledger.apply(
        knowledgeLocalFrame(true, [
          { proof, checks: [{ contextId: selected.id, status: 'limited' }] }
        ]),
        pool,
        contexts
      )
    ).toThrow('immutable proof context changed')
    expect(ledger.get(proof, selected.id)).toEqual(check)
  })

  it('does not partly install a frame with missing historical contexts or altered proof references', () => {
    const { pool, support } = prepared(),
      selected = context(),
      ledger = new VerificationLedger(true)
    const proof = proofReference(support),
      contexts = new Map([[selected.id, selected]])
    const work: VerifiedWork = {
      proof,
      checks: [
        { contextId: selected.id, status: 'limited' },
        { contextId: 'missing', status: 'verified' }
      ]
    }
    expect(() => ledger.apply(knowledgeLocalFrame(true, [work]), pool, contexts)).toThrow(
      'Historical verification context'
    )
    expect(ledger.entries()).toEqual([])
    const changed = { ...proof, variantId: '00'.repeat(32) }
    expect(() =>
      ledger.apply(knowledgeLocalFrame(true, [{ proof: changed, checks: [] }]), pool, contexts)
    ).toThrow('proof bytes changed')
    expect(() => ledger.apply(knowledgeLocalFrame(false, []), pool, contexts)).toThrow(
      'generation reset'
    )
  })

  it('rejects unknown storage profiles, duplicate checks and unverifiable result bindings', async () => {
    const { support } = prepared(),
      selected = context()
    expect(() =>
      parseKnowledgeLocalFrame({ profile: 'unknown', version: 1, nonFinal: true, work: [] })
    ).toThrow('Unknown')
    expect(() =>
      knowledgeLocalFrame(true, [
        {
          proof: proofReference(support),
          checks: [
            { contextId: selected.id, status: 'verified' },
            { contextId: selected.id, status: 'verified' }
          ]
        }
      ])
    ).toThrow('duplicated')
    const actual = new SDKEvidenceVerifier(resolver)
    await expect(
      checkRetainedProof(
        {
          async verify(candidate, context, signal) {
            const result = await actual.verify(candidate, context, signal)
            return { ...result, contextId: 'different' }
          }
        },
        support,
        selected,
        new AbortController().signal
      )
    ).rejects.toThrow('identity mismatch')
    await expect(
      checkRetainedProof(
        {
          async verify(candidate, context, signal) {
            const result = await actual.verify(candidate, context, signal)
            if (result.status === 'verified') result.fact.rawTransaction = 'AA=='
            return result
          }
        },
        support,
        selected,
        new AbortController().signal
      )
    ).rejects.toThrow('fact differs')
  })
})
