import { afterEach, expect, it, jest } from '@jest/globals'
import fc from 'fast-check'
import { AuthFetch, signOutputPacket, OutputPurchaseTransport } from '../../../mod.js'
import { purchaseTransportFixture, purchaseSeller } from './OutputPurchaseTransport.fixture.js'
const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number(process.env.FAST_CHECK_NUM_RUNS),
  requestedSeed = Number(process.env.FAST_CHECK_SEED)
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  seed: Number.isSafeInteger(requestedSeed) ? requestedSeed : 3242026,
  ...(process.env.FAST_CHECK_PATH ? { path: process.env.FAST_CHECK_PATH } : {}),
  interruptAfterTimeLimit: 60000,
  markInterruptAsFailure: true
})
afterEach(() => jest.restoreAllMocks())
it('keeps original recipient, selected contract and transaction across 300 signed response histories', async () => {
  const fixtures = {
    prepare: purchaseTransportFixture('prepare'),
    submit: purchaseTransportFixture('submit'),
    recover: purchaseTransportFixture('recover')
  }
  const send = jest.spyOn(AuthFetch.prototype, 'fetch')
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom('prepare' as const, 'submit' as const, 'recover' as const),
      fc.boolean(),
      fc.boolean(),
      async (operation, replaceRequest, replaceSelection) => {
        const f = fixtures[operation],
          packet = structuredClone(operation === 'prepare' ? f.terms : f.envelope)
        if (replaceRequest) {
          if ('body' in packet) {
            packet.body.requestDigest = 'ff'.repeat(32)
            packet.signature = signOutputPacket(
              'purchase-terms',
              packet.body,
              purchaseSeller
            ).signature
          } else {
            packet.result.potatoes.body.requestDigest = 'ff'.repeat(32)
            packet.result.potatoes.signature = signOutputPacket(
              'potatoes',
              packet.result.potatoes.body,
              purchaseSeller
            ).signature
          }
        }
        send.mockImplementation(async () =>
          f.response(
            packet,
            200,
            replaceSelection ? { 'x-bsv-overlay-capability': 'ff'.repeat(32) } : {}
          )
        )
        const result = f.client.send()
        if (replaceRequest || replaceSelection) await expect(result).rejects.toThrow()
        else expect(await result).toEqual(packet)
        const [url, init] = send.mock.calls.at(-1)!
        expect(url).toBe('https://provider.example.test/api/overlay/v1/purchases/' + operation)
        expect(JSON.parse(init!.body as string)).toEqual(
          operation === 'prepare'
            ? f.request
            : operation === 'submit'
              ? f.candidate
              : { version: 1, acquisitionId: f.body.acquisitionId }
        )
        expect(new Headers(init!.headers).get('x-bsv-payment')).toBeNull()
      }
    )
  )
}, 90000)

it('binds all 32 identity bytes through 300 explicitly selected submit/recovery response histories', async () => {
  const fixtures = {
      submit: purchaseTransportFixture('submit'),
      recover: purchaseTransportFixture('recover')
    },
    send = jest.spyOn(AuthFetch.prototype, 'fetch')
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom('submit' as const, 'recover' as const),
      fc.uint8Array({ minLength: 32, maxLength: 32 }),
      fc.integer({ min: 0, max: 31 }),
      fc.boolean(),
      async (operation, bytes, position, changed) => {
        const f = fixtures[operation],
          commitment = Buffer.from(bytes).toString('hex'),
          altered = new Uint8Array(bytes)
        altered[position] ^= 1
        const observed = changed ? Buffer.from(altered).toString('hex') : commitment,
          packet = {
            result: {
              version: 1,
              acquisitionId: f.body.acquisitionId,
              status: 'admission-pending',
              txid: 'cd'.repeat(32),
              purchaseCommitment: observed,
              recoveryUntil: f.body.recoveryUntil
            }
          },
          client = new OutputPurchaseTransport({
            ...f.options,
            commitmentBinding: {
              profile: 'full-purchase-commitment-v1',
              domainProfile: f.body.domainProfile,
              purchaseCommitment: commitment
            }
          })
        send.mockImplementation(async () => f.response(packet))
        if (changed) await expect(client.send()).rejects.toThrow('commitment mismatch')
        else expect(await client.send()).toEqual(packet)
        const [url, init] = send.mock.calls.at(-1)!
        expect(url).toBe('https://provider.example.test/api/overlay/v1/purchases/' + operation)
        expect(JSON.parse(init!.body as string)).toEqual(
          operation === 'submit' ? f.candidate : { version: 1, acquisitionId: f.body.acquisitionId }
        )
        expect(new Headers(init!.headers).get('x-bsv-payment')).toBeNull()
      }
    )
  )
}, 90000)
