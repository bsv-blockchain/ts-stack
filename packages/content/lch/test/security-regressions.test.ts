import { describe, expect, it, jest } from '@jest/globals'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import {
  LCHBuyer,
  LCHComposer,
  LCHIssuer,
  LCHPublisher,
  LCHReader,
  LCH_MECHANISMS,
  LCH_PROFILES,
  StaticC2PAAdapter,
  WalletBRC77Signer,
  WalletBRC78KeyDelivery,
  decodeDeterministicCbor,
  encodeDeterministicCbor,
  encryptSegmented,
  fetchLCH,
  fromHex,
  keyIdFor,
  objectId,
  parsePinnedPolicy,
  permits,
  signObject,
  sha256,
  validateC2PAComposition,
  validateCompositionRecord,
  validateAuthorityChain,
  validateLicenseRequest,
  validateOffer,
  verifySignedObject,
  walkComposition,
  PublicBRC77Verifier
} from '../src/index.js'
import type { AuthorityBody, LCHValue } from '../src/index.js'

const bytes = (value: number, length: number): Uint8Array => new Uint8Array(length).fill(value)

function concat(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

describe('LCH security regressions', () => {
  it('bounds aggregate CBOR items and bytes at the primitive boundary', () => {
    const nested = [
      Array.from({ length: 60_000 }, () => null),
      Array.from({ length: 60_000 }, () => null)
    ]
    expect(() => encodeDeterministicCbor(nested)).toThrow(
      expect.objectContaining({ code: 'ERR_LCH_CBOR' })
    )
    expect(() => encodeDeterministicCbor(new Uint8Array(16 * 1024 * 1024))).toThrow(
      expect.objectContaining({ code: 'ERR_LCH_CBOR' })
    )
    expect(() => decodeDeterministicCbor(new Uint8Array(16 * 1024 * 1024 + 1))).toThrow(
      expect.objectContaining({ code: 'ERR_LCH_CBOR' })
    )
  })

  it('rejects unsupported versions and critical extensions before trusting a signed object', async () => {
    const signer = await WalletBRC77Signer.create({ wallet: new ProtoWallet(new PrivateKey(61)) })
    const request = await new LCHBuyer(signer).createRequest({
      offerId: bytes(1, 32),
      assetId: bytes(2, 32),
      action: 'play',
      selection: { type: 'all' },
      acceptedPolicyDigest: bytes(3, 32),
      createdAt: 1,
      critical: ['https://application.example/lch/paid-preview-v1']
    })
    await expect(validateLicenseRequest(request)).rejects.toMatchObject({
      code: 'ERR_LCH_PROFILE_UNSUPPORTED'
    })
    await expect(
      validateLicenseRequest(request, undefined, {
        supportedCriticalIdentifiers: new Set(['https://application.example/lch/paid-preview-v1'])
      })
    ).resolves.toBeInstanceOf(Uint8Array)

    const future = await signObject('license-request', { ...request.body, version: 2 }, signer)
    await expect(validateLicenseRequest(future)).rejects.toMatchObject({
      code: 'ERR_LCH_PROFILE_UNSUPPORTED'
    })
  })

  it('does not ignore critical semantics on a signed Header or Asset', async () => {
    const signer = await WalletBRC77Signer.create({ wallet: new ProtoWallet(new PrivateKey(70)) })
    const critical = 'https://application.example/lch/custom-asset-semantics-v1'
    const publisher = new LCHPublisher(signer)
    const protectedAsset = await publisher.protect(bytes(25, 8), {
      mediaType: 'application/octet-stream',
      name: 'critical.bin',
      rights: [{ interest: 'master', holder: { name: 'Creator' }, controller: signer.identityKey }],
      segmentSize: 8
    })
    protectedAsset.asset.critical = [critical]
    protectedAsset.assetId = await objectId('asset', protectedAsset.asset)
    const published = await publisher.publish(
      protectedAsset,
      [{ mode: 'inline', offer: { body: {}, signatures: [] } }],
      true
    )
    const source = { read: async () => new Uint8Array() }
    await expect(new LCHReader(source).inspect(published.bytes)).rejects.toMatchObject({
      code: 'ERR_LCH_PROFILE_UNSUPPORTED'
    })
    await expect(
      new LCHReader(source, undefined, {
        supportedCriticalIdentifiers: new Set([critical])
      }).inspect(published.bytes)
    ).resolves.toMatchObject({ asset: { critical: [critical] } })
  })

  it('refuses a protected Asset mutated between protection and publication', async () => {
    const signer = await WalletBRC77Signer.create({ wallet: new ProtoWallet(new PrivateKey(72)) })
    const publisher = new LCHPublisher(signer)
    const protectedAsset = await publisher.protect(bytes(29, 8), {
      mediaType: 'application/octet-stream',
      name: 'original.bin',
      rights: [{ interest: 'master', holder: { name: 'Creator' }, controller: signer.identityKey }],
      segmentSize: 8
    })
    protectedAsset.asset.name = 'substituted.bin'
    await expect(
      publisher.publish(protectedAsset, [{ mode: 'discover' }], true)
    ).rejects.toMatchObject({ code: 'ERR_LCH_CONTENT_DIGEST' })
  })

  it('bounds signed-object signature fan-out before verification', async () => {
    const signer = await WalletBRC77Signer.create({ wallet: new ProtoWallet(new PrivateKey(62)) })
    const signed = await signObject('offer', { version: 1 }, signer)
    signed.signatures = Array.from({ length: 65 }, () => signed.signatures[0])
    await expect(
      verifySignedObject('offer', signed, new PublicBRC77Verifier(), signer.identityKey)
    ).rejects.toMatchObject({ code: 'ERR_LCH_SIGNATURE' })
  })

  it('requires an exact boolean signature-verifier verdict', async () => {
    const signer = await WalletBRC77Signer.create({ wallet: new ProtoWallet(new PrivateKey(73)) })
    const signed = await signObject('offer', { version: 1 }, signer)
    const malformedVerifier = {
      verify: async () => 'true' as unknown as boolean
    }

    await expect(
      verifySignedObject('offer', signed, malformedVerifier, signer.identityKey)
    ).rejects.toMatchObject({ code: 'ERR_LCH_SIGNATURE' })
  })

  it('requires signed envelope and version fields to be own data', async () => {
    const signer = await WalletBRC77Signer.create({ wallet: new ProtoWallet(new PrivateKey(75)) })
    const signed = await signObject('offer', { version: 1 }, signer)
    const inheritedEnvelope = Object.create({
      body: signed.body,
      signatures: signed.signatures
    }) as typeof signed
    await expect(
      verifySignedObject('offer', inheritedEnvelope, new PublicBRC77Verifier(), signer.identityKey)
    ).rejects.toMatchObject({ code: 'ERR_LCH_FRAMING' })

    const inheritedVersion = {
      body: Object.create({ version: 1 }) as Record<string, LCHValue>,
      signatures: signed.signatures
    }
    await expect(
      verifySignedObject('offer', inheritedVersion, new PublicBRC77Verifier(), signer.identityKey)
    ).rejects.toMatchObject({ code: 'ERR_LCH_FRAMING' })
  })

  it('validates an owned signed snapshot when the caller mutates during verification', async () => {
    const signer = await WalletBRC77Signer.create({ wallet: new ProtoWallet(new PrivateKey(76)) })
    const request = await new LCHBuyer(signer).createRequest({
      offerId: bytes(1, 32),
      assetId: bytes(2, 32),
      action: 'play',
      selection: { type: 'all' },
      acceptedPolicyDigest: bytes(3, 32),
      createdAt: 1
    })
    const expected = await objectId('license-request', request.body)
    let verificationStarted!: () => void
    let releaseVerification!: () => void
    const started = new Promise<void>(resolve => {
      verificationStarted = resolve
    })
    const released = new Promise<void>(resolve => {
      releaseVerification = resolve
    })
    const publicVerifier = new PublicBRC77Verifier()
    const verifier = {
      verify: async (preimage: Uint8Array, signature: Uint8Array): Promise<boolean> => {
        verificationStarted()
        await released
        return publicVerifier.verify(preimage, signature)
      }
    }
    const pending = validateLicenseRequest(request, verifier)
    await started
    request.body.action = 'substituted-after-signature-check-started'
    releaseVerification()
    await expect(pending).resolves.toEqual(expected)
  })

  it('does not inherit reader security configuration from Object.prototype', async () => {
    const signer = await WalletBRC77Signer.create({ wallet: new ProtoWallet(new PrivateKey(77)) })
    const critical = 'https://application.example/lch/inherited-semantics-v1'
    const publisher = new LCHPublisher(signer)
    const protectedAsset = await publisher.protect(bytes(25, 8), {
      mediaType: 'application/octet-stream',
      name: 'inherited-options.bin',
      rights: [{ interest: 'master', holder: { name: 'Creator' }, controller: signer.identityKey }],
      segmentSize: 8
    })
    protectedAsset.asset.critical = [critical]
    protectedAsset.assetId = await objectId('asset', protectedAsset.asset)
    const published = await publisher.publish(protectedAsset, [{ mode: 'discover' }], true)
    const inheritedOptions = Object.create({
      supportedCriticalIdentifiers: new Set([critical])
    })
    await expect(
      new LCHReader({ read: async () => new Uint8Array() }, undefined, inheritedOptions).inspect(
        published.bytes
      )
    ).rejects.toMatchObject({ code: 'ERR_LCH_PROFILE_UNSUPPORTED' })
  })

  it('requires own wallet result fields for BRC-77 and BRC-78 operations', async () => {
    const identity = new PrivateKey(78).toPublicKey().toString()
    await expect(
      WalletBRC77Signer.create({
        wallet: {
          getPublicKey: async () => Object.create({ publicKey: identity }),
          createSignature: async () => ({ signature: [1] })
        } as never
      })
    ).rejects.toMatchObject({ code: 'ERR_LCH_FRAMING' })

    const signer = await WalletBRC77Signer.create({
      wallet: {
        getPublicKey: async () => ({ publicKey: identity }),
        createSignature: async () => Object.create({ signature: [1] })
      } as never,
      identityKey: identity
    })
    await expect(signer.sign(bytes(1, 32))).rejects.toMatchObject({ code: 'ERR_LCH_FRAMING' })

    const recipient = new PrivateKey(79).toPublicKey().toString()
    const cek = bytes(16, 32)
    const delivery = new WalletBRC78KeyDelivery({
      getPublicKey: async () => ({ publicKey: identity }),
      encrypt: async () => Object.create({ ciphertext: [1] }),
      decrypt: async () => ({ plaintext: [] })
    } as never)
    await expect(delivery.deliver(recipient, await keyIdFor(cek), cek)).rejects.toMatchObject({
      code: 'ERR_LCH_FRAMING'
    })
  })

  it('does not treat constrained or duty-bearing ODRL permissions as unconditional grants', () => {
    const evaluation = {
      policy: {},
      permissions: [
        { action: 'play', target: 'asset', constraint: [{ leftOperand: 'dateTime' }] },
        { action: 'render', target: 'asset', duty: [{ action: 'compensate' }] },
        { action: 'inspect', target: 'asset' }
      ],
      prohibitions: [],
      duties: []
    }
    expect(permits(evaluation, 'play', 'asset')).toBe(false)
    expect(permits(evaluation, 'render', 'asset')).toBe(false)
    expect(permits(evaluation, 'inspect', 'asset')).toBe(true)
  })

  it('bounds deeply nested ODRL JSON before semantic traversal', async () => {
    let nested: Record<string, unknown> = {}
    for (let depth = 0; depth < 70; depth += 1) nested = { nested }
    const inline = new TextEncoder().encode(
      JSON.stringify({
        '@context': ['http://www.w3.org/ns/odrl.jsonld'],
        '@type': 'Offer',
        uid: 'lch:offer:self',
        profile: 'https://bsv.brc.dev/apps/0170#odrl-profile',
        nested
      })
    )
    await expect(
      parsePinnedPolicy(
        { mediaType: 'application/ld+json', digest: await sha256(inline), inline },
        'Offer',
        'lch:offer:sha256:00'
      )
    ).rejects.toMatchObject({ code: 'ERR_LCH_POLICY' })
  })

  it('requires exact bidirectional C2PA ingredient coverage', async () => {
    const manifest = new TextEncoder().encode('manifest')
    const hashedUri = { url: 'self#ingredient-one', alg: 'sha256', hash: bytes(4, 32) }
    const record = new LCHComposer(await sha256(manifest))
      .addWholePlacement({
        sourceAssetId: bytes(5, 32),
        sourceLicenseId: bytes(6, 32),
        c2paIngredient: hashedUri,
        relationship: 'componentOf',
        sourceSelection: { type: 'all' }
      })
      .build()
    const adapter = new StaticC2PAAdapter([
      { sourceAssetId: bytes(5, 32), relationship: 'componentOf', hashedUri },
      {
        sourceAssetId: bytes(7, 32),
        relationship: 'inputTo',
        hashedUri: { url: 'self#unlicensed', alg: 'sha256', hash: bytes(8, 32) }
      }
    ])
    await expect(
      validateC2PAComposition(bytes(9, 1), manifest, record, adapter)
    ).rejects.toMatchObject({ code: 'ERR_LCH_PROVENANCE' })
  })

  it('rejects delimiter-confusable and runtime-malformed composition bindings', async () => {
    const manifest = new TextEncoder().encode('manifest')
    const record = new LCHComposer(await sha256(manifest))
      .addWholePlacement({
        sourceAssetId: bytes(5, 32),
        sourceLicenseId: bytes(6, 32),
        c2paIngredient: { url: 'self#a', alg: 'b', hash: bytes(7, 32) },
        relationship: 'componentOf',
        sourceSelection: { type: 'all' }
      })
      .build()
    const confused = new StaticC2PAAdapter([
      {
        sourceAssetId: bytes(5, 32),
        relationship: 'componentOf',
        hashedUri: { url: 'self#a\u0000b', hash: bytes(7, 32) }
      }
    ])
    await expect(
      validateC2PAComposition(bytes(8, 1), manifest, record, confused)
    ).rejects.toMatchObject({ code: 'ERR_LCH_PROVENANCE' })
    expect(() =>
      validateCompositionRecord({
        ...record,
        ingredients: [
          {
            ...record.ingredients[0],
            sourceAssetId: '0'.repeat(32) as unknown as Uint8Array
          }
        ]
      })
    ).toThrow(expect.objectContaining({ code: 'ERR_LCH_PROVENANCE' }))
  })

  it('does not follow a public redirect into an allowlisted local origin', async () => {
    const connect = jest.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:4173/admin' } })
    )
    await expect(
      fetchLCH('https://public.example/content', {}, 'content', {
        allowLocalOrigins: ['http://127.0.0.1:4173'],
        resolve: async () => ['93.184.216.34'],
        connect
      })
    ).rejects.toMatchObject({ code: 'ERR_LCH_ENDPOINT' })
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('does not inherit a local-network endpoint exception', async () => {
    const inheritedPolicy = Object.create({
      allowLocalOrigins: ['http://127.0.0.1:4173']
    })
    await expect(
      fetchLCH('http://127.0.0.1:4173/private', {}, 'content', inheritedPolicy)
    ).rejects.toMatchObject({ code: 'ERR_LCH_ENDPOINT' })
  })

  it('bounds an endpoint connector that never returns', async () => {
    await expect(
      fetchLCH('https://93.184.216.34/content', {}, 'content', {
        timeoutMs: 10,
        connect: async () => new Promise<Response>(() => undefined)
      })
    ).rejects.toMatchObject({ code: 'ERR_LCH_ENDPOINT' })
  })

  it('rejects excessive encryption work before invoking the random source', async () => {
    const random = jest.fn((length: number) => new Uint8Array(length))
    await expect(
      encryptSegmented(new Uint8Array(1_000_001), { segmentSize: 1, random })
    ).rejects.toMatchObject({ code: 'ERR_LCH_KEY' })
    expect(random).not.toHaveBeenCalled()
    await expect(
      encryptSegmented(new Uint8Array(100_001), {
        segmentSize: 1,
        keyPeriodSegments: 1,
        random
      })
    ).rejects.toMatchObject({ code: 'ERR_LCH_KEY' })
    expect(random).not.toHaveBeenCalled()
  })

  it('detects encryption material reuse across one publisher instance', async () => {
    const signer = await WalletBRC77Signer.create({ wallet: new ProtoWallet(new PrivateKey(71)) })
    const publisher = new LCHPublisher(signer)
    const options = {
      mediaType: 'application/octet-stream',
      name: 'rng.bin',
      rights: [{ interest: 'master', holder: { name: 'Creator' }, controller: signer.identityKey }],
      segmentSize: 8,
      random: (length: number): Uint8Array => bytes(26, length)
    }
    await expect(publisher.protect(bytes(27, 8), options)).resolves.toBeDefined()
    await expect(publisher.protect(bytes(28, 8), options)).rejects.toMatchObject({
      code: 'ERR_LCH_KEY'
    })
  })

  it('binds composition loader results to the requested Asset and Selection', async () => {
    const record = new LCHComposer(bytes(10, 32))
      .addWholePlacement({
        sourceAssetId: bytes(11, 32),
        sourceLicenseId: bytes(12, 32),
        c2paIngredient: { url: 'self#source', alg: 'sha256', hash: bytes(13, 32) },
        relationship: 'componentOf',
        sourceSelection: { type: 'all' }
      })
      .build()
    await expect(
      walkComposition({ assetId: bytes(14, 32), selection: { type: 'all' }, record }, async () => ({
        assetId: bytes(15, 32),
        selection: { type: 'all' }
      }))
    ).rejects.toMatchObject({ code: 'ERR_LCH_PROVENANCE' })
    await expect(
      walkComposition(
        { assetId: bytes(14, 32), selection: { type: 'all' } },
        async () => undefined,
        33
      )
    ).rejects.toMatchObject({ code: 'ERR_LCH_CYCLE' })
  })

  it('rejects malformed wallet byte results instead of normalizing them modulo 256', async () => {
    const sender = new PrivateKey(63).toPublicKey().toString()
    const recipient = new PrivateKey(64).toPublicKey().toString()
    const cek = bytes(16, 32)
    const keyId = await keyIdFor(cek)
    const delivery = new WalletBRC78KeyDelivery({
      getPublicKey: async () => ({ publicKey: sender }),
      encrypt: async () => ({ ciphertext: [256] }),
      decrypt: async () => ({ plaintext: [] })
    } as never)
    await expect(delivery.deliver(recipient, keyId, cek)).rejects.toMatchObject({
      code: 'ERR_LCH_KEY'
    })

    const payload = concat(
      Uint8Array.of(0x42, 0x42, 0x10, 0x33),
      fromHex(sender),
      fromHex(recipient),
      bytes(17, 32),
      Uint8Array.of(1)
    )
    const recovery = new WalletBRC78KeyDelivery({
      getPublicKey: async () => ({ publicKey: recipient }),
      encrypt: async () => ({ ciphertext: [] }),
      decrypt: async () => ({ plaintext: [...bytes(18, 63), 256] })
    } as never)
    await expect(recovery.recover(payload)).rejects.toMatchObject({ code: 'ERR_LCH_KEY' })
  })

  it('bounds the lifetime BRC-78 message-key reuse detector', async () => {
    const sender = new PrivateKey(73).toPublicKey().toString()
    const recipient = new PrivateKey(74).toPublicKey().toString()
    const delivery = new WalletBRC78KeyDelivery(
      {
        getPublicKey: async () => ({ publicKey: sender }),
        encrypt: async () => ({ ciphertext: [1] }),
        decrypt: async () => ({ plaintext: [] })
      } as never,
      length => bytes(29, length)
    )
    const detector = (delivery as unknown as { issuedMessageKeyIds: Set<string> })
      .issuedMessageKeyIds
    for (let index = 0; index < 100_000; index += 1) detector.add(String(index))
    const cek = bytes(30, 32)
    await expect(delivery.deliver(recipient, await keyIdFor(cek), cek)).rejects.toMatchObject({
      code: 'ERR_LCH_KEY'
    })
  })

  it('does not label a signature-only shell as a validated Offer', async () => {
    const signer = await WalletBRC77Signer.create({ wallet: new ProtoWallet(new PrivateKey(65)) })
    const shell = await signObject('offer', { version: 1, notBefore: 1 }, signer)
    await expect(
      validateOffer(shell, new PublicBRC77Verifier(), signer.identityKey)
    ).rejects.toMatchObject({ code: 'ERR_LCH_LICENSE' })
  })

  it('rejects a signed Offer whose Policy reference lies about its inline bytes', async () => {
    const signer = await WalletBRC77Signer.create({ wallet: new ProtoWallet(new PrivateKey(69)) })
    const inline = new TextEncoder().encode('accepted policy')
    const offer = await new LCHIssuer(signer).createOffer({
      assetId: bytes(22, 32),
      usageProfile: LCH_PROFILES.fixedRender,
      seller: signer.identityKey,
      licenseIssuer: signer.identityKey,
      requiredInterests: ['master'],
      policy: {
        mediaType: 'application/ld+json',
        digest: await sha256(inline),
        inline
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
      nonce: bytes(23, 16)
    })
    const substituted = await signObject(
      'offer',
      {
        ...offer.body,
        policy: {
          mediaType: 'application/ld+json',
          digest: await sha256(inline),
          inline: bytes(24, 16)
        }
      },
      signer
    )
    await expect(
      validateOffer(substituted, new PublicBRC77Verifier(), signer.identityKey)
    ).rejects.toMatchObject({ code: 'ERR_LCH_TERMS' })
  })

  it('does not treat a truthy non-boolean mayDelegate value as authority', async () => {
    const root = await WalletBRC77Signer.create({ wallet: new ProtoWallet(new PrivateKey(66)) })
    const delegate = await WalletBRC77Signer.create({
      wallet: new ProtoWallet(new PrivateKey(67))
    })
    const actor = Uint8Array.from(new PrivateKey(68).toPublicKey().encode(true) as number[])
    const assetId = bytes(19, 32)
    const rootBody: Record<string, LCHValue> = {
      version: 1,
      assetId,
      grantor: root.identityKey,
      grantee: delegate.identityKey,
      interests: ['master'],
      capabilities: ['issueOffer'],
      notBefore: 1,
      mayDelegate: 'false',
      nonce: bytes(20, 16)
    }
    const childBody: AuthorityBody = {
      version: 1,
      assetId,
      grantor: delegate.identityKey,
      grantee: actor,
      interests: ['master'],
      capabilities: ['issueOffer'],
      notBefore: 1,
      mayDelegate: false,
      nonce: bytes(21, 16)
    }
    const signedRoot = await signObject('authority', rootBody, root)
    const signedChild = await signObject(
      'authority',
      childBody as unknown as Record<string, LCHValue>,
      delegate
    )
    await expect(
      validateAuthorityChain(
        [
          {
            body: rootBody as unknown as AuthorityBody,
            signatures: signedRoot.signatures
          },
          { body: childBody, signatures: signedChild.signatures }
        ],
        {
          controller: root.identityKey,
          actor,
          assetId,
          interest: 'master',
          capability: 'issueOffer',
          now: 2n,
          network: 'mainnet'
        },
        new PublicBRC77Verifier()
      )
    ).rejects.toMatchObject({ code: 'ERR_LCH_AUTHORITY' })
  })
})
