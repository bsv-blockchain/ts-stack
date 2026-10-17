import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { privatePurchaseHTTPFixture } from './PrivatePurchaseRoutes.fixture.js'

const MIN_PROPERTY_RUNS = 300
const runs = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const seed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
fc.configureGlobal({
  numRuns: Number.isSafeInteger(runs) ? Math.max(MIN_PROPERTY_RUNS, runs) : MIN_PROPERTY_RUNS,
  seed: Number.isSafeInteger(seed) ? seed : 3242026,
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true,
  ...(process.env.FAST_CHECK_PATH ? { path: process.env.FAST_CHECK_PATH } : {})
})

it('contains generated covenant request/recipient/selector refusals before private effects', async () => {
  const f = await privatePurchaseHTTPFixture()
  try {
    await f.fetch()
    const original = f.owner.current()!.custody.original
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 5 }),
        fc.constantFrom('prepare', 'submit', 'recover'),
        async (mode, operation) => {
          const endpoint = f.origin + '/api/overlay/v1/purchases/' + operation
          let response: Response
          if (mode === 0)
            response = await fetch(endpoint, { method: 'PUT', headers: f.headers, body: '{}' })
          else if (mode === 1)
            response = await fetch(endpoint + '?query=1', {
              method: 'POST',
              headers: f.headers,
              body: '{}'
            })
          else if (mode === 2)
            response = await fetch(endpoint, {
              method: 'POST',
              headers: { ...f.headers, 'x-bsv-payment': '{}' },
              body: '{}'
            })
          else
            response = await f.client.fetch(endpoint, {
              method: 'POST',
              headers: {
                ...f.headers,
                ...(mode === 3 ? { 'x-bsv-overlay-profile': 'unsupported' } : {}),
                ...(mode === 4 ? { 'x-bsv-overlay-capability': 'invalid' } : {})
              },
              body: '{}'
            })
          expect(response.status).toBeGreaterThanOrEqual(400)
          const packet = await response.json()
          expect(packet).toMatchObject({
            version: 1,
            error: { message: 'Private purchase request ' + packet.error.code }
          })
          expect([...response.headers.keys()].some(name => name.startsWith('x-bsv-payment'))).toBe(
            false
          )
          expect(f.owner.counts.admission).toBe(0)
          expect(f.owner.counts.issue).toBe(0)
          expect(f.owner.current()!.custody.original).toEqual(original)
        }
      )
    )
  } finally {
    await f.close()
  }
}, 180000)
