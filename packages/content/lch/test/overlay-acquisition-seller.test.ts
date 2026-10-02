import { expect, it } from '@jest/globals'
import { retainOutputCapability, Utils, canonicalOutputJSON } from '@bsv/sdk'
import { LCHOverlayPaidSeller } from '../src/overlayAcquisitionSeller.js'
import { LCH_OVERLAY_PROFILES } from '../src/overlayAcquisitionCodec.js'
import { lchPaidFixture } from './overlay-acquisition-paid.fixture.js'
import { SDKPrivateAcquisitionFunding } from '../../../application/output-knowledge/src/private/SDKPrivateAcquisitionFunding.js'
import { context, resolver } from '../../../application/output-knowledge/test/evidence-fixture.js'

async function fixture(reverseClockAfterAssessment = false) {
  const f = await lchPaidFixture(),
    signal = new AbortController().signal,
    fundingVerifier = new SDKPrivateAcquisitionFunding(resolver, f.sellerWallet, () => context()),
    funding = await fundingVerifier.verify(f.payment, f.challenge, f.acquire.listing.chain, signal),
    capability = retainOutputCapability(f.selection.manifest, {
      identity: f.body.identity,
      baseURL: f.body.baseURL,
      chain: f.acquire.listing.chain,
      kind: 'lookup',
      service: f.acquire.service,
      profile: f.selection.profile.id,
      maximumAgeSeconds: '100',
      clockSkewSeconds: '0',
      now: '20',
      rules: new Map([[f.selection.service.rules.id, () => {}]])
    }).record
  let catalogue = true,
    credit = true,
    credits = 0
  const seller = new LCHOverlayPaidSeller({
    id: 'urn:reference:lch-paid-seller:1',
    catalogue: {
      load: () => {
        if (!catalogue) return Promise.reject(new Error('Catalogue withdrawn'))
        return Promise.resolve({
          header: f.input.header,
          offer: f.offer,
          evidence: f.delivered.result!.evidence,
          verificationContext: context(),
          keys: [...f.asset.keys].map(([id, cek]) => ({
            keyId: Uint8Array.from(Utils.toArray(id, 'hex')),
            cek
          }))
        })
      }
    },
    source: f.storage,
    sellerSigner: f.seller,
    issuerSigner: f.seller,
    issuerWallet: f.sellerWallet,
    verification: {
      ...f.options.verification,
      funding: (...args) => fundingVerifier.verify(...args),
      async release(...args) {
        const assessment = await f.options.verification.release(...args)
        if (reverseClockAfterAssessment) {
          reverseClockAfterAssessment = false
          f.setNow('19')
        }
        return assessment
      }
    },
    credited: operation => {
      credits++
      if (!credit || canonicalOutputJSON(operation) !== canonicalOutputJSON(funding.operation))
        return Promise.reject(new Error('Native credit unresolved'))
      return Promise.resolve()
    },
    authorityNetwork: 'testnet',
    maximumCiphertextBytes: 1048576,
    quoteSeconds: '80',
    derivationPrefix: () => Utils.toBase64(new Uint8Array(32).fill(1)),
    clock: f.options.clock,
    current: f.options.current
  })
  const preparation = await seller.prepare(f.acquire, f.selection, signal),
    original = {
      request: f.acquire,
      challenge: f.challenge,
      capability,
      evidence: f.delivered.result!.evidence,
      schema: LCH_OVERLAY_PROFILES.acquisition
    },
    progress = {
      challenge: f.challenge,
      phase: 'delivery-pending',
      candidate: { payment: f.payment, verdict: 'accepted' },
      funding: { operation: funding.operation, acceptance: f.acceptance },
      walletReceipt: { operationId: funding.operation.id },
      delivery: { preparedAt: '20' },
      recoveryUntil: f.challenge.recoveryUntil
    }
  return {
    ...f,
    sellerDomain: seller,
    preparation,
    original,
    progress,
    signal,
    setCatalogue: (value: boolean) => {
      catalogue = value
    },
    setCredit: (value: boolean) => {
      credit = value
    },
    credits: () => credits
  }
}
it('issues a real signed settlement and recipient-bound License from exact accepted material, with independently authenticated buyer playback', async () => {
  const f = await fixture()
  await f.sellerDomain.validate(f.acquire, f.preparation, f.signal)
  expect(f.preparation.maximumContextBytes).toBeLessThanOrEqual(2097152)
  expect(f.credits()).toBe(0)
  const context = await f.sellerDomain.issue(
      f.original,
      f.progress,
      f.preparation.material,
      f.signal
    ),
    delivered = { ...f.delivered, result: { ...f.delivered.result!, context } }
  expect(f.credits()).toBe(1)
  await f.domain.verify(f.acquire, f.challenge, f.payment, delivered, f.signal)
  expect(await f.domain.playback(delivered, f.signal)).toEqual(f.plaintext)
  for (const cek of f.asset.keys.values())
    expect(Utils.toHex(Utils.toArray(context, 'base64'))).not.toContain(Utils.toHex(cek))
})
it('uses retained rights after catalogue withdrawal and Offer expiry without repricing or another charge', async () => {
  const f = await fixture()
  f.setCatalogue(false)
  f.setNow('200')
  await expect(f.sellerDomain.prepare(f.acquire, f.selection, f.signal)).rejects.toThrow(
    'withdrawn'
  )
  const context = await f.sellerDomain.issue(
      f.original,
      f.progress,
      f.preparation.material,
      f.signal
    ),
    delivered = { ...f.delivered, result: { ...f.delivered.result!, context } }
  await f.domain.verify(f.acquire, f.challenge, f.payment, delivered, f.signal)
  expect(await f.domain.playback(delivered, f.signal)).toEqual(f.plaintext)
  expect(f.credits()).toBe(1)
})
it('cannot issue from missing credit, substituted retained request or a different original challenge', async () => {
  const f = await fixture()
  f.setCredit(false)
  await expect(
    f.sellerDomain.issue(f.original, f.progress, f.preparation.material, f.signal)
  ).rejects.toThrow('Native credit unresolved')
  for (const progress of [
    { ...f.progress, walletReceipt: null },
    { ...f.progress, challenge: { ...f.challenge, satoshis: '101' } }
  ])
    await expect(
      f.sellerDomain.issue(f.original, progress, f.preparation.material, f.signal)
    ).rejects.toThrow('exact retained')
  await expect(
    f.sellerDomain.issue(
      { ...f.original, request: { ...f.acquire, assetId: 'ff'.repeat(32) } },
      f.progress,
      f.preparation.material,
      f.signal
    )
  ).rejects.toThrow('exact retained')
  expect(f.credits()).toBe(1)
})
it('keeps the obligation unresolved when issuance would precede its actual acceptance', async () => {
  const f = await fixture(true)
  await expect(
    f.sellerDomain.issue(f.original, f.progress, f.preparation.material, f.signal)
  ).rejects.toThrow('chronology')
  f.setNow('20')
  await expect(
    f.sellerDomain.issue(f.original, f.progress, f.preparation.material, f.signal)
  ).resolves.toEqual(expect.any(String))
})
