import { expect, it } from '@jest/globals'
import {
  canonicalOutputJSON,
  decodeOutputBytes,
  OUTPUT_PROFILES,
  PrivateKey,
  ProtoWallet,
  selectOutputCapability,
  signOutputPacket,
  Utils
} from '@bsv/sdk'
import {
  decodeDeterministicCbor,
  encodeDeterministicCbor,
  signObject,
  WalletBRC77Signer,
  type LCHValue
} from '../src/index.js'
import { decodeUnverifiedLCHOverlayContext } from '../src/overlayAcquisitionCodec.js'
import { LCHOverlayCovenantSeller } from '../src/overlayAcquisitionCovenantSeller.js'
import { lchCovenantSellerFixture } from './overlay-acquisition-covenant-seller.fixture.js'

const signal = () => new AbortController().signal
const own = <T>(value: T): T => JSON.parse(canonicalOutputJSON(value, { bytes: 4194304 })) as T

it('prepares complete private keys and issues independently verified covenant rights usable by the actual buyer', async () => {
  const f = await lchCovenantSellerFixture(),
    custody = await f.prepareSeller(),
    abort = signal()
  expect(f.sellerCounts).toEqual({ load: 1, lineage: 1, purchase: 0, release: 0 })
  expect(custody.original.terms).toEqual(f.prepared)
  const material = decodeDeterministicCbor(
    Uint8Array.from(decodeOutputBytes(custody.material, 4194304))
  ) as Record<string, LCHValue>
  expect(material.keys).toHaveLength(f.asset.keys.size)
  expect(custody.maximumSecretBytes).toBeLessThanOrEqual(2097152)
  const guarded = await f.sellerDomain.verify(f.submission, custody, abort)
  guarded.checkCurrent()
  f.setNow('22')
  const secret = await f.sellerDomain.issue(custody, f.progress, f.release, abort, f.submission),
    delivered = await f.sellerDeliver(secret)
  expect(f.sellerCounts).toEqual({ load: 1, lineage: 1, purchase: 2, release: 1 })
  await f.domain.verify(f.prepare, custody.original.terms, f.submission, delivered, abort)
  expect(await f.domain.playback(delivered, abort)).toEqual(f.plaintext)
  expect(f.counts.purchase).toBe(1)
  expect(f.counts.release).toBe(2)
}, 60000)

it('completes the original obligation after catalogue withdrawal and Offer expiry without creating another request', async () => {
  const f = await lchCovenantSellerFixture(),
    custody = await f.prepareSeller(),
    abort = signal(),
    original = own(custody)
  f.setAvailable(false)
  f.setNow('200')
  expect(f.sellerDomain.isCurrent(custody.original)).toBe(true)
  const secret = await f.sellerDomain.issue(custody, f.progress, f.release, abort, f.submission),
    delivered = await f.sellerDeliver(secret)
  expect(custody).toEqual(original)
  expect(f.sellerCounts.load).toBe(1)
  await f.domain.verify(f.prepare, f.prepared, f.submission, delivered, abort)
  expect(await f.domain.playback(delivered, abort)).toEqual(f.plaintext)
  await expect(f.sellerDomain.prepare(f.prepare, f.selection, abort)).rejects.toThrow(
    'Catalogue unavailable'
  )
}, 60000)

it('refuses missing private readiness, wrong CEKs, issuer identity and unbounded delivery before preparation', async () => {
  const f = await lchCovenantSellerFixture(),
    abort = signal()
  f.setAvailable(false)
  await expect(f.prepareSeller()).rejects.toThrow('Catalogue unavailable')
  f.setAvailable(true)
  const original = f.listing.keys
  f.listing.keys = original.map((key, index) =>
    index === 0 ? { ...key, cek: Uint8Array.from(key.cek, v => v ^ 1) } : key
  )
  await expect(f.prepareSeller()).rejects.toThrow('CEK differs')
  f.listing.keys = original
  const wrong = new LCHOverlayCovenantSeller({ ...f.sellerOptions, issuerWallet: f.buyerWallet })
  await expect(wrong.prepare(f.prepare, f.selection, abort)).rejects.toThrow(
    'Issuer wallet differs'
  )
  const body = own(f.body)
  body.services[0].profiles[0].maxRequestBytes = 4194304
  const selection = selectOutputCapability(signOutputPacket('capabilities', body, f.sellerKey), {
    identity: body.identity,
    baseURL: body.baseURL,
    chain: f.prepare.listing.chain,
    kind: 'topic',
    service: f.prepare.topic,
    profile: OUTPUT_PROFILES.purchase,
    now: '20',
    maximumAgeSeconds: '100',
    clockSkewSeconds: '0',
    rules: new Map([[f.selection.service.rules.id, () => {}]])
  })
  await expect(f.sellerDomain.prepare(f.prepare, selection, abort)).rejects.toThrow(
    'cannot reserve complete covenant delivery'
  )
  expect(f.sellerCounts.purchase).toBe(0)
  expect(f.sellerCounts.release).toBe(0)
}, 60000)

