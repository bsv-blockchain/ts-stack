import {
  admissionSemanticDigest,
  getAdmissionStorage,
  type AdmissionCommit,
  type AdmissionCommitResult,
  type AdmissionPayloadRef,
  type AdmissionReceipt,
  type AdmissionReconcileResult,
  type ReplaySafeProjection
} from '../../storage/AdmissionStorage.js'
import type { RecoveryLease } from '../../storage/RecoveryContract.js'
import {
  ReferenceAdmissionHarness,
  referenceScope,
  type AdmissionStorageContractHarness
} from './ReferenceAdmissionStorage.js'

const clone = <T>(value: T): T => structuredClone(value)
const hash = (character: string): string => character.repeat(64)

const history = { chainEpoch: '7', topicHistoryGeneration: '3' }
const source = { txid: hash('9'), outputIndex: '0' }
const raw: AdmissionPayloadRef = { digest: hash('a'), byteLength: '100', kind: 'raw-transaction' }
const script: AdmissionPayloadRef = { digest: hash('b'), byteLength: '25', kind: 'locking-script' }
const proof: AdmissionPayloadRef = { digest: hash('c'), byteLength: '40', kind: 'merkle-path' }
const outboxData: AdmissionPayloadRef = { digest: hash('d'), byteLength: '10', kind: 'outbox-data' }
const alternateProof: AdmissionPayloadRef = {
  digest: hash('e'),
  byteLength: '41',
  kind: 'merkle-path'
}
const steakFor = (topic: string): string =>
  JSON.stringify({ [topic]: { outputsToAdmit: [0], coinsToRetain: [], coinsRemoved: [] } })

export const admissionPlan = (operationId = 'operation-1', txid = hash('8')): AdmissionCommit => {
  const identity = {
    scope: referenceScope,
    txid,
    mode: 'live' as const,
    contextDigest: hash('2'),
    topics: [{ topic: 'tm_contract', policyId: 'policy-1' }]
  }
  return {
    key: { scope: referenceScope, operationId, semanticDigest: admissionSemanticDigest(identity) },
    identity,
    payloads: [raw, script, proof, outboxData],
    decisions: [
      {
        topic: 'tm_contract',
        expectedHistory: history,
        reads: [{ key: 'selection:tm_contract', expectedVersion: 'r1' }],
        spends: [{ outpoint: source, expectedVersion: 'spend-r1', spender: txid }],
        evictions: [],
        outputs: [
          {
            txid,
            outputIndex: '0',
            satoshis: '1',
            score: '10',
            script: { payload: script, offset: '0', byteLength: '25' }
          }
        ],
        edges: [{ source, consumer: { txid, outputIndex: '0' } }],
        applied: {
          txid,
          firstSeenHeight: '100',
          proof,
          block: { height: '101', hash: hash('3'), index: '0', merkleRoot: hash('4') }
        }
      }
    ],
    outbox: [
      {
        eventId: `${operationId}:lookup`,
        kind: 'lookup',
        target: 'ls_contract',
        payloads: [outboxData]
      },
      {
        eventId: `${operationId}:propagate`,
        kind: 'propagation',
        target: 'peer-a',
        payloads: [raw]
      }
    ],
    steak: steakFor('tm_contract')
  }
}

const planForScopeAndTopic = (
  scope: typeof referenceScope,
  topic: string,
  operationId: string
): AdmissionCommit => {
  const plan = admissionPlan(operationId)
  plan.identity.scope = scope
  plan.identity.topics = [{ topic, policyId: 'policy-1' }]
  plan.key.scope = scope
  plan.key.semanticDigest = admissionSemanticDigest(plan.identity)
  plan.decisions[0].topic = topic
  plan.decisions[0].reads = [{ key: `selection:${topic}`, expectedVersion: 'r1' }]
  plan.steak = steakFor(topic)
  return plan
}

const seedPlan = async (
  harness: AdmissionStorageContractHarness,
  plan: AdmissionCommit,
  omit: string[] = []
): Promise<void> => {
  for (const decision of plan.decisions) {
    await harness.seed.history(plan.identity.scope, decision.topic, decision.expectedHistory)
    for (const read of decision.reads) {
      if (read.expectedVersion !== null) {
        await harness.seed.read(plan.identity.scope, decision.topic, read.key, read.expectedVersion)
      }
    }
    for (const spend of decision.spends) {
      await harness.seed.spendable(
        plan.identity.scope,
        decision.topic,
        spend.outpoint,
        spend.expectedVersion
      )
    }
  }
  for (const payload of plan.payloads) {
    if (!omit.includes(payload.digest)) await harness.seed.readyPayload(payload)
  }
}

