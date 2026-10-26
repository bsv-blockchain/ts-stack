import { describe, expect, it } from '@jest/globals'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import {
  LCHAcquisition,
  LCHBuyer,
  LCHIssuer,
  LCH_MECHANISMS,
  LCH_PROFILES,
  PublicBRC77Verifier,
  WalletBRC77Signer,
  sha256,
  signObject,
  validateLicenseRequest,
  validateOffer,
  type LCHValue,
  type SignedObject
} from '../src/index.js'

const bytes = (value: number, length: number): Uint8Array => new Uint8Array(length).fill(value)

describe('Offer validation boundaries', () => {
  it('accepts bounded optional terms, authorities, unit pricing, and an enumerated loopback', async () => {
    const signer = await WalletBRC77Signer.create({
      wallet: new ProtoWallet(new PrivateKey(61)),
      random: length => bytes(61, length)
    })
    const policyBytes = new TextEncoder().encode('{}')
    const termBytes = new TextEncoder().encode('plain-language terms')
    const offer = await new LCHIssuer(signer).createOffer({
      assetId: bytes(1, 32),
      usageProfile: LCH_PROFILES.fixedRender,
      seller: signer.identityKey,
      licenseIssuer: signer.identityKey,
      requiredInterests: ['master'],
      authorityIds: [bytes(2, 32)],
      policy: {
        mediaType: 'application/ld+json',
        digest: await sha256(policyBytes),
        inline: policyBytes
      },
      humanTerms: [
        {
          mediaType: 'text/plain',
          digest: await sha256(termBytes),
          inline: termBytes,
          language: 'en'
        }
      ],
      payment: {
        protocol: LCH_MECHANISMS.brc105Single,
        endpoint: 'http://127.0.0.1:4173/lch',
        asset: 'BSV',
        unit: 'satoshi',
        recoveryPeriodSeconds: 86_400,
        pricing: {
          kind: 'unit',
          requirements: [{ satoshis: 1 }],
          quantityUnit: 'bytes',
          unitSize: 1,
          minimumUnits: 0,
          maximumUnits: 2n
        }
      },
      keyDelivery: { mechanism: LCH_MECHANISMS.brc78Key },
      enforcement: { class: 'https://bsv.brc.dev/apps/0170#conformingApplication' },
      notBefore: 1,
      nonce: bytes(3, 16),
      allowInsecureLocalPaymentEndpoint: true
    })

    await expect(
      validateOffer(offer, new PublicBRC77Verifier(), signer.identityKey, {
        allowInsecureLocalOrigins: ['http://127.0.0.1:4173']
      })
    ).resolves.toMatch(/^lch:offer:sha256:/u)
  })

  it('rejects malformed Offer fields after authenticating the complete signed body', async () => {
    const signer = await WalletBRC77Signer.create({
      wallet: new ProtoWallet(new PrivateKey(62)),
      random: length => bytes(62, length)
    })
    const policyBytes = new TextEncoder().encode('{}')
    const offer = await new LCHIssuer(signer).createOffer({
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
        endpoint: 'https://issuer.example/lch',
        asset: 'BSV',
        unit: 'satoshi',
        recoveryPeriodSeconds: 86_400,
        pricing: { kind: 'quote' }
      },
      keyDelivery: { mechanism: LCH_MECHANISMS.brc78Key },
      enforcement: { class: 'https://bsv.brc.dev/apps/0170#conformingApplication' },
      notBefore: 1,
      nonce: bytes(2, 16)
    })
    const body = offer.body
    const payment = body.payment as Record<string, LCHValue>
    const keyDelivery = body.keyDelivery as Record<string, LCHValue>
    const enforcement = body.enforcement as Record<string, LCHValue>
    const withPayment = (overrides: Record<string, LCHValue>): Record<string, LCHValue> => ({
      ...body,
      payment: { ...payment, ...overrides }
    })
    const invalid: Array<{
      name: string
      body: Record<string, LCHValue>
      code: string
    }> = [
      { name: 'short asset ID', body: { ...body, assetId: bytes(1, 31) }, code: 'ERR_LCH_LICENSE' },
      { name: 'wrong Seller', body: { ...body, seller: bytes(1, 33) }, code: 'ERR_LCH_LICENSE' },
      {
        name: 'short License Issuer',
        body: { ...body, licenseIssuer: bytes(1, 32) },
        code: 'ERR_LCH_LICENSE'
      },
      { name: 'short nonce', body: { ...body, nonce: bytes(2, 15) }, code: 'ERR_LCH_LICENSE' },
      { name: 'empty profile', body: { ...body, usageProfile: '' }, code: 'ERR_LCH_LICENSE' },
      {
        name: 'absent interests',
        body: { ...body, requiredInterests: [] },
        code: 'ERR_LCH_AUTHORITY'
      },
      {
        name: 'non-string interest',
        body: { ...body, requiredInterests: [1] },
        code: 'ERR_LCH_AUTHORITY'
      },
      {
        name: 'empty interest',
        body: { ...body, requiredInterests: [''] },
        code: 'ERR_LCH_AUTHORITY'
      },
      {
        name: 'oversized interest',
        body: { ...body, requiredInterests: ['a'.repeat(4097)] },
        code: 'ERR_LCH_AUTHORITY'
      },
      {
        name: 'control character in interest',
        body: { ...body, requiredInterests: ['master\u0000'] },
        code: 'ERR_LCH_AUTHORITY'
      },
      {
        name: 'duplicate interests',
        body: { ...body, requiredInterests: ['master', 'master'] },
        code: 'ERR_LCH_AUTHORITY'
      },
      {
        name: 'non-array authorities',
        body: { ...body, authorityIds: 'authority' },
        code: 'ERR_LCH_AUTHORITY'
      },
      {
        name: 'empty authorities',
        body: { ...body, authorityIds: [] },
        code: 'ERR_LCH_AUTHORITY'
      },
      {
        name: 'short authority',
        body: { ...body, authorityIds: [bytes(1, 31)] },
        code: 'ERR_LCH_AUTHORITY'
      },
      {
        name: 'duplicate authorities',
        body: { ...body, authorityIds: [bytes(1, 32), bytes(1, 32)] },
        code: 'ERR_LCH_AUTHORITY'
      },
      { name: 'non-array human terms', body: { ...body, humanTerms: {} }, code: 'ERR_LCH_TERMS' },
      {
        name: 'too many human terms',
        body: { ...body, humanTerms: Array.from({ length: 65 }, () => ({})) },
        code: 'ERR_LCH_TERMS'
      },
      {
        name: 'empty protocol',
        body: withPayment({ protocol: '' }),
        code: 'ERR_LCH_PROFILE_UNSUPPORTED'
      },
      {
        name: 'empty endpoint',
        body: withPayment({ endpoint: '' }),
        code: 'ERR_LCH_PROFILE_UNSUPPORTED'
      },
      {
        name: 'wrong asset',
        body: withPayment({ asset: 'USD' }),
        code: 'ERR_LCH_PROFILE_UNSUPPORTED'
      },
      {
        name: 'wrong unit',
        body: withPayment({ unit: 'coin' }),
        code: 'ERR_LCH_PROFILE_UNSUPPORTED'
      },
      {
        name: 'non-numeric recovery period',
        body: withPayment({ recoveryPeriodSeconds: 'later' }),
        code: 'ERR_LCH_PROFILE_UNSUPPORTED'
      },
      {
        name: 'empty key-delivery mechanism',
        body: { ...body, keyDelivery: { ...keyDelivery, mechanism: '' } },
        code: 'ERR_LCH_PROFILE_UNSUPPORTED'
      },
      {
        name: 'empty enforcement class',
        body: { ...body, enforcement: { ...enforcement, class: '' } },
        code: 'ERR_LCH_PROFILE_UNSUPPORTED'
      },
      {
        name: 'relative endpoint',
        body: withPayment({ endpoint: '/lch' }),
        code: 'ERR_LCH_ENDPOINT'
      },
      {
        name: 'remote cleartext endpoint',
        body: withPayment({ endpoint: 'http://issuer.example/lch' }),
        code: 'ERR_LCH_ENDPOINT'
      },
      {
        name: 'localhost endpoint without opt-in',
        body: withPayment({ endpoint: 'https://localhost/lch' }),
        code: 'ERR_LCH_ENDPOINT'
      },
      {
        name: 'endpoint credentials',
        body: withPayment({ endpoint: 'https://user:secret@issuer.example/lch' }),
        code: 'ERR_LCH_ENDPOINT'
      },
      {
        name: 'endpoint fragment',
        body: withPayment({ endpoint: 'https://issuer.example/lch#fragment' }),
        code: 'ERR_LCH_ENDPOINT'
      },
      {
        name: 'unsupported pricing kind',
        body: withPayment({ pricing: { kind: 'auction' } }),
        code: 'ERR_LCH_QUOTE'
      },
      {
        name: 'fixed pricing without requirements',
        body: withPayment({ pricing: { kind: 'fixed' } }),
        code: 'ERR_LCH_QUOTE'
      },
      {
        name: 'unit pricing with empty quantity unit',
        body: withPayment({
          pricing: {
            kind: 'unit',
            requirements: [{}],
            quantityUnit: '',
            unitSize: 1,
            minimumUnits: 0
          }
        }),
        code: 'ERR_LCH_QUOTE'
      },
      {
        name: 'unit pricing with zero unit size',
        body: withPayment({
          pricing: {
            kind: 'unit',
            requirements: [{}],
            quantityUnit: 'bytes',
            unitSize: 0,
            minimumUnits: 0
          }
        }),
        code: 'ERR_LCH_QUOTE'
      },
      {
        name: 'unit pricing with non-integer minimum',
        body: withPayment({
          pricing: {
            kind: 'unit',
            requirements: [{}],
            quantityUnit: 'bytes',
            unitSize: 1,
            minimumUnits: 'half'
          }
        }),
        code: 'ERR_LCH_QUOTE'
      },
      {
        name: 'unit pricing with maximum below minimum',
        body: withPayment({
          pricing: {
            kind: 'unit',
            requirements: [{}],
            quantityUnit: 'bytes',
            unitSize: 1n,
            minimumUnits: 2n,
            maximumUnits: 1n
          }
        }),
        code: 'ERR_LCH_QUOTE'
      }
    ]

    for (const entry of invalid) {
      const candidate = await signObject('offer', entry.body, signer)
      await expect(
        validateOffer(candidate, new PublicBRC77Verifier(), signer.identityKey)
      ).rejects.toMatchObject({
        code: entry.code
      })
    }
  })
})

