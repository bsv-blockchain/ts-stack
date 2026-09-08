import { describe, expect, it, jest } from '@jest/globals'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import {
  CORE_CAPABILITIES,
  LCHAcquisition,
  LCHIssuer,
  LCHPublisher,
  LCHReader,
  LCH_MECHANISMS,
  LCH_PROFILES,
  MemoryContentSink,
  MemoryLicenseStore,
  PublicBRC77Verifier,
  WalletBRC77Signer,
  fixedTotal,
  fromBase64Url,
  fromHex,
  normalizeSelection,
  parsePinnedPolicy,
  permits,
  requireProfile,
  requireActiveTimeWindow,
  selectionQuantity,
  selectionsIntersect,
  sha256,
  signObject,
  supportsProfile,
  timeWindowStatus,
  toBase64Url,
  toHex,
  unitAmount,
  validateOffer,
  verifySignedObject,
  type LCHValue,
  type Selection,
  type SignedObject
} from '../src/index.js'

const bytes = (value: number, length: number): Uint8Array => new Uint8Array(length).fill(value)

describe('profiles, selections, prices, and policies', () => {
  it('accepts only fully understood acquisition profiles', () => {
    const offered = {
      usageProfile: LCH_PROFILES.fixedRender,
      payment: LCH_MECHANISMS.brc105Single,
      keyDelivery: LCH_MECHANISMS.brc78Key,
      encryption: LCH_MECHANISMS.encryption,
      enforcement: 'https://bsv.brc.dev/apps/0170#conformingApplication'
    }
    expect(supportsProfile(offered)).toBe(true)
    expect(() => requireProfile(offered)).not.toThrow()
    expect(
      supportsProfile({
        ...offered,
        critical: ['https://application.example/unknown-profile']
      })
    ).toBe(false)
    expect(CORE_CAPABILITIES.compositionMappings.has(LCH_MECHANISMS.wholePlacement)).toBe(true)
  })

  it('normalizes selections and checks exact integer pricing', () => {
    expect(
      normalizeSelection({
        type: 'segments',
        ranges: [
          [3, 5],
          [1, 3]
        ]
      })
    ).toEqual({ type: 'segments', ranges: [[1n, 5n]] })
    expect(
      selectionsIntersect({ type: 'bytes', ranges: [[1, 4]] }, { type: 'bytes', ranges: [[3, 6]] })
    ).toBe(true)
    expect(selectionQuantity({ type: 'pages', ranges: [[2, 5]] })).toBe(3n)
    expect(fixedTotal([{ satoshis: 3 }, { satoshis: 4n }])).toBe(7n)
    expect(unitAmount(11, 5, 1, 2)).toBe(6n)
    expect(() => unitAmount(1.5, 1, 1, 1)).toThrow()
  })

  it('fails closed with a stable LCH error for unknown selection types', () => {
    const unknown = { type: 'future-selection' } as unknown as Selection
    expect(() => normalizeSelection(unknown)).toThrow('Selection type is unsupported')
    expect(() => selectionsIntersect({ type: 'all' }, unknown)).toThrow(
      'Selection type is unsupported'
    )
    expect(() => selectionQuantity(unknown)).toThrow('Selection type is unsupported')
  })

  it('evaluates pinned policies without rewriting nested placeholders', async () => {
    const policy = {
      '@context': ['http://www.w3.org/ns/odrl.jsonld'],
      '@type': 'Offer',
      uid: 'lch:offer:self',
      profile: 'https://bsv.brc.dev/apps/0170#odrl-profile',
      permission: [{ target: 'lch:asset:sha256:one', action: 'play' }],
      prohibition: [{ target: 'lch:asset:sha256:one', action: 'unwrap' }]
    }
    const inline = new TextEncoder().encode(JSON.stringify(policy))
    const parsed = await parsePinnedPolicy(
      { mediaType: 'application/ld+json', digest: await sha256(inline), inline },
      'Offer',
      'lch:offer:sha256:computed'
    )
    expect(permits(parsed, 'play', 'lch:asset:sha256:one')).toBe(true)
    expect(permits(parsed, 'unwrap', 'lch:asset:sha256:one')).toBe(false)
  })

  it('round trips strict binary text encodings', () => {
    const value = Uint8Array.of(0, 1, 254, 255)
    expect(fromBase64Url(toBase64Url(value))).toEqual(value)
    expect(fromHex(toHex(value))).toEqual(value)
    expect(() => fromHex('AA')).toThrow()
  })

  it('uses half-open time windows at exact rental boundaries', () => {
    const window = { notBefore: 1_000, notAfter: 2_000 }
    expect(timeWindowStatus(window, 999)).toBe('not-started')
    expect(timeWindowStatus(window, 1_000)).toBe('active')
    expect(timeWindowStatus(window, 1_999)).toBe('active')
    expect(timeWindowStatus(window, 2_000)).toBe('expired')
    expect(() => requireActiveTimeWindow(window, 1_000)).not.toThrow()
    expect(() => requireActiveTimeWindow(window, 2_000)).toThrow()
    expect(() => timeWindowStatus({ notBefore: 2_000, notAfter: 2_000 }, 2_000)).toThrow()
    expect(() => timeWindowStatus({ notBefore: -1 }, 0)).toThrow()
    expect(timeWindowStatus({}, 0n)).toBe('active')
    expect(timeWindowStatus({ notBefore: 10n }, 10n)).toBe('active')
    expect(timeWindowStatus({ notAfter: 10n }, 9n)).toBe('active')
    expect(() => timeWindowStatus({ notAfter: -1 }, 0)).toThrow()
    expect(() => timeWindowStatus({}, 0.5)).toThrow()
  })
})