it('refuses substituted original terms, protected material, purchase identity and incomplete admission', async () => {
  const f = await lchCovenantSellerFixture(),
    custody = await f.prepareSeller(),
    abort = signal()
  await expect(f.sellerDomain.issue(custody, f.progress, f.release, abort)).rejects.toThrow(
    'Complete retained candidate'
  )
  await expect(
    f.sellerDomain.verify({ ...f.submission, acquisitionId: 'ac'.repeat(32) }, custody, abort)
  ).rejects.toThrow('another original request')
  await expect(
    f.sellerDomain.verify(
      f.submission,
      { ...custody, maximumSecretBytes: custody.maximumSecretBytes + 1 },
      abort
    )
  ).rejects.toThrow('reservation differs')
  await expect(
    f.sellerDomain.verify(
      f.submission,
      {
        ...custody,
        original: { ...custody.original, request: { ...f.prepare, recipient: f.descriptor.seller } }
      },
      abort
    )
  ).rejects.toThrow('reservation differs')
  const original = decodeDeterministicCbor(
    Uint8Array.from(decodeOutputBytes(custody.material, 4194304))
  ) as Record<string, LCHValue>
  original.installation = 'different'
  await expect(
    f.sellerDomain.verify(
      f.submission,
      { ...custody, material: Utils.toBase64(encodeDeterministicCbor(original)) },
      abort
    )
  ).rejects.toThrow('material differs')
  await expect(
    f.sellerDomain.issue(
      custody,
      { ...f.progress, status: 'admission-pending' },
      f.release,
      abort,
      f.submission
    )
  ).rejects.toThrow('original admitted purchase')
  await expect(
    f.sellerDomain.issue(
      custody,
      { ...f.progress, txid: 'ab'.repeat(32) },
      f.release,
      abort,
      f.submission
    )
  ).rejects.toThrow('original admitted purchase')
  await expect(
    f.sellerDomain.issue(
      custody,
      { ...f.progress, admission: { acceptedAt: '21' } },
      f.release,
      abort,
      f.submission
    )
  ).rejects.toThrow('chronology differs')
}, 60000)

it('refuses fabricated Bitcoin proof and release premises before issuing keys or a License', async () => {
  const f = await lchCovenantSellerFixture(),
    custody = await f.prepareSeller(),
    abort = signal()
  await expect(
    f.sellerDomain.verify({ ...f.submission, beef: 'AA==' }, custody, abort)
  ).rejects.toThrow('Independent full purchase failed')
  f.setNow('22')
  await expect(
    f.sellerDomain.issue(
      custody,
      f.progress,
      { ...f.release, acceptedAt: '21' },
      abort,
      f.submission
    )
  ).rejects.toThrow()
  expect(f.sellerCounts.release).toBe(1)
}, 60000)

it('owns original input bytes before awaiting independent checks and refuses changed physical guards', async () => {
  const f = await lchCovenantSellerFixture(),
    custody = await f.prepareSeller(),
    abort = signal(),
    submitted = own(f.submission),
    original = own(custody)
  const checking = f.sellerDomain.verify(submitted, original, abort)
  submitted.beef = 'AA=='
  original.maximumSecretBytes = 1
  const guard = await checking
  f.setAccess(false)
  expect(() => guard.checkCurrent()).toThrow('inaccessible')
  f.setAccess(true)
  const cancelled = new AbortController()
  cancelled.abort()
  await expect(
    f.sellerDomain.issue(custody, f.progress, f.release, cancelled.signal, f.submission)
  ).rejects.toThrow('cancelled')
  const release = f.sellerOptions.verification.release
  f.sellerOptions.verification.release = async (...args) => release(...args)
  expect(f.sellerDomain.isCurrent()).toBe(false)
  await expect(f.sellerDomain.verify(f.submission, custody, abort)).rejects.toThrow('changed')
}, 60000)

