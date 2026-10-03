import { expect, it, jest } from '@jest/globals'
import fc from 'fast-check'
import { purchaseDisclosureFixture } from './private-purchase-disclosure.fixture.js'

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

it('rechecks retained native purchase authority and exact bytes at generated physical enqueue boundaries', () => {
  fc.assert(
    fc.property(
      fc.record({
        delivered: fc.boolean(),
        terms: fc.boolean(),
        interruption: fc.integer({ min: 0, max: 4 }),
        late: fc.boolean()
      }),
      schedule => {
        const f = purchaseDisclosureFixture()
        try {
          if (schedule.delivered) f.f.deliver()
          else f.f.prepare()
          const original = f.f.owner.store.load(f.f.id, f.caller.buyer, f.f.clock, f.f.guard)!
          if (schedule.delivered && schedule.terms) {
            expect(() => f.disclosure.prepare(f.f.id, f.caller, { terms: true })).toThrow(
              'Purchase preparation is no longer payable'
            )
            return
          }
          const result = f.disclosure.prepare(f.f.id, f.caller, { terms: schedule.terms }),
            send = jest.fn((_body: string, _headers: unknown) => {})
          if (schedule.interruption === 1) f.setPermitted(false)
          if (schedule.interruption === 2) f.setAuthenticated(false)
          if (schedule.interruption === 3 && !schedule.delivered) f.f.pin()
          if (schedule.interruption === 4) f.caller.capability = 'ee'.repeat(32)
          if (schedule.late) f.f.setNow('100000')
          const refused =
            schedule.interruption === 1 ||
            schedule.interruption === 2 ||
            (schedule.interruption === 3 && !schedule.delivered) ||
            (schedule.terms && schedule.late)
          if (refused) {
            expect(() => result.enqueue(send)).toThrow()
            expect(send).not.toHaveBeenCalled()
          } else {
            result.enqueue(send)
            expect(send).toHaveBeenCalledTimes(1)
            expect(send).toHaveBeenCalledWith(result.body, result.headers)
            expect(JSON.parse(result.body)).toEqual(
              schedule.terms
                ? original.custody.original.terms
                : schedule.delivered
                  ? f.f.f.envelope()
                  : {
                      result: {
                        version: 1,
                        status: 'prepared',
                        acquisitionId: f.f.id,
                        recoveryUntil: original.custody.original.terms.body.recoveryUntil
                      }
                    }
            )
          }
          expect(() => result.enqueue(send)).toThrow()
          expect(send.mock.calls.length).toBeLessThanOrEqual(1)
        } finally {
          f.f.dispose()
        }
      }
    )
  )
}, 180000)
