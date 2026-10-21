import fc from 'fast-check'
import { purchaseAdmissionFixture } from './PurchaseAdmissionFixture.js'
import { asStorageUint64 } from '../storage/AdmissionStorage.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  seed: Number.isSafeInteger(requestedSeed) ? requestedSeed : 3242026,
  interruptAfterTimeLimit: 90000,
  markInterruptAsFailure: true,
  ...(process.env.FAST_CHECK_PATH ? { path: process.env.FAST_CHECK_PATH } : {})
})

test('recovers original admission after an uncertain submit and preserves selected-topic time on every retry', async () => {
  // Reuse only immutable public signed representations. Every generated case
  // gets independent history/Engine spies and its own local effect observations.
  const f = purchaseAdmissionFixture()
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        alreadyPublic: fc.boolean(),
        lost: fc.boolean(),
        retryCount: fc.integer({ min: 1, max: 3 }),
        acceptedAt: fc.integer({ min: 20, max: 10000 })
      }),
      async schedule => {
        jest.clearAllMocks()
        const original = {
          ...f.original(),
          acceptedAt: asStorageUint64(String(schedule.acceptedAt))
        }
        let retained = schedule.alreadyPublic
        f.read.mockImplementation(async () =>
          retained
            ? { state: 'committed', admission: structuredClone(original) }
            : { state: 'unresolved' }
        )
        f.submit.mockImplementation(async () => {
          retained = true
          if (schedule.lost) throw new Error('reply lost after original commit')
          return {}
        })
        const result = await f.run()
        expect(result).toMatchObject({
          status: 'admitted',
          acceptedAt: String(schedule.acceptedAt)
        })
        for (let attempt = 0; attempt < schedule.retryCount; attempt++)
          expect(await f.run()).toEqual(result)
        expect(f.submit).toHaveBeenCalledTimes(schedule.alreadyPublic ? 0 : 1)
        expect(JSON.stringify(result)).not.toMatch(/tm_private|potatoes|secret/)
      }
    )
  )
}, 120000)
