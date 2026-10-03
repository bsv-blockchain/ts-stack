import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import type { OutputRootEvictionOutcome } from '@bsv/sdk'
import {
  apply,
  fixture,
  policy,
  request,
  requester,
  restore,
  selected
} from './root-eviction-fixture.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
const propertyRuns = Number.isSafeInteger(requestedRuns)
  ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
  : MIN_PROPERTY_RUNS
fc.configureGlobal({
  numRuns: propertyRuns,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})
function action(value: OutputRootEvictionOutcome) {
  return {
    actionStatus: value.actionStatus,
    revision: value.revision,
    decisionId: value.decisionId,
    affectedDecisionIds: value.affectedDecisionIds,
    reasonCode: value.reasonCode
  }
}

type GeneratedStep = { kind: number; select: number; project: boolean; eligible: boolean }
type GeneratedModel = {
  revision: bigint
  eligible: boolean
  ready: boolean
  currentPolicy: string
  bases: { id: string; policyDigest: string; active: boolean }[]
  retained: { requestId: string; action: ReturnType<typeof action> }[]
}
async function applyGeneratedStep(
  store: Awaited<ReturnType<typeof fixture>>['store'],
  model: GeneratedModel,
  step: GeneratedStep,
  id: string
) {
  if (step.kind === 0 || (step.kind === 1 && model.bases.length === 0)) {
    const result = await apply(store, request(id))
    model.revision++
    model.bases.push({
      id: result.outcomes[0].decisionId!,
      policyDigest: model.currentPolicy,
      active: true
    })
    model.retained.push({ requestId: id, action: action(result.outcomes[0]) })
    model.eligible = true
    model.ready = false
  } else if (step.kind === 1) {
    const basis = model.bases[step.select % model.bases.length],
      wasActive = basis.active
    const result = await apply(store, restore(id, basis.id))
    model.revision++
    expect(result.outcomes[0].actionStatus).toBe(wasActive ? 'applied' : 'no-op')
    model.retained.push({ requestId: id, action: action(result.outcomes[0]) })
    basis.active = false
    if (wasActive) {
      model.eligible = true
      model.ready = false
    }
  } else if (step.kind === 2) {
    await store.assess({
      operationId: id,
      expectedRevision: model.revision.toString(),
      target: selected(),
      eligible: step.eligible,
      evidenceDigest: '77'.repeat(32),
      reasonCode: 'generated-currentness-assessment'
    })
    model.revision++
    model.eligible = step.eligible
    model.ready = false
  } else {
    model.currentPolicy = model.currentPolicy === policy ? '66'.repeat(32) : policy
    await store.changePolicy(model.currentPolicy)
    model.revision++
    model.eligible = false
    model.ready = false
  }
}

async function assertGeneratedEnqueue(
  store: Awaited<ReturnType<typeof fixture>>['store'],
  revision: string,
  state: string
) {
  // Preserve the asynchronous send port and qualify the additive native
  // port against the same generated durable decision/restart history.
  const candidate = {
    revision,
    targets: [selected()],
    bytes: new Uint8Array([1, 2, 3])
  }
  let queued = 0
  const send = (bytes: Uint8Array) => {
    expect(bytes).toEqual(candidate.bytes)
    queued++
    return undefined
  }
  if (state === 'eligible') {
    await store.enqueue(candidate, () => true, send)
    store.enqueueNow(candidate, () => true, send)
    expect(queued).toBe(2)
  } else {
    await expect(store.enqueue(candidate, () => true, send)).rejects.toMatchObject({
      code: 'reset-required'
    })
    expect(() => store.enqueueNow(candidate, () => true, send)).toThrow('prohibited or unresolved')
    expect(queued).toBe(0)
  }
}

it(
  'preserves independent suppression bases, permanent action attribution and queue eligibility through generated restart histories',
  async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            kind: fc.integer({ min: 0, max: 3 }),
            select: fc.nat(20),
            project: fc.boolean(),
            eligible: fc.boolean()
          }),
          { minLength: 1, maxLength: 8 }
        ),
        async steps => {
          const f = await fixture()
          let store = f.store
          const model: GeneratedModel = {
            revision: 0n,
            eligible: false,
            ready: false,
            currentPolicy: policy,
            bases: [],
            retained: []
          }
          try {
            for (let index = 0; index < steps.length; index++) {
              const step = steps[index],
                id = `generated_request_${index}`
              await applyGeneratedStep(store, model, step, id)
              const pending = await store.projections(1)
              if (step.project && pending.length > 0) {
                expect(await store.projected(pending[0])).toBe(true)
                model.revision++
                model.ready = true
              }
              expect(await store.head()).toEqual({
                revision: model.revision.toString(),
                policyDigest: model.currentPolicy
              })
              const blockers = model.bases
                .filter(basis => basis.active)
                .map(basis => ({ decisionId: basis.id, policyDigest: basis.policyDigest }))
                .sort(
                  (left, right) =>
                    Number(left.decisionId > right.decisionId) -
                    Number(left.decisionId < right.decisionId)
                )
              const serving = await store.serving(selected())
              expect(serving.blockers).toEqual(blockers)
              let expectedState = 'unresolved'
              if (model.eligible && model.ready) expectedState = 'eligible'
              if (blockers.length > 0) expectedState = 'suppressed'
              expect(serving.state).toBe(expectedState)
              await assertGeneratedEnqueue(store, model.revision.toString(), serving.state)
              expect(store.captureServing()).toEqual(await store.head())
              for (const previous of model.retained)
                expect(
                  action((await store.result(requester, previous.requestId, '150')).outcomes[0])
                ).toEqual(previous.action)
              if (index === Math.floor(steps.length / 2)) {
                await store.close()
                store = f.reopen()
                expect(await store.serving(selected())).toEqual(serving)
              }
            }
          } finally {
            await f.cleanup()
          }
        }
      )
    )
  },
  Math.min(2147483647, Math.max(120000, propertyRuns * 400))
)
