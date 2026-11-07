import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { acquisitionCoordinatorFixture } from './private-acquisition-coordinator.fixture.js'
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
it('preserves one original obligation and one credit across generated service interruptions', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        mode: fc.integer({ min: 0, max: 5 }),
        late: fc.boolean(),
        retries: fc.integer({ min: 0, max: 3 }),
        withdrawn: fc.boolean()
      }),
      async schedule => {
        const f = await acquisitionCoordinatorFixture()
        try {
          await f.quote()
          const original = f.current()!.original
          if (schedule.withdrawn) f.setAvailable(false)
          if (schedule.mode === 4) {
            f.f.setNow(original.challenge.recoveryUntil)
            await f.recover()
            expect(f.projected()).toMatchObject({ status: 'expired' })
            expect(f.getCredits()).toBe(0)
          } else {
            if (schedule.mode === 1) f.setRelease(false)
            if (schedule.mode === 2) f.setIssue(false)
            if (schedule.mode === 3) {
              f.setAccess(false)
              await expect(f.pay()).rejects.toMatchObject({ code: 'context-changed' })
              expect(f.getCredits()).toBe(0)
              f.setAccess(true)
            }
            if (schedule.mode === 5) {
              await expect(
                f.coordinator.acquire({ ...f.request, request: 'AQ==' }, undefined, f.caller)
              ).rejects.toMatchObject({ code: 'conflict' })
              expect(f.current()!.original).toEqual(original)
            }
            if (schedule.mode === 2) await expect(f.pay()).rejects.toThrow('issuer unavailable')
            else await f.pay()
            if (schedule.late) f.f.setNow('100000')
            f.setRelease(true)
            f.setIssue(true)
            for (let i = 0; i <= schedule.retries; i++) await f.recover()
            expect(f.projected()).toMatchObject({
              status: 'delivered',
              challenge: original.challenge,
              result: { context: 'AQID' }
            })
            expect(f.getCredits()).toBe(1)
            expect(f.current()!.state.progress.funding!.operation.funding.txid).toBe(
              f.paymentTransaction.id('hex')
            )
          }
          expect(f.current()!.original).toEqual(original)
          expect(f.counts.prepare).toBe(1)
        } finally {
          await f.dispose()
        }
      }
    )
  )
}, 180000)
