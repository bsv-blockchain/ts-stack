import { expect, it } from '@jest/globals'
import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk'
import {
  WalletBRC77Signer,
  encodeDeterministicCbor,
  objectId,
  sha256,
  signObject,
  toHex,
  type LCHValue,
  type SignedObject
} from '../src/index.js'
import { LCH_OVERLAY_PROFILES } from '../src/overlayAcquisitionCodec.js'
import {
  validateLCHOverlayCovenantTerms,
  validateLCHOverlayCovenantPromise,
  validateLCHOverlayCovenantWindow
} from '../src/overlayAcquisitionCovenantTerms.js'
import { createLCHOverlayFixedRenderAgreement } from '../src/overlayAcquisitionPolicy.js'
import { validateLCHOverlayPaidTerms } from '../src/overlayAcquisitionTerms.js'
import { lchCovenantFixture } from './overlay-acquisition-covenant.fixture.js'

type Fixture = Awaited<ReturnType<typeof lchCovenantFixture>>
async function forOffer(f: Fixture, changes: Record<string, LCHValue>) {
  const offer = await signObject('offer', { ...f.offer.body, ...changes }, f.seller),
    original = await f.requestFor(f.buyer, offer)
  return {
    ...f.input,
    offer,
    request: original.requestBytes,
    prepare: original.prepare,
    descriptor: { ...f.descriptor, termsDigest: toHex(await objectId('offer', offer.body)) }
  }
}
function payment(f: Fixture) {
  return f.offer.body.payment as Record<string, LCHValue>
}
function extensions(f: Fixture) {
  return f.offer.body.extensions as Record<string, LCHValue>
}

it('keeps one standing Offer and descriptor while two buyers consent to individual rights', async () => {
  const f = await lchCovenantFixture(),
    originalOffer = encodeDeterministicCbor(f.offer as unknown as LCHValue),
    first = await validateLCHOverlayCovenantTerms(f.input),
    buyer = await WalletBRC77Signer.create({ wallet: new ProtoWallet(new PrivateKey(85)) }),
    secondRequest = await f.requestFor(buyer),
    second = await validateLCHOverlayCovenantTerms({
      ...f.input,
      request: secondRequest.requestBytes,
      prepare: secondRequest.prepare
    })
  expect(first.prepare.termsDigest).toBe(second.prepare.termsDigest)
  expect(first.descriptor).toEqual(second.descriptor)
  expect(first.requestBytes).not.toEqual(second.requestBytes)
  expect(first.policy.buyer).not.toBe(second.policy.buyer)
  expect(first.policy.satoshis).toBe(100n)
  expect(first.recoverySeconds).toBe(172800n)
  expect(first.descriptor.initialRevenue).toEqual(f.initialRevenue)
  for (const terms of [first, second]) {
    const agreement = await createLCHOverlayFixedRenderAgreement(terms.policy),
      body = JSON.parse(new TextDecoder().decode(agreement.inline as Uint8Array))
    expect(body.assignee).toBe('lch:identity:secp256k1:' + terms.prepare.recipient)
    expect(body.permission[0].duty).toBeUndefined()
    expect(body.prohibition).toHaveLength(1)
  }
  expect(encodeDeterministicCbor(f.offer as unknown as LCHValue)).toEqual(originalOffer)
})

it('forbids buyer fields, preselected policy assignees and paid settlement semantics', async () => {
  const f = await lchCovenantFixture(),
    pay = payment(f),
    pricing = pay.pricing as Record<string, LCHValue>,
    requirement = (pricing.requirements as Record<string, LCHValue>[])[0]
  await expect(
    validateLCHOverlayCovenantTerms(
      await forOffer(f, {
        payment: {
          ...pay,
          pricing: { ...pricing, requirements: [{ ...requirement, buyer: f.buyer.identityKey }] }
        }
      })
    )
  ).rejects.toThrow('unsupported covenant terms')
  const policyBytes = new TextEncoder().encode(
    JSON.stringify({ ...f.policy, assignee: 'lch:identity:secp256k1:' + f.prepare.recipient })
  )
  await expect(
    validateLCHOverlayCovenantTerms(
      await forOffer(f, {
        policy: {
          mediaType: 'application/ld+json',
          inline: policyBytes,
          digest: await sha256(policyBytes)
        }
      })
    )
  ).rejects.toThrow('assignee open')
  await expect(
    validateLCHOverlayCovenantTerms(
      await forOffer(f, {
        extensions: { ...extensions(f), [LCH_OVERLAY_PROFILES.paidSettlement]: { version: 1 } }
      })
    )
  ).rejects.toThrow('critical semantics')
  // An existing paid adapter cannot silently treat a standing requirement as
  // its buyer-bearing BRC105 payment, even though all signatures are real.
  await expect(
    validateLCHOverlayPaidTerms({
      ...f.input,
      acquire: {
        ...f.prepare,
        service: f.prepare.topic
      }
    } as never)
  ).rejects.toThrow('Paid lookup binding')
})

