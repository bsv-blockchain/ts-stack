import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { fixture, successor } from './proposal-current-fixture.js'
import { signed } from './proposal-client-fixture.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  seed: Number.isSafeInteger(requestedSeed) ? requestedSeed : 3242026,
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true,
  ...(replayPath ? { path: replayPath } : {})
})

it('preserves exact channel order and exclusive local expiry for generated valid histories', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 6 }),
      fc.integer({ min: 10, max: 150 }),
      fc.boolean(),
      (revisions, clock, reversePresentation) => {
        const f = fixture()
        let proposal = signed()
        f.append('snapshot', f.pair(proposal))
        for (let index = 0; index < revisions; index++) {
          const next = successor(proposal)
          f.append('live', [f.removal(proposal), ...f.pair(next)])
          proposal = next
        }
        if (reversePresentation) {
          f.view.heads.reverse()
          f.view.states.reverse()
          f.view.removals.reverse()
        }
        f.view.evaluatedAt = String(clock)
        const result = f.result()
        expect(result.consistent).toBe(true)
        expect(result.channels).toHaveLength(1)
        expect(result.channels[0]).toMatchObject({
          proposal,
          history: 'genesis-linked',
          membership: 'present',
          activeIntent: clock < 100,
          intent: clock < 100 ? 'unexpired' : 'expired'
        })
      }
    )
  )
})