describe('issuer and acquisition orchestration', () => {
  it('ignores malformed co-signatures when a required signer is valid', async () => {
    const signer = await WalletBRC77Signer.create({
      wallet: new ProtoWallet(new PrivateKey(30)),
      random: length => bytes(30, length)
    })
    const signed = await signObject('offer', { version: 1 }, signer)
    const other = await WalletBRC77Signer.create({
      wallet: new ProtoWallet(new PrivateKey(29)),
      random: length => bytes(29, length)
    })
    const otherSigned = await signObject('offer', { version: 1 }, other)
    signed.signatures.unshift(Uint8Array.of(0), otherSigned.signatures[0])
    await expect(
      verifySignedObject('offer', signed, new PublicBRC77Verifier(), signer.identityKey)
    ).resolves.toBeUndefined()
  })

  it('signs and verifies Offers and exact whole-asset key Licenses', async () => {
    const signer = await WalletBRC77Signer.create({
      wallet: new ProtoWallet(new PrivateKey(31)),
      random: length => bytes(31, length)
    })
    const issuer = new LCHIssuer(signer)
    const policyBytes = new TextEncoder().encode('{}')
    const offer = await issuer.createOffer({
      assetId: bytes(1, 32),
      usageProfile: LCH_PROFILES.fixedRender,
      seller: signer.identityKey,
      licenseIssuer: signer.identityKey,
      requiredInterests: ['master'],
      policy: {
        mediaType: 'application/ld+json',
        digest: await sha256(policyBytes),
        inline: policyBytes
      },
      payment: {
        protocol: LCH_MECHANISMS.brc105Single,
        recoveryPeriodSeconds: 86_400
      },
      keyDelivery: { mechanism: LCH_MECHANISMS.brc78Key },
      enforcement: {
        class: 'https://bsv.brc.dev/apps/0170#conformingApplication'
      },
      notBefore: 1,
      nonce: bytes(2, 16)
    })
    await expect(
      validateOffer(offer, new PublicBRC77Verifier(), signer.identityKey)
    ).resolves.toMatch(/^lch:offer:sha256:/u)
    const emptyWindow = await signObject(
      'offer',
      { ...offer.body, notAfter: offer.body.notBefore },
      signer
    )
    await expect(
      validateOffer(emptyWindow, new PublicBRC77Verifier(), signer.identityKey)
    ).rejects.toMatchObject({ code: 'ERR_LCH_LICENSE' })
    const missingNotBeforeBody = { ...offer.body }
    delete missingNotBeforeBody.notBefore
    const missingNotBefore = await signObject('offer', missingNotBeforeBody, signer)
    await expect(
      validateOffer(missingNotBefore, new PublicBRC77Verifier(), signer.identityKey)
    ).rejects.toMatchObject({ code: 'ERR_LCH_LICENSE' })
    const invalidNotAfter = await signObject('offer', { ...offer.body, notAfter: 'later' }, signer)
    await expect(
      validateOffer(invalidNotAfter, new PublicBRC77Verifier(), signer.identityKey)
    ).rejects.toMatchObject({ code: 'ERR_LCH_LICENSE' })
    expect(issuer.quoteFixed([{ satoshis: 2 }, { satoshis: 3 }])).toBe(5n)

    const license = await issuer.issueLicense({
      assetId: bytes(1, 32),
      offerId: bytes(3, 32),
      requestId: bytes(4, 32),
      issuer: signer.identityKey,
      subject: bytes(5, 33),
      issuedAt: 10,
      agreement: {
        mediaType: 'application/ld+json',
        digest: await sha256(policyBytes),
        inline: policyBytes
      },
      selection: {
        type: 'segments',
        ranges: [
          [2, 3],
          [1, 2]
        ]
      }
    })
    expect(license.body.selection).toEqual({
      type: 'segments',
      ranges: [[1n, 3n]]
    })
  })

  it('keeps preflight, quote, payment delivery, and recovery explicit', async () => {
    const object: SignedObject = { body: {}, signatures: [] }
    const transport = {
      preflight: jest.fn(async () => undefined),
      quote: jest.fn(async () => object),
      deliver: jest.fn(async () => object),
      recover: jest.fn(async () => object)
    }
    const acquisition = new LCHAcquisition(transport)
    await acquisition.preflight(object)
    await expect(acquisition.quote(object)).resolves.toBe(object)
    await expect(acquisition.deliver(object, Uint8Array.of(1))).resolves.toBe(object)
    await expect(acquisition.recover(bytes(1, 32))).resolves.toBe(object)
    expect(transport.deliver).toHaveBeenCalledWith(object, Uint8Array.of(1))
  })

  it('authorizes a delegated Header signer only through the application callback', async () => {
    const controller = await WalletBRC77Signer.create({
      wallet: new ProtoWallet(new PrivateKey(32)),
      random: length => bytes(32, length)
    })
    const delegate = await WalletBRC77Signer.create({
      wallet: new ProtoWallet(new PrivateKey(33)),
      random: length => bytes(33, length)
    })
    const storage = new MemoryContentSink()
    const protectedAsset = await new LCHPublisher(delegate).protect(Uint8Array.of(1), {
      mediaType: 'application/octet-stream',
      name: 'delegated.bin',
      rights: [
        {
          interest: 'master',
          holder: { name: 'Controller' },
          controller: controller.identityKey
        }
      ],
      sink: storage,
      random: length => Uint8Array.from({ length }, (_, index) => length + index)
    })
    const published = await new LCHPublisher(delegate).publish(
      protectedAsset,
      [{ mode: 'discover', endpoint: 'https://seller.example' }],
      false
    )
    await expect(new LCHReader(storage).inspect(published.bytes)).rejects.toMatchObject({
      code: 'ERR_LCH_AUTHORITY'
    })
    const authorizeHeaderSigner = jest.fn(async () => true)
    await expect(
      new LCHReader(storage, undefined, { authorizeHeaderSigner }).inspect(published.bytes)
    ).resolves.toMatchObject({ assetId: protectedAsset.assetId })
    expect(authorizeHeaderSigner).toHaveBeenCalledWith(delegate.identityKey, protectedAsset.assetId)
  })

  it('retrieves stored Licenses through the reader', async () => {
    const store = new MemoryLicenseStore()
    const license: SignedObject<Record<string, LCHValue>> = {
      body: { version: 1 },
      signatures: []
    }
    await store.put({ assetId: '01', offerId: '02', license, storedAt: 1n })
    const reader = new LCHReader(new MemoryContentSink(), store)
    await expect(reader.storedLicense(Uint8Array.of(1), Uint8Array.of(2))).resolves.toEqual(license)
  })
})
