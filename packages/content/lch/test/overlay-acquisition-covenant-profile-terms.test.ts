import { expect, it } from '@jest/globals'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import { WalletBRC77Signer } from '../src/signatures.js'
import { signObject } from '../src/objects.js'
import { objectId, toHex } from '../src/hash.js'
import { LCH_OVERLAY_PROFILES } from '../src/overlayAcquisitionCodec.js'
import { validateLCHCollectorPreparation } from '../src/overlayAcquisitionCollectorProfile.js'
import {
  validateLCHOverlayCovenantProfileTerms,
  validateLCHOverlayCovenantProfilePromise,
  validateLCHOverlayCovenantProfileWindow
} from '../src/overlayAcquisitionCovenantProfileTerms.js'
import { validateLCHOverlayCovenantTerms } from '../src/overlayAcquisitionCovenantTerms.js'
import type { LCHValue } from '../src/types.js'
import { lchCovenantProfileFixture } from './overlay-acquisition-covenant-profile.fixture.js'
import { lchCovenantFixture } from './overlay-acquisition-covenant.fixture.js'

type Fixture = Awaited<ReturnType<typeof lchCovenantProfileFixture>>
async function sequence<T>(
  values: readonly T[],
  check: (value: T) => Promise<void>
): Promise<void> {
  await values.reduce(async (previous, value) => {
    await previous
    await check(value)
  }, Promise.resolve())
}
async function forCollector(f: Fixture, changes: Record<string, LCHValue>) {
  const extensions = f.offer.body.extensions as Record<string, LCHValue>,
    collector = extensions[LCH_OVERLAY_PROFILES.collectorSettlement] as Record<string, LCHValue>,
    offer = await signObject(
      'offer',
      {
        ...f.offer.body,
        extensions: {
          ...extensions,
          [LCH_OVERLAY_PROFILES.collectorSettlement]: { ...collector, ...changes }
        }
      },
      f.seller
    ),
    original = await f.requestFor(f.buyer, offer)
  return {
    ...f.input,
    offer,
    request: original.requestBytes,
    prepare: original.prepare,
    descriptor: { ...f.descriptor, termsDigest: toHex(await objectId('offer', offer.body)) }
  }
}

it('authenticates current immutable collector terms and individual consent against one standing Offer', async () => {
  const f = await lchCovenantProfileFixture(),
    terms = await validateLCHOverlayCovenantProfileTerms(f.input),
    buyer = await WalletBRC77Signer.create({ wallet: new ProtoWallet(new PrivateKey(86)) }),
    original = await f.requestFor(buyer),
    next = await validateLCHOverlayCovenantProfileTerms({
      ...f.input,
      request: original.requestBytes,
      prepare: original.prepare
    })
  expect(terms.descriptor).toEqual(f.descriptor)
  expect(next.descriptor).toEqual(terms.descriptor)
  expect(next.policy.buyer).not.toBe(terms.policy.buyer)
  expect(next.prepare.termsDigest).toBe(terms.prepare.termsDigest)
  expect(terms.policy.satoshis).toBe(100n)
  expect(terms.descriptor.initialRevenue).toEqual(f.initialRevenue)
  expect(terms.descriptor).not.toHaveProperty('administration')
  f.descriptor.initialRevenue.recipients[0].weight++
  expect(terms.descriptor.initialRevenue).not.toEqual(f.descriptor.initialRevenue)
})

it('keeps historical and current descriptor and collector contracts explicitly separate', async () => {
  const current = await lchCovenantProfileFixture(),
    historical = await lchCovenantFixture()
  await expect(validateLCHOverlayCovenantTerms(historical.input)).resolves.toBeDefined()
  await expect(validateLCHOverlayCovenantTerms(current.input as never)).rejects.toThrow()
  await expect(validateLCHOverlayCovenantProfileTerms(historical.input as never)).rejects.toThrow()
  const variants: Record<string, LCHValue>[] = [
    { amendment: 'unanimous-current-recipients' },
    { schedule: 'mutable' },
    { derivation: 'random' },
    { withdrawal: 'seller-only' },
    { retirement: 'externally-funded-exact-top-up' },
    { familyIRI: current.descriptor.scriptFamily },
    { version: 2 }
  ]
  await sequence(variants, async changes => {
    await expect(
      validateLCHOverlayCovenantProfileTerms(await forCollector(current, changes))
    ).rejects.toThrow()
  })
})

it('binds every immutable recipient and expiry to the full descriptor before accepting consent', async () => {
  const f = await lchCovenantProfileFixture()
  const descriptors = [
    { ...f.descriptor, expiryHeight: f.descriptor.expiryHeight + 1 },
    {
      ...f.descriptor,
      initialRevenue: {
        recipients: f.initialRevenue.recipients.map((value, index) => ({
          ...value,
          weight: value.weight + Number(index === f.initialRevenue.recipients.length - 1)
        }))
      }
    },
    { ...f.descriptor, seller: f.prepare.recipient },
    { ...f.descriptor, assetId: '00'.repeat(32) },
    { ...f.descriptor, purchasePrice: '101' },
    { ...f.descriptor, termsDigest: '00'.repeat(32) },
    { ...f.descriptor, lineageAnchor: { ...f.descriptor.lineageAnchor, txid: '44'.repeat(32) } }
  ]
  await sequence(descriptors, async descriptor => {
    await expect(
      validateLCHOverlayCovenantProfileTerms({ ...f.input, descriptor })
    ).rejects.toThrow('listing descriptor or initial revenue')
  })
  await sequence(['assetId', 'termsDigest', 'requestId', 'topic'] as const, async field => {
    await expect(
      validateLCHOverlayCovenantProfileTerms({
        ...f.input,
        prepare: { ...f.prepare, [field]: field === 'topic' ? 'other' : '00'.repeat(32) }
      })
    ).rejects.toThrow()
  })
  await expect(
    validateLCHOverlayCovenantProfileTerms({ ...f.input, installedMechanisms: new Set() })
  ).rejects.toThrow('not installed and advertised')
})

it('keeps new-preparation height and time checks separate from an accepted historical promise', async () => {
  const f = await lchCovenantProfileFixture(),
    terms = await validateLCHOverlayCovenantProfileTerms(f.input),
    promise = f.signedTerms()
  expect(() => validateLCHCollectorPreparation(terms.descriptor, 'active', '999')).not.toThrow()
  expect(() => validateLCHCollectorPreparation(terms.descriptor, 'active', '1000')).toThrow()
  expect(() => validateLCHCollectorPreparation(terms.descriptor, 'activation', '999')).toThrow()
  expect(() => validateLCHOverlayCovenantProfileWindow(terms, promise, '20')).not.toThrow()
  expect(() => validateLCHOverlayCovenantProfileWindow(terms, null, '100')).toThrow()
  expect(validateLCHOverlayCovenantProfilePromise(terms, promise)).toEqual(promise)
  for (const changes of [
    { purchaseUntil: '101', recoveryUntil: '172901' },
    { recoveryUntil: '172899' },
    { domainProfile: 'urn:other' },
    { releasePolicy: { kind: 'mined' as const, confirmations: 1 } }
  ])
    expect(() => validateLCHOverlayCovenantProfilePromise(terms, f.signedTerms(changes))).toThrow()
})
