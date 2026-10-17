import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { aliasCurrentnessFixture } from './private-purchase-alias-currentness.fixture.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  seed: Number.isSafeInteger(requestedSeed) ? requestedSeed : 3242026,
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true,
  ...(process.env.FAST_CHECK_PATH ? { path: process.env.FAST_CHECK_PATH } : {})
})

it('independently checks generated selected-ancestry, availability and cancellation histories without stale currentness reuse', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.record({
          selected: fc.constantFrom('included' as const, 'fork' as const),
          available: fc.boolean(),
          cancel: fc.boolean()
        }),
        { minLength: 1, maxLength: 6 }
      ),
      async history => {
        const f = aliasCurrentnessFixture()
        const reports: NonNullable<Awaited<ReturnType<typeof f.adapter.assess>>>[] = []
        for (const step of history) {
          f.select(step.selected)
          f.available(step.available)
          for (const old of reports) expect(() => old.placement.checkCurrent()).toThrow()
          const abort = new AbortController()
          if (step.cancel) abort.abort()
          const pending = f.adapter.assess(f.subject, f.submit(), abort.signal)
          // The oracle is selected directly from independent fixture ancestry and
          // availability. It does not use adapter output to choose the expectation.
          if (step.cancel) await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
          else if (!step.available) expect(await pending).toBeUndefined()
          else if (step.selected === 'fork')
            await expect(pending).rejects.toMatchObject({ code: 'invalid' })
          else {
            const report = (await pending)!
            expect(report.currentAlias).toEqual({ txid: f.submit().txid, beef: f.submit().beef })
            expect(report.height).toBe('102')
            expect(() => report.placement.checkCurrent()).not.toThrow()
            reports.push(report)
          }
        }
      }
    )
  )
}, 180000)
