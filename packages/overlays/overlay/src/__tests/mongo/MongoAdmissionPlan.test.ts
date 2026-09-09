import {
  admissionSemanticDigest,
  type AdmissionCommit,
  type AdmissionPayloadRef
} from '../../storage/AdmissionStorage.js'
import {
  AdmissionRejectedError,
  admissionPlanPayloads,
  admissionReceiptFor,
  lookupOutboxIntents,
  propagationOutboxIntents,
  rejectAdmission,
  samePayload,
  sameScope,
  validateAdmissionPlan
} from '../../storage/mongo/MongoAdmissionPlan.js'
import { admissionPlan } from '../admission/AdmissionStorageContract.js'
import { referenceScope } from '../admission/ReferenceAdmissionStorage.js'

const clone = <T>(value: T): T => structuredClone(value)
const hash = (character: string): string => character.repeat(64)

function bind(plan: AdmissionCommit): AdmissionCommit {
  plan.key.semanticDigest = admissionSemanticDigest(plan.identity)
  return plan
}

describe('Mongo admission plan validation', () => {
  test('accepts the contract plan and classifies outbox intents', () => {
    const plan = admissionPlan()
    expect(validateAdmissionPlan(plan)).toBeUndefined()
    expect(lookupOutboxIntents(plan).map(intent => intent.target)).toEqual(['ls_contract'])
    expect(propagationOutboxIntents(plan).map(intent => intent.kind)).toEqual(['propagation'])
    expect(admissionPlanPayloads(plan).length).toBeGreaterThan(plan.payloads.length)
  })

  test('sameScope and samePayload compare every identity field', () => {
    expect(sameScope(referenceScope, { ...referenceScope })).toBe(true)
    expect(sameScope(referenceScope, { ...referenceScope, nodeId: 'other' })).toBe(false)
    const payload: AdmissionPayloadRef = {
      digest: hash('a'),
      byteLength: '100',
      kind: 'raw-transaction'
    }
    expect(samePayload(payload, payload)).toBe(true)
    expect(samePayload(undefined, payload)).toBe(false)
    expect(samePayload({ ...payload, kind: 'locking-script' }, payload)).toBe(false)
    expect(samePayload({ ...payload, byteLength: '99' }, payload)).toBe(false)
  })

  test('rejects a digest that does not bind the identity or scope', () => {
    const mismatched = clone(admissionPlan())
    mismatched.key.semanticDigest = hash('0')
    expect(validateAdmissionPlan(mismatched)).toBe('digest-mismatch')

    const scoped = clone(admissionPlan())
    scoped.key.scope = { ...referenceScope, nodeId: 'other-node' }
    expect(validateAdmissionPlan(scoped)).toBe('digest-mismatch')

    const invalid = clone(admissionPlan())
    invalid.identity.txid = 'not-a-hash'
    expect(validateAdmissionPlan(invalid)).toBe('digest-mismatch')
  })

  test('rejects historical propagation and inconsistent topic sets', () => {
    const historical = bind(clone(admissionPlan('historical-operation')))
    historical.identity.mode = 'historical'
    bind(historical)
    expect(validateAdmissionPlan(historical)).toBe('invalid-plan')

    const missingDecision = bind(clone(admissionPlan('missing-decision')))
    missingDecision.identity.topics.push({ topic: 'tm_other', policyId: 'policy-2' })
    bind(missingDecision)
    expect(validateAdmissionPlan(missingDecision)).toBe('invalid-plan')

    const unknownTopic = clone(admissionPlan('unknown-topic'))
    unknownTopic.decisions[0].topic = 'tm_other'
    expect(validateAdmissionPlan(unknownTopic)).toBe('invalid-plan')

    const duplicateEvents = clone(admissionPlan('duplicate-events'))
    duplicateEvents.outbox[1].eventId = duplicateEvents.outbox[0].eventId
    expect(validateAdmissionPlan(duplicateEvents)).toBe('invalid-plan')
  })

  test('rejects payloads that are not ready for reference', () => {
    const badDigest = clone(admissionPlan('payload-digest'))
    badDigest.payloads[0] = { ...badDigest.payloads[0], digest: 'zz' }
    expect(validateAdmissionPlan(badDigest)).toBe('payload-not-ready')

    const badLength = clone(admissionPlan('payload-length'))
    badLength.payloads[0] = { ...badLength.payloads[0], byteLength: '01' }
    expect(validateAdmissionPlan(badLength)).toBe('payload-not-ready')
  })

  test('rejects STEAK that is not bound to the admitted outputs', () => {
    const notJson = clone(admissionPlan('steak-json'))
    notJson.steak = '{'
    expect(validateAdmissionPlan(notJson)).toBe('invalid-plan')

    const illFormed = clone(admissionPlan('steak-ill'))
    illFormed.steak = '\ud800'
    expect(validateAdmissionPlan(illFormed)).toBe('invalid-plan')

    const arraySteak = clone(admissionPlan('steak-array'))
    arraySteak.steak = '[]'
    expect(validateAdmissionPlan(arraySteak)).toBe('invalid-plan')

    const scalar = clone(admissionPlan('steak-scalar'))
    scalar.steak = '1'
    expect(validateAdmissionPlan(scalar)).toBe('invalid-plan')

    const retainType = clone(admissionPlan('steak-retain'))
    retainType.steak = JSON.stringify({
      tm_contract: { outputsToAdmit: [0], coinsToRetain: 'nope' }
    })
    expect(validateAdmissionPlan(retainType)).toBe('invalid-plan')

    const removedType = clone(admissionPlan('steak-removed'))
    removedType.steak = JSON.stringify({
      tm_contract: { outputsToAdmit: [0], coinsRemoved: 1 }
    })
    expect(validateAdmissionPlan(removedType)).toBe('invalid-plan')

    const fractional = clone(admissionPlan('steak-fraction'))
    fractional.steak = JSON.stringify({ tm_contract: { outputsToAdmit: [0.5] } })
    expect(validateAdmissionPlan(fractional)).toBe('invalid-plan')

    const negative = clone(admissionPlan('steak-negative'))
    negative.steak = JSON.stringify({ tm_contract: { outputsToAdmit: [-1] } })
    expect(validateAdmissionPlan(negative)).toBe('invalid-plan')

    const overflow = clone(admissionPlan('steak-overflow'))
    overflow.steak = JSON.stringify({ tm_contract: { outputsToAdmit: [4294967296] } })
    expect(validateAdmissionPlan(overflow)).toBe('invalid-plan')

    const mismatch = clone(admissionPlan('steak-mismatch'))
    mismatch.steak = JSON.stringify({
      tm_contract: { outputsToAdmit: [7], coinsToRetain: [], coinsRemoved: [] }
    })
    expect(validateAdmissionPlan(mismatch)).toBe('invalid-plan')

    const notString = clone(admissionPlan('steak-type'))
    ;(notString as { steak: unknown }).steak = { tm_contract: { outputsToAdmit: [0] } }
    expect(validateAdmissionPlan(notString)).toBe('invalid-plan')
  })

  test('rejects malformed outbox intents', () => {
    const emptyId = clone(admissionPlan('outbox-empty-id'))
    emptyId.outbox[0].eventId = ''
    expect(validateAdmissionPlan(emptyId)).toBe('invalid-plan')

    const illId = clone(admissionPlan('outbox-ill-id'))
    illId.outbox[0].eventId = '\ud800'
    expect(validateAdmissionPlan(illId)).toBe('invalid-plan')

    const emptyTarget = clone(admissionPlan('outbox-empty-target'))
    emptyTarget.outbox[0].target = ''
    expect(validateAdmissionPlan(emptyTarget)).toBe('invalid-plan')

    const illTarget = clone(admissionPlan('outbox-ill-target'))
    illTarget.outbox[0].target = '\ud800'
    expect(validateAdmissionPlan(illTarget)).toBe('invalid-plan')

    const kind = clone(admissionPlan('outbox-kind'))
    ;(kind.outbox[0] as { kind: string }).kind = 'index'
    expect(validateAdmissionPlan(kind)).toBe('invalid-plan')
  })

  test('rejects malformed spends, edges, outputs, and applied history', () => {
    const spendTxid = clone(admissionPlan('spend-txid'))
    spendTxid.decisions[0].spends[0].outpoint.txid = 'nope'
    expect(validateAdmissionPlan(spendTxid)).toBe('invalid-plan')

    const spender = clone(admissionPlan('spend-spender'))
    spender.decisions[0].spends[0].spender = hash('1')
    expect(validateAdmissionPlan(spender)).toBe('invalid-plan')

    const eviction = clone(admissionPlan('eviction'))
    eviction.decisions[0].evictions = [{ txid: 'nope', outputIndex: '0' }]
    expect(validateAdmissionPlan(eviction)).toBe('invalid-plan')

    const edge = clone(admissionPlan('edge'))
    edge.decisions[0].edges[0].source.txid = 'nope'
    expect(validateAdmissionPlan(edge)).toBe('invalid-plan')

    const outputTxid = clone(admissionPlan('output-txid'))
    outputTxid.decisions[0].outputs[0].txid = hash('7')
    expect(validateAdmissionPlan(outputTxid)).toBe('invalid-plan')

    const satoshis = clone(admissionPlan('satoshis'))
    satoshis.decisions[0].outputs[0].satoshis = '01'
    expect(validateAdmissionPlan(satoshis)).toBe('invalid-plan')

    const scriptRange = clone(admissionPlan('script-range'))
    scriptRange.decisions[0].outputs[0].script.offset = '20'
    scriptRange.decisions[0].outputs[0].script.byteLength = '10'
    expect(validateAdmissionPlan(scriptRange)).toBe('invalid-plan')

    const appliedTxid = clone(admissionPlan('applied-txid'))
    appliedTxid.decisions[0].applied.txid = hash('7')
    expect(validateAdmissionPlan(appliedTxid)).toBe('invalid-plan')

    const firstSeen = clone(admissionPlan('first-seen'))
    firstSeen.decisions[0].applied.firstSeenHeight = '01'
    expect(validateAdmissionPlan(firstSeen)).toBe('invalid-plan')

    const proof = clone(admissionPlan('applied-proof'))
    proof.decisions[0].applied.proof = { digest: 'zz', byteLength: '1', kind: 'merkle-path' }
    expect(validateAdmissionPlan(proof)).toBe('payload-not-ready')

    const block = clone(admissionPlan('applied-block'))
    block.decisions[0].applied.block = {
      height: '1',
      hash: 'not-a-hash',
      index: '0',
      merkleRoot: hash('4')
    }
    expect(validateAdmissionPlan(block)).toBe('invalid-plan')

    const history = clone(admissionPlan('history'))
    history.decisions[0].historyUpdate = {
      nextTopicHistoryGeneration: '3',
      affectedFromHeight: '99'
    }
    expect(validateAdmissionPlan(history)).toBe('invalid-plan')

    const historyType = clone(admissionPlan('history-type'))
    historyType.decisions[0].historyUpdate = {
      nextTopicHistoryGeneration: '4',
      affectedFromHeight: '01'
    }
    expect(validateAdmissionPlan(historyType)).toBe('invalid-plan')
  })

  test('receipts mark enlisted indexes visible and reject overlapping lookup targets', () => {
    const plan = admissionPlan()
    expect(admissionReceiptFor(plan, [])).toEqual({
      operationId: plan.key.operationId,
      semanticDigest: plan.key.semanticDigest,
      durability: 'atomic-local',
      steak: plan.steak,
      indexes: [{ target: 'ls_contract', state: 'pending' }],
      propagation: 'pending'
    })
    expect(admissionReceiptFor(plan, ['ls_enlisted']).indexes).toEqual([
      { target: 'ls_enlisted', state: 'visible' },
      { target: 'ls_contract', state: 'pending' }
    ])
    expect(() => admissionReceiptFor(plan, ['ls_contract'])).toThrow(AdmissionRejectedError)
    try {
      admissionReceiptFor(plan, ['ls_contract'])
    } catch (error) {
      expect(error).toMatchObject({ name: 'AdmissionRejectedError', code: 'invalid-plan' })
    }

    const noPropagation = clone(plan)
    noPropagation.outbox = noPropagation.outbox.filter(intent => intent.kind !== 'propagation')
    expect(admissionReceiptFor(noPropagation, []).propagation).toBe('not-requested')
  })

  test('rejectAdmission throws a coded admission error', () => {
    expect(() => rejectAdmission('digest-mismatch')).toThrow(AdmissionRejectedError)
    expect(() => rejectAdmission('spend-conflict')).toThrow('spend-conflict')
  })
})
