import { jest } from '@jest/globals'
import fc from 'fast-check'
import { AuthFetch, canonicalOutputJSON } from '../../../mod.js'
import { paidTransportFixture } from './OutputPaidLookupTransport.fixture.js'
const MIN_PROPERTY_RUNS = 300
const runs = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const seed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const path = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(runs) ? Math.max(MIN_PROPERTY_RUNS, runs) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(seed) ? { seed } : {}),
  ...(path ? { path } : {})
})
afterEach(() => jest.restoreAllMocks())
it('retains one selected request and payment across generated quote/payment/recovery histories', async () => {
  const fixtures = {
    quote: paidTransportFixture('quote'),
    pay: paidTransportFixture('pay'),
    recover: paidTransportFixture('recover')
  }
  const send = jest.spyOn(AuthFetch.prototype, 'fetch')
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.record({
          operation: fc.constantFrom('quote' as const, 'pay' as const, 'recover' as const),
          quoted: fc.boolean(),
          changedRequest: fc.boolean(),
          changedSelector: fc.boolean()
        }),
        { minLength: 1, maxLength: 5 }
      ),
      async history => {
        for (const step of history) {
          const f = fixtures[step.operation],
            isChallenge = step.operation === 'quote' && !step.quoted
          const packet = structuredClone(
            isChallenge ? f.challenge : step.quoted ? f.quoted : f.delivered
          )
          const quote = 'challenge' in packet ? packet.challenge : packet
          if (step.changedRequest) quote.requestDigest = 'ff'.repeat(32)
          send.mockImplementation(async () =>
            f.response(
              packet,
              isChallenge ? 402 : 200,
              step.changedSelector ? { 'x-bsv-overlay-capability': 'ff'.repeat(32) } : {}
            )
          )
          const result = f.client.send()
          if (step.changedRequest || step.changedSelector) await expect(result).rejects.toThrow()
          else
            expect(await result).toEqual(
              step.operation === 'quote'
                ? isChallenge
                  ? { kind: 'challenge', challenge: packet }
                  : { kind: 'status', response: packet }
                : packet
            )
          const [url, init] = send.mock.calls.at(-1)!
          expect(url).toBe(
            'https://provider.example.test/api/overlay/v1/private/' +
              (step.operation === 'recover' ? 'recover' : 'acquire')
          )
          expect(JSON.parse(init!.body as string)).toEqual(
            step.operation === 'recover'
              ? { version: 1, acquisitionId: f.challenge.acquisitionId }
              : f.request
          )
          expect(new Headers(init!.headers).get('x-bsv-payment')).toBe(
            step.operation === 'pay' ? canonicalOutputJSON(f.payment) : null
          )
          expect(init).toMatchObject({
            allowPayments: false,
            requireMutualAuth: true,
            expectedIdentityKey: f.challenge.seller
          })
        }
      }
    )
  )
})
