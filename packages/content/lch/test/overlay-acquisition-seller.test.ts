import { expect, it } from '@jest/globals'
import { retainOutputCapability, Utils, canonicalOutputJSON } from '@bsv/sdk'
import { LCHOverlayPaidSeller } from '../src/overlayAcquisitionSeller.js'
import { LCH_OVERLAY_PROFILES } from '../src/overlayAcquisitionCodec.js'
import { lchPaidFixture } from './overlay-acquisition-paid.fixture.js'
import { SDKPrivateAcquisitionFunding } from '../../../application/output-knowledge/src/private/SDKPrivateAcquisitionFunding.js'
import { context, resolver } from '../../../application/output-knowledge/test/evidence-fixture.js'

type SourceMode = 'stable' | 'missing' | 'tampered' | 'oversized' | 'access-lost' | 'cancelled'
async function fixture(options?: { reverseClockAfterAssessment?: boolean; detached?: boolean }) {
  let reverseClockAfterAssessment = options?.reverseClockAfterAssessment === true
  const f = await lchPaidFixture(undefined, undefined, options?.detached !== true),
    controller = new AbortController(),
    signal = controller.signal,
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
    credits = 0,
    sourceReads = 0,
    sourceMode: SourceMode = 'stable'
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
    source: {
      async read(...args) {
        sourceReads++
        if (sourceMode === 'missing') throw new Error('Detached ciphertext unavailable')
        const bytes = await f.storage.read(...args)
        if (sourceMode === 'tampered') bytes[0] ^= 1
        if (sourceMode === 'oversized') return new Uint8Array(1048577)
        if (sourceMode === 'access-lost') f.setAccess(false)
        if (sourceMode === 'cancelled') controller.abort()
        return bytes
      }
    },
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
    credits: () => credits,
    sourceReads: () => sourceReads,
    setSourceMode: (value: SourceMode) => {
      sourceMode = value
    }
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
  const f = await fixture({ reverseClockAfterAssessment: true })
  await expect(
    f.sellerDomain.issue(f.original, f.progress, f.preparation.material, f.signal)
  ).rejects.toThrow('chronology')
  f.setNow('20')
  await expect(
    f.sellerDomain.issue(f.original, f.progress, f.preparation.material, f.signal)
  ).resolves.toEqual(expect.any(String))
})

it('validates a detached representation through the bounded source before quoting and issuing, then plays authenticated plaintext', async () => {
  const f = await fixture({ detached: true })
  expect(f.sourceReads()).toBe(1)
  await f.sellerDomain.validate(f.acquire, f.preparation, f.signal)
  const context = await f.sellerDomain.issue(
      f.original,
      f.progress,
      f.preparation.material,
      f.signal
    ),
    delivered = { ...f.delivered, result: { ...f.delivered.result!, context } }
  expect(f.sourceReads()).toBe(3)
  await f.domain.verify(f.acquire, f.challenge, f.payment, delivered, f.signal)
  expect(await f.domain.playback(delivered, f.signal)).toEqual(f.plaintext)
  expect(f.credits()).toBe(1)
})
it.each([
  ['missing', 'Detached ciphertext unavailable'],
  ['tampered', 'Ciphertext digest mismatch'],
  ['oversized', 'Seller ciphertext source exceeded bound'],
  ['access-lost', 'Seller installation cancelled, changed or inaccessible'],
  ['cancelled', 'Seller installation cancelled, changed or inaccessible']
] as const)('refuses detached %s content before a new quote or credit', async (mode, message) => {
  const f = await fixture({ detached: true })
  f.setSourceMode(mode)
  await expect(f.sellerDomain.prepare(f.acquire, f.selection, f.signal)).rejects.toMatchObject({
    message: 'No valid ciphertext source was available',
    cause: expect.objectContaining({ message })
  })
  expect(f.credits()).toBe(0)
})