describe('acquisition request and recovery boundaries', () => {
  it('validates optional accepted terms and mechanism choices and rejects malformed signed values', async () => {
    const signer = await WalletBRC77Signer.create({
      wallet: new ProtoWallet(new PrivateKey(63)),
      random: length => bytes(63, length)
    })
    const buyer = new LCHBuyer(signer, length => bytes(7, length))
    const request = await buyer.createRequest({
      offerId: bytes(1, 32),
      assetId: bytes(2, 32),
      action: 'play',
      selection: { type: 'all' },
      acceptedPolicyDigest: bytes(3, 32),
      acceptedHumanTermDigests: [bytes(4, 32)],
      requestNonce: bytes(5, 16),
      createdAt: 1,
      mechanismChoices: { payment: LCH_MECHANISMS.brc105Single }
    })
    await expect(validateLicenseRequest(request)).resolves.toBeInstanceOf(Uint8Array)

    const invalid: Array<{ name: string; value: LCHValue; field: string; code: string }> = [
      {
        name: 'non-array terms',
        value: 'digest',
        field: 'acceptedHumanTermDigests',
        code: 'ERR_LCH_TERMS'
      },
      {
        name: 'short term digest',
        value: [bytes(1, 31)],
        field: 'acceptedHumanTermDigests',
        code: 'ERR_LCH_TERMS'
      },
      {
        name: 'duplicate term digests',
        value: [bytes(1, 32), bytes(1, 32)],
        field: 'acceptedHumanTermDigests',
        code: 'ERR_LCH_TERMS'
      },
      {
        name: 'null choices',
        value: null,
        field: 'mechanismChoices',
        code: 'ERR_LCH_PROFILE_UNSUPPORTED'
      },
      {
        name: 'array choices',
        value: [],
        field: 'mechanismChoices',
        code: 'ERR_LCH_PROFILE_UNSUPPORTED'
      },
      {
        name: 'byte choices',
        value: bytes(1, 1),
        field: 'mechanismChoices',
        code: 'ERR_LCH_PROFILE_UNSUPPORTED'
      },
      {
        name: 'too many choices',
        value: Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [`choice-${index}`, 'v'])
        ),
        field: 'mechanismChoices',
        code: 'ERR_LCH_PROFILE_UNSUPPORTED'
      },
      {
        name: 'empty choice key',
        value: { '': 'v' },
        field: 'mechanismChoices',
        code: 'ERR_LCH_PROFILE_UNSUPPORTED'
      },
      {
        name: 'oversized choice key',
        value: { ['k'.repeat(2049)]: 'v' },
        field: 'mechanismChoices',
        code: 'ERR_LCH_PROFILE_UNSUPPORTED'
      },
      {
        name: 'non-string choice',
        value: { payment: 1 },
        field: 'mechanismChoices',
        code: 'ERR_LCH_PROFILE_UNSUPPORTED'
      },
      {
        name: 'empty choice',
        value: { payment: '' },
        field: 'mechanismChoices',
        code: 'ERR_LCH_PROFILE_UNSUPPORTED'
      },
      {
        name: 'oversized choice',
        value: { payment: 'v'.repeat(2049) },
        field: 'mechanismChoices',
        code: 'ERR_LCH_PROFILE_UNSUPPORTED'
      }
    ]

    for (const entry of invalid) {
      const candidate = await signObject(
        'license-request',
        { ...request.body, [entry.field]: entry.value },
        signer
      )
      await expect(validateLicenseRequest(candidate)).rejects.toMatchObject({ code: entry.code })
    }

    for (const action of ['play\u0000', 'play\u007f', 'play\u202e']) {
      await expect(
        buyer.createRequest({
          offerId: bytes(1, 32),
          assetId: bytes(2, 32),
          action,
          selection: { type: 'all' },
          acceptedPolicyDigest: bytes(3, 32),
          createdAt: 1
        })
      ).rejects.toMatchObject({ code: 'ERR_LCH_FRAMING' })
    }
  })

  it('fails closed for unavailable recovery and preserves every legacy recovery shape', async () => {
    const object: SignedObject = { body: {}, signatures: [] }
    const base = {
      preflight: async (): Promise<void> => undefined,
      quote: async (): Promise<SignedObject> => object,
      deliver: async (): Promise<SignedObject> => object
    }

    await expect(new LCHAcquisition(base).recoverUnverified(bytes(1, 32))).rejects.toMatchObject({
      code: 'ERR_LCH_LICENSE'
    })
    await expect(
      new LCHAcquisition({ ...base, recover: async () => undefined }).recoverUnverified(
        bytes(1, 32)
      )
    ).resolves.toBeUndefined()
    await expect(
      new LCHAcquisition({
        ...base,
        recover: async () => ({ unverifiedLicense: object })
      }).recoverUnverified(bytes(1, 32))
    ).resolves.toEqual({ unverifiedLicense: object })
  })
})