it('archives the complete finite signed authority selection and pins historical-assessment configuration', async () => {
  const f = await lchCovenantSellerFixture(),
    abort = signal(),
    actor = await WalletBRC77Signer.create({ wallet: new ProtoWallet(new PrivateKey(85)) }),
    authority = await signObject(
      'authority',
      {
        version: 1,
        assetId: f.asset.assetId,
        grantor: f.sellerOptions.sellerSigner.identityKey,
        grantee: actor.identityKey,
        interests: ['sound-recording'],
        capabilities: ['https://bsv.brc.dev/apps/0170#releaseKey'],
        policyActions: ['play'],
        usageProfiles: [f.offer.body.usageProfile],
        notBefore: 1,
        notAfter: 100,
        mayDelegate: false,
        nonce: new Uint8Array(16).fill(85)
      },
      f.sellerOptions.sellerSigner
    ),
    times: string[] = [],
    revocations = {
      id: 'historical-source',
      at: (at: string) => {
        times.push(at)
        return {
          status: async () => {
            throw new Error('This direct role has no revocation outpoint')
          }
        }
      }
    }
  f.listing.authorityPaths = [
    {
      controller: f.sellerOptions.sellerSigner.identityKey,
      actor: actor.identityKey,
      interest: 'sound-recording',
      capability: 'https://bsv.brc.dev/apps/0170#releaseKey',
      chain: [authority]
    }
  ]
  const seller = new LCHOverlayCovenantSeller({ ...f.sellerOptions, revocations }),
    prepared = await seller.prepare(f.prepare, f.selection, abort),
    contract = f.contracts.prepare(
      f.prepare,
      f.selection.manifest,
      prepared.preparation.terms,
      '20'
    ),
    custody = {
      original: f.contracts.authenticate(contract, f.prepared),
      schema: prepared.preparation.schema,
      material: prepared.preparation.material,
      maximumSecretBytes: prepared.preparation.maximumSecretBytes
    }
  f.setNow('22')
  const secret = await seller.issue(custody, f.progress, f.release, abort, f.submission),
    context = await decodeUnverifiedLCHOverlayContext(
      Uint8Array.from(decodeOutputBytes(secret, 2097152)),
      'listing-covenant'
    )
  expect(context.evidence.map(e => e.type)).toEqual(['authority', 'offer'])
  expect(context.evidence[0].object).toEqual(authority)
  expect(times).toContain('20')
  expect(times).toContain('22')
  revocations.id = 'replacement'
  expect(seller.isCurrent()).toBe(false)
}, 60000)

it('bounds detached ciphertext retrieval and rechecks current authority after the asynchronous source', async () => {
  const f = await lchCovenantSellerFixture({ detached: true }),
    abort = signal()
  let mode: 'valid' | 'oversized' | 'denied' = 'valid'
  const seller = new LCHOverlayCovenantSeller({
    ...f.sellerOptions,
    source: {
      read: async (...args) => {
        const result = await f.storage.read(...args)
        if (mode === 'denied') f.setAccess(false)
        return mode === 'oversized' ? new Uint8Array(1048577) : result
      }
    }
  })
  const prepared = await seller.prepare(f.prepare, f.selection, abort)
  prepared.validation.checkCurrent()
  const contract = f.contracts.prepare(
      f.prepare,
      f.selection.manifest,
      prepared.preparation.terms,
      '20'
    ),
    custody = {
      original: f.contracts.authenticate(contract, f.prepared),
      schema: prepared.preparation.schema,
      material: prepared.preparation.material,
      maximumSecretBytes: prepared.preparation.maximumSecretBytes
    }
  mode = 'oversized'
  await expect(seller.verify(f.submission, custody, abort)).rejects.toMatchObject({
    message: 'No valid ciphertext source was available',
    cause: { code: 'ERR_LCH_CONTENT_UNAVAILABLE', message: 'Seller ciphertext exceeds bound' }
  })
  mode = 'denied'
  await expect(seller.verify(f.submission, custody, abort)).rejects.toMatchObject({
    message: 'No valid ciphertext source was available',
    cause: {
      code: 'ERR_LCH_LICENSE',
      message: 'Seller installation changed, cancelled or inaccessible'
    }
  })
  expect(f.sellerCounts.purchase).toBe(0)
}, 60000)

it('refuses Promise-returning installation and proof guards and drains rejected promises', async () => {
  const f = await lchCovenantSellerFixture(),
    abort = signal(),
    current = new LCHOverlayCovenantSeller({
      ...f.sellerOptions,
      current: (() => Promise.reject(new Error('async permission'))) as never
    })
  await expect(current.prepare(f.prepare, f.selection, abort)).rejects.toThrow('inaccessible')
  expect(
    () => new LCHOverlayCovenantSeller({ ...f.sellerOptions, current: (async () => true) as never })
  ).toThrow('synchronous')
  const seller = new LCHOverlayCovenantSeller({
    ...f.sellerOptions,
    verification: {
      ...f.sellerOptions.verification,
      lineage: async (...args) => {
        await f.sellerOptions.verification.lineage(...args)
        return { checkCurrent: (() => Promise.reject(new Error('async proof'))) as never }
      }
    }
  })
  await expect(seller.prepare(f.prepare, f.selection, abort)).rejects.toThrow('did not finish')
}, 60000)