const committedReceipt = (
  result: AdmissionCommitResult | AdmissionReconcileResult
): AdmissionReceipt => {
  if (result.state !== 'committed')
    throw new Error(`Expected committed result, got ${result.state}`)
  return result.receipt
}

const rejected = (
  result: AdmissionCommitResult,
  code: Extract<AdmissionCommitResult, { state: 'rejected' }>['code']
): void => {
  expect(result).toEqual({ state: 'rejected', code })
}

/**
 * Reusable behavioral contract for an AdmissionStorage adapter. The reference
 * implementation is an in-memory model only; passing this suite does not
 * establish database durability, crash recovery, or external delivery.
 */
export const admissionStorageContract = (
  createHarness: () => AdmissionStorageContractHarness
): void => {
  describe('AdmissionStorage contract', () => {
    let harness: AdmissionStorageContractHarness

    beforeEach(async () => {
      harness = createHarness()
      await harness.reset()
    })

    test('advertises the optional admission provider protocol', () => {
      expect(getAdmissionStorage(harness.storage)?.protocol).toBe('overlay-admission-v1')
    })

    test('commits one atomic admission and leaves external work pending', async () => {
      const plan = admissionPlan()
      await seedPlan(harness, plan)

      const receipt = committedReceipt(await harness.storage.admission!.commitAdmission(plan))

      expect(receipt).toEqual({
        operationId: plan.key.operationId,
        semanticDigest: plan.key.semanticDigest,
        durability: 'atomic-local',
        steak: plan.steak,
        indexes: [{ target: 'ls_contract', state: 'pending' }],
        propagation: 'pending'
      })
      const snapshot = await harness.snapshot()
      expect(snapshot.payloads.every(payload => payload.pinned)).toBe(true)
      expect(snapshot.outputs.some(output => output.spentBy === plan.identity.txid)).toBe(true)
      expect(snapshot.edges).toHaveLength(1)
      expect(snapshot.applied).toEqual([
        expect.objectContaining({ record: expect.objectContaining({ txid: plan.identity.txid }) })
      ])
      expect(snapshot.outbox).toEqual([
        { scope: referenceScope, eventId: `${plan.key.operationId}:lookup` },
        { scope: referenceScope, eventId: `${plan.key.operationId}:propagate` }
      ])
    })

    test('returns the saved receipt for concurrent and restart retries before stale predicates', async () => {
      const plan = admissionPlan()
      await seedPlan(harness, plan)

      const [first, second] = await Promise.all([
        harness.storage.admission!.commitAdmission(plan),
        harness.storage.admission!.commitAdmission(clone(plan))
      ])
      const saved = committedReceipt(first)
      expect(committedReceipt(second)).toEqual(saved)

      saved.steak = 'caller mutation'
      saved.indexes[0].state = 'visible'
      await harness.seed.read(referenceScope, 'tm_contract', 'selection:tm_contract', 'r2')
      await harness.seed.readyPayload(alternateProof)
      const alternate = clone(plan)
      alternate.payloads = [raw, script, alternateProof, outboxData]
      alternate.decisions[0].applied.proof = alternateProof
      alternate.steak = 'not regenerated on retry'

      expect(committedReceipt(await harness.restart().commitAdmission(alternate))).toEqual({
        operationId: plan.key.operationId,
        semanticDigest: plan.key.semanticDigest,
        durability: 'atomic-local',
        steak: plan.steak,
        indexes: [{ target: 'ls_contract', state: 'pending' }],
        propagation: 'pending'
      })
    })

    test('rejects reuse of an operation ID with another semantic digest', async () => {
      const plan = admissionPlan()
      await seedPlan(harness, plan)
      await harness.storage.admission!.commitAdmission(plan)

      const conflicting = admissionPlan(plan.key.operationId, hash('7'))
      rejected(await harness.storage.admission!.commitAdmission(conflicting), 'digest-mismatch')
    })

    test('rejects a supplied digest that does not bind the identity without publishing effects', async () => {
      const plan = admissionPlan()
      await seedPlan(harness, plan)
      const before = await harness.snapshot()
      plan.key.semanticDigest = hash('0')

      rejected(await harness.storage.admission!.commitAdmission(plan), 'digest-mismatch')
      expect(await harness.snapshot()).toEqual(before)
    })

    test('rejects a missing ready payload without partially applying the plan', async () => {
      const plan = admissionPlan()
      await seedPlan(harness, plan, [proof.digest])
      const before = await harness.snapshot()

      rejected(await harness.storage.admission!.commitAdmission(plan), 'payload-not-ready')
      expect(await harness.snapshot()).toEqual(before)
    })

    test('rejects unsupported semantic effects before publishing a partial admission', async () => {
      const wrongOutput = admissionPlan()
      await seedPlan(harness, wrongOutput)
      const before = await harness.snapshot()
      wrongOutput.decisions[0].outputs[0].txid = hash('7')
      rejected(await harness.storage.admission!.commitAdmission(wrongOutput), 'invalid-plan')
      expect(await harness.snapshot()).toEqual(before)

      const historicalPropagation = admissionPlan('historical-operation')
      historicalPropagation.identity.mode = 'historical'
      historicalPropagation.key.semanticDigest = admissionSemanticDigest(
        historicalPropagation.identity
      )
      await seedPlan(harness, historicalPropagation)
      rejected(
        await harness.storage.admission!.commitAdmission(historicalPropagation),
        'invalid-plan'
      )
      expect(await harness.snapshot()).toEqual(before)
    })

    test('rejects non-wire output indexes and duplicate decision topics without effects', async () => {
      const oversized = admissionPlan('oversized-index')
      await seedPlan(harness, oversized)
      const before = await harness.snapshot()
      oversized.decisions[0].outputs[0].outputIndex = '9007199254740993'
      oversized.decisions[0].edges[0].consumer.outputIndex = '9007199254740993'
      // The old model rounded the index and accepted precisely this incorrect ACK.
      oversized.steak = JSON.stringify({
        tm_contract: { outputsToAdmit: [9007199254740992], coinsToRetain: [], coinsRemoved: [] }
      })
      rejected(await harness.storage.admission!.commitAdmission(oversized), 'invalid-plan')
      expect(await harness.snapshot()).toEqual(before)

      const uint32Overflow = admissionPlan('uint32-overflow')
      await seedPlan(harness, uint32Overflow)
      uint32Overflow.decisions[0].outputs[0].outputIndex = '4294967296'
      uint32Overflow.decisions[0].edges[0].consumer.outputIndex = '4294967296'
      uint32Overflow.steak = JSON.stringify({
        tm_contract: { outputsToAdmit: [4294967296], coinsToRetain: [], coinsRemoved: [] }
      })
      rejected(await harness.storage.admission!.commitAdmission(uint32Overflow), 'invalid-plan')
      expect(await harness.snapshot()).toEqual(before)

      const duplicateTopic = admissionPlan('duplicate-decision')
      duplicateTopic.identity.topics.push({ topic: 'tm_other', policyId: 'policy-2' })
      duplicateTopic.key.semanticDigest = admissionSemanticDigest(duplicateTopic.identity)
      duplicateTopic.decisions[0].outputs = []
      duplicateTopic.decisions[0].spends = []
      duplicateTopic.decisions[0].edges = []
      duplicateTopic.decisions.push(clone(duplicateTopic.decisions[0]))
      // Matching key count and no duplicate output insertion must not hide the omitted topic.
      duplicateTopic.steak = JSON.stringify({
        tm_contract: { outputsToAdmit: [], coinsToRetain: [], coinsRemoved: [] },
        tm_other: { outputsToAdmit: [77], coinsToRetain: [], coinsRemoved: [] }
      })
      await seedPlan(harness, duplicateTopic)
      rejected(await harness.storage.admission!.commitAdmission(duplicateTopic), 'invalid-plan')
      expect(await harness.snapshot()).toEqual(before)
    })

    test('rejects stale read and conditional-spend predicates without partially applying the plan', async () => {
      const staleRead = admissionPlan()
      await seedPlan(harness, staleRead)
      await harness.seed.read(referenceScope, 'tm_contract', 'selection:tm_contract', 'r2')
      const readBefore = await harness.snapshot()
      rejected(await harness.storage.admission!.commitAdmission(staleRead), 'read-conflict')
      expect(await harness.snapshot()).toEqual(readBefore)

      await harness.reset()
      const staleSpend = admissionPlan()
      await seedPlan(harness, staleSpend)
      await harness.seed.spendable(referenceScope, 'tm_contract', source, 'spend-r2')
      const spendBefore = await harness.snapshot()
      rejected(await harness.storage.admission!.commitAdmission(staleSpend), 'spend-conflict')
      expect(await harness.snapshot()).toEqual(spendBefore)
    })

    test('allows only one concurrent conditional spend and publishes no loser effects', async () => {
      const first = admissionPlan('race-first', hash('6'))
      const second = admissionPlan('race-second', hash('7'))
      await seedPlan(harness, first)
      await seedPlan(harness, second)

      const results = await Promise.all([
        harness.storage.admission!.commitAdmission(first),
        harness.storage.admission!.commitAdmission(second)
      ])
      expect(results.filter(result => result.state === 'committed')).toHaveLength(1)
      expect(
        results.filter(result => result.state === 'rejected' && result.code === 'spend-conflict')
      ).toHaveLength(1)

      const winner = results.find(result => result.state === 'committed')
      if (winner?.state !== 'committed') throw new Error('Expected a single committed spender')
      const winnerTxid =
        winner.receipt.operationId === first.key.operationId
          ? first.identity.txid
          : second.identity.txid
      const snapshot = await harness.snapshot()
      expect(snapshot.outputs.filter(output => output.output?.txid === winnerTxid)).toHaveLength(1)
      expect(snapshot.applied).toEqual([
        expect.objectContaining({ record: expect.objectContaining({ txid: winnerTxid }) })
      ])
      expect(
        snapshot.outbox.every(event =>
          event.eventId.startsWith(
            winnerTxid === first.identity.txid ? 'race-first:' : 'race-second:'
          )
        )
      ).toBe(true)
    })

    test('isolates same outpoints and outbox event IDs by scope and topic', async () => {
      const otherScope = { ...referenceScope, nodeId: 'reference-node-b' }
      const first = planForScopeAndTopic(referenceScope, 'tm_contract', 'shared-operation')
      const second = planForScopeAndTopic(otherScope, 'tm_contract', 'shared-operation')
      const third = planForScopeAndTopic(referenceScope, 'tm_other', 'topic-operation')
      second.decisions[0].reads[0].expectedVersion = 'r2'
      await seedPlan(harness, first)
      await seedPlan(harness, second)
      await seedPlan(harness, third)

      committedReceipt(await harness.storage.admission!.commitAdmission(first))
      committedReceipt(await harness.storage.admission!.commitAdmission(second))
      committedReceipt(await harness.storage.admission!.commitAdmission(third))

      const snapshot = await harness.snapshot()
      expect(
        snapshot.outputs.filter(output => output.output?.txid === first.identity.txid)
      ).toHaveLength(3)
      expect(snapshot.outbox.filter(event => event.eventId === 'shared-operation:lookup')).toEqual([
        { scope: referenceScope, eventId: 'shared-operation:lookup' },
        { scope: otherScope, eventId: 'shared-operation:lookup' }
      ])
    })

    test('does not overwrite a scope-local outbox event from another operation', async () => {
      const first = admissionPlan('outbox-first')
      await seedPlan(harness, first)
      committedReceipt(await harness.storage.admission!.commitAdmission(first))
      const before = await harness.snapshot()

      const conflicting = admissionPlan('outbox-second', hash('6'))
      conflicting.decisions[0].spends = []
      conflicting.outbox = clone(first.outbox)
      rejected(await harness.storage.admission!.commitAdmission(conflicting), 'invalid-plan')
      expect(await harness.snapshot()).toEqual(before)
    })

    test('moves a history revision and recovery checkpoint atomically, rejecting a stale worker', async () => {
      const plan = admissionPlan()
      await seedPlan(harness, plan)
      const lease: RecoveryLease = {
        scope: referenceScope,
        topic: 'tm_contract',
        peerId: 'peer-a',
        jobId: 'repair-a',
        leaseToken: '9',
        expiresAtMs: '100',
        ...history
      }
      await harness.seed.lease(lease)
      await harness.seed.now('50')
      plan.decisions[0].historyUpdate = {
        nextTopicHistoryGeneration: '4',
        affectedFromHeight: '99',
        handoff: { expected: lease, checkpoint: 'repair-checkpoint' }
      }

      committedReceipt(await harness.storage.admission!.commitAdmission(plan))
      const snapshot = await harness.snapshot()
      expect(snapshot.fences.find(item => item.topic === 'tm_contract')?.fence).toEqual({
        chainEpoch: '7',
        topicHistoryGeneration: '4'
      })
      expect(snapshot.handoffs).toEqual([{ topic: 'tm_contract', checkpoint: 'repair-checkpoint' }])
      expect(snapshot.historyUpdates).toEqual([
        { topic: 'tm_contract', affectedFromHeight: '99', checkpoint: 'repair-checkpoint' }
      ])
      expect(snapshot.leases).toEqual([
        expect.objectContaining({ ...lease, topicHistoryGeneration: '4' })
      ])

      const stale = admissionPlan('operation-2', hash('6'))
      await seedPlan(harness, stale)
      await harness.seed.history(referenceScope, 'tm_contract', {
        chainEpoch: '7',
        topicHistoryGeneration: '4'
      })
      stale.decisions[0].expectedHistory = { chainEpoch: '7', topicHistoryGeneration: '4' }
      stale.decisions[0].spends = []
      stale.decisions[0].historyUpdate = {
        nextTopicHistoryGeneration: '5',
        affectedFromHeight: '99',
        handoff: { expected: lease, checkpoint: 'stale-checkpoint' }
      }
      const staleBefore = await harness.snapshot()
      rejected(await harness.storage.admission!.commitAdmission(stale), 'read-conflict')
      expect(await harness.snapshot()).toEqual(staleBefore)
    })

    test('recovers a lost entire post-commit response before running a new body', async () => {
      const plan = admissionPlan()
      await seedPlan(harness, plan)
      await harness.faults.loseReplyAfterCommitOnce()

      await harness.storage.admission!.commitAdmission(plan)
      const afterCommit = await harness.snapshot()

      const recovered = await harness.restart().commitAdmission(clone(plan))
      expect(recovered.state).toBe('pending')
      if (recovered.state !== 'pending')
        throw new Error('Expected a recovered opaque commit attempt')
      expect(await harness.restart().reconcileAdmission(plan.key, 'wrong-attempt')).toEqual(
        recovered
      )
      expect(await harness.snapshot()).toEqual(afterCommit)
      expect(committedReceipt(await harness.restart().reconcileAdmission(plan.key))).toEqual({
        operationId: plan.key.operationId,
        semanticDigest: plan.key.semanticDigest,
        durability: 'atomic-local',
        steak: plan.steak,
        indexes: [{ target: 'ls_contract', state: 'pending' }],
        propagation: 'pending'
      })
      expect(await harness.snapshot()).toEqual(afterCommit)
    })

    test('publishes no effects when an attempt is definitively aborted before commit', async () => {
      const plan = admissionPlan()
      await seedPlan(harness, plan)
      const before = await harness.snapshot()
      await harness.faults.abortBeforeCommitOnce()

      const pending = await harness.storage.admission!.commitAdmission(plan)
      expect(pending.state).toBe('pending')
      if (pending.state !== 'pending') throw new Error('Expected an opaque abort attempt')
      expect(await harness.snapshot()).toEqual(before)
      expect(await harness.storage.admission!.commitAdmission(plan)).toEqual(pending)
      expect(
        await harness.storage.admission!.reconcileAdmission(plan.key, pending.attemptId)
      ).toEqual({ state: 'aborted' })
      expect(await harness.snapshot()).toEqual(before)
      expect(committedReceipt(await harness.storage.admission!.commitAdmission(plan)).steak).toBe(
        plan.steak
      )
    })
  })
}

