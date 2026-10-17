import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { lchNativeCovenantProfileFixture } from './overlay-acquisition-covenant-profile-native.fixture.js'

const MIN_PROPERTY_RUNS = 300
const requested = Number(process.env.FAST_CHECK_NUM_RUNS),
  requestedSeed = Number(process.env.FAST_CHECK_SEED)
const options = {
  numRuns: Math.max(
    MIN_PROPERTY_RUNS,
    Number.isSafeInteger(requested) ? requested : MIN_PROPERTY_RUNS
  ),
  seed: Number.isSafeInteger(requestedSeed) ? requestedSeed : 3242026,
  ...(process.env.FAST_CHECK_PATH ? { path: process.env.FAST_CHECK_PATH } : {}),
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true
}
fc.configureGlobal(options)

it('fences generated installed-verifier/access changes while a historical complete candidate guard remains independent of new-funding time', async () => {
  const f = await lchNativeCovenantProfileFixture({ candidateBinding: true }),
    signal = new AbortController().signal,
    proof = await f.domain.candidateBinding!(f.prepare, f.prepared, f.submission, signal),
    installed = f.options.verification.candidate!
  await fc.assert(
    fc.property(
      fc.array(
        fc.record({
          time: fc.integer({ min: 22, max: 1000000 }),
          accessible: fc.boolean(),
          changed: fc.boolean()
        }),
        { minLength: 1, maxLength: 12 }
      ),
      steps => {
        for (const step of steps) {
          f.setNow(String(step.time))
          f.setAccess(step.accessible)
          f.options.verification.candidate = step.changed
            ? async (...args) => installed(...args)
            : installed
          // Independent model: access and installed owner determine this guard.
          // New-purchase time never determines an already verified candidate.
          if (step.accessible && !step.changed) expect(proof.checkCurrent()).toBeUndefined()
          else expect(() => proof.checkCurrent()).toThrow()
          expect(proof.purchaseCommitment).toBe(f.purchaseCommitment)
          expect(f.counts).toEqual({ preparation: 0, purchase: 0, release: 0 })
          expect(f.candidateChecks()).toBe(1)
        }
      }
    ),
    options
  )
  f.options.verification.candidate = installed
  f.setAccess(true)
  expect(proof.checkCurrent()).toBeUndefined()
}, 180000)
