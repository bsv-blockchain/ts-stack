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
          let store = f.store,
            revision = 0n,
            eligible = false,
            ready = false,
            currentPolicy = policy
          const bases: { id: string; policyDigest: string; active: boolean }[] = []
          const retained: { requestId: string; action: ReturnType<typeof action> }[] = []
          try {
            for (let index = 0; index < steps.length; index++) {
              const step = steps[index],
                id = `generated_request_${index}`
              if (step.kind === 0 || (step.kind === 1 && bases.length === 0)) {
                const result = await apply(store, request(id))
                revision++
                bases.push({
                  id: result.outcomes[0].decisionId!,
                  policyDigest: currentPolicy,
                  active: true
                })
                retained.push({ requestId: id, action: action(result.outcomes[0]) })
                eligible = true
                ready = false
              } else if (step.kind === 1) {
                const basis = bases[step.select % bases.length],
                  wasActive = basis.active
                const result = await apply(store, restore(id, basis.id))
                revision++
                expect(result.outcomes[0].actionStatus).toBe(wasActive ? 'applied' : 'no-op')
                retained.push({ requestId: id, action: action(result.outcomes[0]) })
                basis.active = false
                if (wasActive) {
                  eligible = true
                  ready = false
                }
              } else if (step.kind === 2) {
                await store.assess({
                  operationId: id,
                  expectedRevision: revision.toString(),
                  target: selected(),
                  eligible: step.eligible,
                  evidenceDigest: '77'.repeat(32),
                  reasonCode: 'generated-currentness-assessment'
                })
                revision++
                eligible = step.eligible
                ready = false
              } else {
                currentPolicy = currentPolicy === policy ? '66'.repeat(32) : policy
                await store.changePolicy(currentPolicy)
                revision++
                eligible = false
                ready = false
              }
              const pending = await store.projections(1)
              if (step.project && pending.length > 0) {
                expect(await store.projected(pending[0])).toBe(true)
                revision++
                ready = true
              }
              expect(await store.head()).toEqual({
                revision: revision.toString(),
                policyDigest: currentPolicy
              })
              const blockers = bases
                .filter(basis => basis.active)
                .map(basis => ({ decisionId: basis.id, policyDigest: basis.policyDigest }))
                .sort(
                  (left, right) =>
                    Number(left.decisionId > right.decisionId) -
                    Number(left.decisionId < right.decisionId)
                )
              const serving = await store.serving(selected())
              expect(serving.blockers).toEqual(blockers)
              expect(serving.state).toBe(
                blockers.length > 0 ? 'suppressed' : eligible && ready ? 'eligible' : 'unresolved'
              )
              for (const previous of retained)
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
