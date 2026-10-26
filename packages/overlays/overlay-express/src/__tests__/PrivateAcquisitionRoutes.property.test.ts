import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { privateAcquisitionHTTPFixture } from './PrivateAcquisitionRoutes.fixture.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const propertyRuns = Number.isSafeInteger(requestedRuns)
  ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
  : MIN_PROPERTY_RUNS
fc.configureGlobal({
  numRuns: propertyRuns,
  seed: Number.isSafeInteger(requestedSeed) ? requestedSeed : 3242026,
  ...(process.env.FAST_CHECK_PATH ? { path: process.env.FAST_CHECK_PATH } : {})
})
it(
  'preserves the one paid result through generated authenticated disclosure and permission schedules',
  async () => {
    const f = await privateAcquisitionHTTPFixture()
    try {
      expect((await f.fetch()).status).toBe(402)
      const paid = await f.fetch('acquire', undefined, f.payment)
      expect(paid.status).toBe(200)
      const original = await paid.json()
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('stable', 'deny-data', 'deny-control'),
          fc.integer({ min: 0, max: 64 }),
          async (mode, padding) => {
            f.onHTTPSign()
            f.setAccess(true)
            f.httpState.control = true
            const before = f.wireHeaders.length
            f.onHTTPSign(() => {
              if (mode !== 'stable') f.setAccess(false)
              if (mode === 'deny-control') f.httpState.control = false
            })
            const response = f.fetch('recover', JSON.stringify(f.status) + ' '.repeat(padding))
            if (mode === 'deny-control') {
              await expect(response).rejects.toThrow()
              expect(f.wireHeaders).toHaveLength(before)
            } else {
              const recovered = await response
              if (mode === 'stable') {
                expect(recovered.status).toBe(200)
                expect(await recovered.json()).toEqual(original)
              } else {
                expect(recovered.status).toBe(404)
                expect(await recovered.json()).toEqual({
                  version: 1,
                  error: {
                    code: 'not-found',
                    message: 'Private acquisition request not-found',
                    retryable: false
                  }
                })
              }
              const headers = f.wireHeaders.at(-1)!
              expect(headers.get('cache-control')).toBe('private, no-store')
              expect(headers.get('x-bsv-overlay-capability')).toBe(f.caller.capability)
              expect(headers.has('x-bsv-payment-satoshis-required')).toBe(false)
            }
            expect(f.getCredits()).toBe(1)
            expect(f.counts.prepare).toBe(1)
          }
        )
      )
    } finally {
      await f.close()
    }
  },
  Math.min(2147483647, Math.max(90000, propertyRuns * 300))
)