it('requires all three critical modes, the exact C economics and a supported fixed requirement', async () => {
  const f = await lchCovenantFixture(),
    critical = f.offer.body.critical as string[]
  for (const missing of critical)
    await expect(
      validateLCHOverlayCovenantTerms(
        await forOffer(f, { critical: critical.filter(name => name !== missing) })
      )
    ).rejects.toThrow('critical semantics')
  const collector = extensions(f)[LCH_OVERLAY_PROFILES.collectorSettlement] as Record<
    string,
    LCHValue
  >
  for (const [key, value] of Object.entries({
    amendment: 'seller-only',
    remainders: 'round',
    retirement: 'discard',
    family: 'urn:other',
    version: 2
  }))
    await expect(
      validateLCHOverlayCovenantTerms(
        await forOffer(f, {
          extensions: {
            ...extensions(f),
            [LCH_OVERLAY_PROFILES.collectorSettlement]: { ...collector, [key]: value }
          }
        })
      )
    ).rejects.toThrow('collector revenue rules')
  const pay = payment(f),
    pricing = pay.pricing as Record<string, LCHValue>,
    requirement = (pricing.requirements as LCHValue[])[0]
  for (const requirements of [[], [requirement, requirement]])
    await expect(
      validateLCHOverlayCovenantTerms(
        await forOffer(f, { payment: { ...pay, pricing: { ...pricing, requirements } } })
      )
    ).rejects.toThrow()
  for (const changes of [
    { protocol: 'urn:other' },
    { endpoint: f.body.baseURL + '/wrong' },
    { pricing: { kind: 'unit', requirements: [requirement] } }
  ])
    await expect(
      validateLCHOverlayCovenantTerms(await forOffer(f, { payment: { ...pay, ...changes } }))
    ).rejects.toThrow()
})

it('binds authority-neutral terms to the complete descriptor, anchor and initial schedule', async () => {
  const f = await lchCovenantFixture()
  for (const descriptor of [
    { ...f.descriptor, administration: 'none' },
    { ...f.descriptor, purchasePrice: '101' },
    { ...f.descriptor, seller: f.prepare.recipient },
    { ...f.descriptor, assetId: '00'.repeat(32) },
    { ...f.descriptor, termsDigest: '00'.repeat(32) },
    { ...f.descriptor, lineageAnchor: { ...f.descriptor.lineageAnchor, txid: '44'.repeat(32) } },
    {
      ...f.descriptor,
      initialRevenue: {
        ...f.initialRevenue,
        recipients: [{ identity: f.descriptor.seller, weight: 3 }]
      }
    }
  ])
    await expect(
      validateLCHOverlayCovenantTerms({ ...f.input, descriptor } as never)
    ).rejects.toThrow('listing descriptor or initial revenue')
})

it('checks the selected capability mechanisms and exact consent before content resolution', async () => {
  const f = await lchCovenantFixture()
  await expect(
    validateLCHOverlayCovenantTerms({ ...f.input, installedMechanisms: new Set() })
  ).rejects.toThrow('not installed and advertised')
  for (const field of ['assetId', 'termsDigest', 'recipient', 'requestId', 'topic'] as const)
    await expect(
      validateLCHOverlayCovenantTerms({
        ...f.input,
        prepare: { ...f.prepare, [field]: field === 'topic' ? 'other' : '00'.repeat(32) }
      })
    ).rejects.toThrow()
  const wrong: SignedObject = await signObject(
      'license-request',
      { ...f.request.body, acceptedPolicyDigest: new Uint8Array(32) },
      f.buyer
    ),
    requestBytes = encodeDeterministicCbor(wrong as unknown as LCHValue)
  await expect(
    validateLCHOverlayCovenantTerms({
      ...f.input,
      request: requestBytes,
      prepare: {
        ...f.prepare,
        request: Utils.toBase64(requestBytes),
        requestId: toHex(await objectId('license-request', wrong.body))
      }
    })
  ).rejects.toThrow('Accepted Policy differs')
  await expect(
    validateLCHOverlayCovenantTerms({ ...f.input, maximumCiphertextBytes: 1 })
  ).rejects.toThrow('ciphertext')
})

it('preserves frozen original promises after expiry and never extends a new-work window', async () => {
  const f = await lchCovenantFixture(),
    terms = await validateLCHOverlayCovenantTerms(f.input),
    packet = f.signedTerms()
  expect(() => validateLCHOverlayCovenantWindow(terms, packet, '20')).not.toThrow()
  expect(() => validateLCHOverlayCovenantWindow(terms, null, '0')).toThrow('new-purchase window')
  expect(() => validateLCHOverlayCovenantWindow(terms, packet, '100')).toThrow(
    'new-purchase window'
  )
  expect(validateLCHOverlayCovenantPromise(terms, packet)).toEqual(packet)
  for (const changes of [
    { recoveryUntil: '172899' },
    { purchaseUntil: '101', recoveryUntil: '172901' },
    { purchaseUntil: '1', recoveryUntil: '172801' },
    { domainProfile: 'urn:other' },
    { domainEvidence: { schema: 'urn:other', bytes: 'e30=' } },
    { releasePolicy: { kind: 'mined', confirmations: 1 } }
  ])
    expect(() => validateLCHOverlayCovenantPromise(terms, f.signedTerms(changes as never))).toThrow(
      'promise differs'
    )
})
