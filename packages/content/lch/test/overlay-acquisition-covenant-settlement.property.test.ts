import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { signOutputPacket } from '@bsv/sdk'
import { bindLCHOverlayCovenantSettlement } from '../src/overlayAcquisitionCovenantSettlement.js'
import { lchCovenantSettlementFixture } from './overlay-acquisition-covenant-settlement.fixture.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number(process.env.FAST_CHECK_NUM_RUNS),
  requestedSeed = Number(process.env.FAST_CHECK_SEED),
  replayPath = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  seed: Number.isSafeInteger(requestedSeed) ? requestedSeed : 3242026,
  ...(replayPath ? { path: replayPath } : {}),
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true
})

it('refuses independently signed wrong economic and request commitments under genuine POTATOES', async () => {
  const f = await lchCovenantSettlementFixture()
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom(
        'requestId',
        'offerId',
        'assetId',
        'acquisitionId',
        'listingId',
        'txid',
        'releaseEvidenceDigest'
      ),
      fc.uint8Array({ minLength: 32, maxLength: 32 }),
      fc.integer({ min: 1, max: 10000 }),
      async (field, bytes, extra) => {
        const incorrect = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(''),
          packet = signOutputPacket(
            'lch-covenant-settlement',
            { ...f.body, [field]: incorrect, satoshis: String(100 + extra) },
            f.sellerKey
          ),
          context = { ...f.context, settlement: f.json(packet) },
          delivered = await f.deliver(context)
        expect(() =>
          bindLCHOverlayCovenantSettlement(context, f.terms, f.prepared, delivered, f.txid)
        ).toThrow('exact prepared purchase')
        expect(
          bindLCHOverlayCovenantSettlement(f.context, f.terms, f.prepared, f.delivered, f.txid)
            .packet
        ).toEqual(f.packet)
      }
    )
  )
}, 180000)
