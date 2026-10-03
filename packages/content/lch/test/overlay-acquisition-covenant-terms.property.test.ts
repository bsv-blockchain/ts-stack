import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { PrivateKey, ProtoWallet, outputPacketDigest, signOutputPacket } from '@bsv/sdk'
import { WalletBRC77Signer } from '../src/index.js'
import {
  validateLCHOverlayCovenantTerms,
  validateLCHOverlayCovenantPromise,
  validateLCHOverlayCovenantWindow
} from '../src/overlayAcquisitionCovenantTerms.js'
import { lchCovenantFixture } from './overlay-acquisition-covenant.fixture.js'

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

it('late binds independent buyers while retaining exact standing rights and refusing shortened recovery', async () => {
  const f = await lchCovenantFixture(),
    offerId = f.descriptor.termsDigest
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 90, max: 1000 }),
      fc.integer({ min: 21, max: 99 }),
      async (key, cutoff) => {
        const buyer = await WalletBRC77Signer.create({
            wallet: new ProtoWallet(new PrivateKey(key))
          }),
          original = await f.requestFor(buyer),
          terms = await validateLCHOverlayCovenantTerms({
            ...f.input,
            request: original.requestBytes,
            prepare: original.prepare
          }),
          prepare = original.prepare,
          body = {
            ...f.signedTerms().body,
            acquisitionId: outputPacketDigest('purchase', {
              chain: prepare.listing.chain,
              seller: f.descriptor.seller,
              recipient: prepare.recipient,
              topic: prepare.topic,
              requestId: prepare.requestId
            }),
            requestDigest: outputPacketDigest('purchase-request', prepare),
            recipient: prepare.recipient,
            purchaseUntil: String(cutoff),
            recoveryUntil: String(cutoff + 172800)
          },
          packet = signOutputPacket('purchase-terms', body, f.sellerKey)
        expect(terms.prepare.termsDigest).toBe(offerId)
        expect(terms.policy.buyer).toBe(prepare.recipient)
        expect(terms.descriptor.initialRevenue).toEqual(f.initialRevenue)
        expect(validateLCHOverlayCovenantPromise(terms, packet)).toEqual(packet)
        expect(() => validateLCHOverlayCovenantWindow(terms, packet, '20')).not.toThrow()
        expect(() => validateLCHOverlayCovenantWindow(terms, packet, String(cutoff))).toThrow(
          'Purchase window expired'
        )
        const short = signOutputPacket(
          'purchase-terms',
          { ...body, recoveryUntil: String(cutoff + 86400) },
          f.sellerKey
        )
        expect(() => validateLCHOverlayCovenantPromise(terms, short)).toThrow('promise differs')
        await expect(
          validateLCHOverlayCovenantTerms({
            ...f.input,
            request: original.requestBytes,
            prepare: { ...prepare, recipient: f.prepare.recipient }
          })
        ).rejects.toThrow('signed LCH consent')
        expect(f.descriptor.termsDigest).toBe(offerId)
      }
    )
  )
}, 180000)
