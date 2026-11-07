import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { fixture, configuration, authorize, address, change } from './protected-ledger-fixture.js'

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

it('preserves independently modeled revisions, reservations and monotonic observations through 300 generated native restart schedules', () => {
  fc.assert(
    fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }), steps => {
      const f = fixture({ ...configuration, maximumRecords: 8, maximumReservedBytes: 512 })
      let owner = f.ledger
      try {
        for (let index = 0; index < steps.length; index++) {
          const next = change(index + 1, { secret: String(steps[index]) }, 64)
          expect(owner.commit(String(index), [next], () => String(100 + index), authorize)).toBe(
            String(index + 1)
          )
          expect(() =>
            owner.commit(String(index), [change(99)], () => String(200 + index), authorize)
          ).toThrow('changed before commit')
          owner.close()
          owner = f.reopen()
          const snapshot = owner.read(
            Array.from({ length: index + 1 }, (_, i) => address(i + 1)),
            () => '1',
            authorize
          )
          expect(snapshot.revision).toBe(String(index + 1))
          expect(snapshot.observedAt).toBe(String(200 + index))
          expect(snapshot.records.map(row => row!.value.secret)).toEqual(
            steps.slice(0, index + 1).map(String)
          )
          expect(
            snapshot.records.every(row => row!.revision === '1' && row!.reservedBytes === 64)
          ).toBe(true)
        }
      } finally {
        f.cleanup()
      }
    })
  )
}, 180000)