export const referenceAdmissionStorageContract = (): void => {
  admissionStorageContract(() => new ReferenceAdmissionHarness())
}

describe('reference adapter boundaries', () => {
  test('rejects a non-replay-safe projection before running the admission body', async () => {
    const harness = new ReferenceAdmissionHarness({ projector: { protocol: 'not-replay-safe' } })
    const plan = admissionPlan()
    await seedPlan(harness, plan)
    const before = harness.snapshot()

    rejected(await harness.storage.admission!.commitAdmission(plan), 'unsupported-projection')
    expect(harness.snapshot()).toEqual(before)
  })

  test('does not invoke even a replay-safe projector during model commit', async () => {
    const projector: ReplaySafeProjection = {
      protocol: 'overlay-projection-v1',
      applyEvent: jest.fn(async () => ({ checkpoint: 'unexpected' })),
      reconcile: jest.fn(async () => ({ checkpoint: 'unexpected' }))
    }
    const harness = new ReferenceAdmissionHarness({ projector })
    const plan = admissionPlan()
    await seedPlan(harness, plan)

    committedReceipt(await harness.storage.admission!.commitAdmission(plan))
    expect(projector.applyEvent).not.toHaveBeenCalled()
    expect(projector.reconcile).not.toHaveBeenCalled()
  })
})
