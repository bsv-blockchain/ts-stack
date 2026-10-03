import fc from 'fast-check'
import { guardAuthenticatedResponse } from '../../mod.js'
import { queueFixture } from './authenticatedResponseQueue.fixture.js'

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

it(
  'preserves exact signed bytes and status through final admission or a single authenticated replacement',
  async () => {
    let current = { status: 200, bytes: new Uint8Array(), replace: false }
    let attempts: number[] = []
    const fixture = await queueFixture(
      (_req, res) => {
        const selected = current
        guardAuthenticatedResponse(res, (candidate, enqueue) => {
          attempts.push(candidate.attempt)
          expect(candidate.identityKey).toBe(fixture.clientIdentity)
          expect(candidate.headers['x-bsv-auth-signature']).toMatch(/^[0-9a-f]+$/)
          if (candidate.attempt === 0 && selected.replace)
            return {
              statusCode: 409,
              headers: { 'x-bsv-state': 'reset', 'content-type': 'application/octet-stream' },
              body: Uint8Array.from([17, 19])
            }
          enqueue()
        })
        res.status(selected.status).set('x-bsv-state', 'current').send(Buffer.from(selected.bytes))
      },
      { timeout: 3000 }
    )
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(200, 201, 400, 409),
          fc.uint8Array({ maxLength: 64 }),
          fc.boolean(),
          async (status, bytes, replace) => {
            current = { status, bytes, replace }
            attempts = []
            const response = await fixture.client.fetch(fixture.url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '{}'
            })
            expect(response.status).toBe(replace ? 409 : status)
            expect(response.headers.get('x-bsv-state')).toBe(replace ? 'reset' : 'current')
            expect(new Uint8Array(await response.arrayBuffer())).toEqual(
              replace ? Uint8Array.from([17, 19]) : bytes
            )
            expect(attempts).toEqual(replace ? [0, 1] : [0])
          }
        )
      )
    } finally {
      await fixture.close()
    }
  },
  Math.min(2147483647, Math.max(90000, propertyRuns * 300))
)
