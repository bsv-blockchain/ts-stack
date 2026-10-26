import { expect, it } from '@jest/globals'
import {
  LCH_MECHANISMS,
  encodeDeterministicCbor,
  decodeDeterministicCbor,
  sha256,
  signObject,
  type LCHValue
} from '../src/index.js'
import { validateLCHOverlayAcceptedPolicy } from '../src/overlayAcquisitionConsent.js'
import { lchOverlayFixture } from './overlay-acquisition.fixture.js'

it('requires complete human-term consent and preserves its independently pinned bytes', async () => {
  const f = await lchOverlayFixture(),
    human = await Promise.all(
      ['first', 'second'].map(async text => {
        const inline = new TextEncoder().encode(text)
        return { mediaType: 'text/plain', inline, digest: await sha256(inline) }
      })
    ),
    offer = await signObject('offer', { ...f.offer.body, humanTerms: human }, f.seller)
  async function accepted(digests: LCHValue) {
    const request = await signObject(
      'license-request',
      { ...f.request.body, acceptedHumanTermDigests: digests },
      f.buyer
    )
    return validateLCHOverlayAcceptedPolicy(
      offer,
      request,
      encodeDeterministicCbor(request as unknown as LCHValue)
    )
  }
  await expect(accepted(human.map(value => value.digest).reverse())).resolves.toMatchObject({
    digest: f.request.body.acceptedPolicyDigest
  })
  await expect(accepted([])).rejects.toThrow('Human terms consent differs')
  await expect(accepted([human[0].digest, new Uint8Array(32)])).rejects.toThrow(
    'human term was not accepted'
  )
  await expect(accepted('not an array')).rejects.toThrow('Human terms consent differs')
})

it('limits selection and mechanism consent to the exact original Offer', async () => {
  const f = await lchOverlayFixture(),
    payment = f.offer.body.payment as Record<string, LCHValue>,
    keyDelivery = f.offer.body.keyDelivery as Record<string, LCHValue>,
    enforcement = f.offer.body.enforcement as Record<string, LCHValue>,
    choices = {
      usageProfile: f.offer.body.usageProfile,
      payment: payment.protocol,
      keyDelivery: keyDelivery.mechanism,
      encryption: LCH_MECHANISMS.encryption,
      enforcement: enforcement.class
    }
  async function accepted(changes: Record<string, LCHValue>) {
    const request = await signObject('license-request', { ...f.request.body, ...changes }, f.buyer)
    return validateLCHOverlayAcceptedPolicy(
      f.offer,
      request,
      encodeDeterministicCbor(request as unknown as LCHValue)
    )
  }
  await expect(accepted({ mechanismChoices: choices })).resolves.toBeDefined()
  for (const mechanismChoices of [{ ...choices, payment: 'urn:other' }, { unknown: 'urn:other' }])
    await expect(accepted({ mechanismChoices })).rejects.toThrow('mechanism choices differ')
  for (const selection of [
    { type: 'all', hidden: true },
    { type: 'segments', indices: [0] }
  ])
    await expect(accepted({ selection })).rejects.toThrow('whole-Asset Selection')
  await expect(accepted({ acceptedPolicyDigest: new Uint8Array(32) })).rejects.toThrow(
    'Accepted Policy differs'
  )
})

it('retains owned consent during asynchronous digest checks and refuses different encoded bytes', async () => {
  const f = await lchOverlayFixture(),
    offer = decodeDeterministicCbor(
      encodeDeterministicCbor(f.offer as unknown as LCHValue)
    ) as typeof f.offer,
    request = decodeDeterministicCbor(
      encodeDeterministicCbor(f.request as unknown as LCHValue)
    ) as typeof f.request,
    bytes = f.requestBytes.slice(),
    pending = validateLCHOverlayAcceptedPolicy(offer, request, bytes)
  request.body.acceptedPolicyDigest = new Uint8Array(32)
  offer.body.policy = {
    mediaType: 'text/plain',
    digest: new Uint8Array(32),
    inline: Uint8Array.of(1)
  }
  bytes.fill(0)
  await expect(pending).resolves.toMatchObject({ digest: f.request.body.acceptedPolicyDigest })
  await expect(
    validateLCHOverlayAcceptedPolicy(f.offer, f.request, Uint8Array.of(0))
  ).rejects.toThrow('byte-stable deterministic CBOR')
})
