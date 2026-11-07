import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { outputPacketDigest, PrivateKey, signOutputPacket, Utils } from '@bsv/sdk'
import { RevenueListingPurchaseVerifier } from '../src/revenue-listing/RevenueListingPurchaseVerifier.js'
import { context, family } from './revenue-lineage-fixture.js'
import { purchaseFixture } from './revenue-purchase.fixture.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  seed: Number.isSafeInteger(requestedSeed) ? requestedSeed : 3242026,
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

it('refuses 300 different valid preparations whose receipt does not belong to the original funded purchase', async () => {
  const f = await purchaseFixture()
  let calls = 0
  const verifier = new RevenueListingPurchaseVerifier(family, {
    async resolve() {
      calls++
      throw new Error('Association failure must precede chain I/O')
    }
  })
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 0, max: 2 }),
      fc.uint8Array({ minLength: 1, maxLength: 32 }),
      async (kind, bytes) => {
        const original = structuredClone(f.original)
        if (kind === 0) original.request.requestId = 'generated-' + Utils.toHex(bytes)
        if (kind === 1) original.request.request = Utils.toBase64([255, ...bytes])
        if (kind === 2)
          original.request.recipient = new PrivateKey(45 + (bytes[0] % 16)).toPublicKey().toString()
        const body = { ...original.terms.body, recipient: original.request.recipient }
        body.acquisitionId = outputPacketDigest('purchase', {
          chain: original.request.listing.chain,
          seller: original.seller,
          recipient: original.request.recipient,
          topic: original.request.topic,
          requestId: original.request.requestId
        })
        body.requestDigest = outputPacketDigest('purchase-request', original.request)
        original.terms = signOutputPacket('purchase-terms', body, new PrivateKey(41))
        expect((await verifier.verify(f.purchase, original, context())).status).toBe('invalid')
      }
    )
  )
  expect(calls).toBe(0)
}, 60000)
