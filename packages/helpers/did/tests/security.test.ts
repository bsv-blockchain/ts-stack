import { PrivateKey } from '@bsv/sdk'
import {
  BsvDid,
  SdJwtVcHolder,
  SdJwtVcIssuer,
  SdJwtVcPresenter,
  SdJwtVcVerifier,
  applyDisclosures,
  base64UrlDecodeJson,
  base64UrlEncode,
  base64UrlEncodeJson,
  createKeyBindingJwt,
  decodeJwt,
  disclosureDigest,
  jwkToPublicKey,
  parseSdJwt,
  publicKeyToJwk,
  selectDisclosures,
  serializeSdJwt,
  signJwt,
  verifyKeyBindingJwt
} from '../src/index.js'

const issuerPrivateKey = new PrivateKey(11)
const holderPrivateKey = new PrivateKey(12)
const otherPrivateKey = new PrivateKey(13)
const issuerDid = BsvDid.fromPublicKey(issuerPrivateKey.toPublicKey())
const credentialType = 'urn:example:credential:1'

async function issue(issuedAt = 1_000) {
  return SdJwtVcIssuer.create({
    issuer: issuerDid,
    issuerPrivateKey,
    holderPublicKey: holderPrivateKey.toPublicKey(),
    vct: credentialType,
    claims: {
      role: 'reader',
      profile: {
        given_name: 'Alice',
        family_name: 'Ng'
      }
    },
    disclosureFrame: {
      role: true,
      profile: {
        given_name: true
      }
    },
    issuedAt
  })
}

describe('SD-JWT security boundaries', () => {
  afterEach(() => SdJwtVcHolder.clear())

  test('does not treat a self-asserted JOSE header key as issuer authority', async () => {
    const attacker = new PrivateKey(99)
    const jwt = signJwt(
      { typ: 'dc+sd-jwt', jwk: publicKeyToJwk(attacker.toPublicKey()) },
      {
        iss: 'https://trusted-issuer.example',
        iat: 1_000,
        vct: credentialType,
        cnf: { jwk: publicKeyToJwk(holderPrivateKey.toPublicKey()) }
      },
      attacker
    )

    const unconfigured = await SdJwtVcVerifier.verify(serializeSdJwt(jwt, []), { now: 1_000 })
    expect(unconfigured).toMatchObject({
      verified: false,
      issuerSignedJwtVerified: false,
      payload: null
    })
    expect(unconfigured.errors[0]).toContain('Issuer public key is required')

    const configured = await SdJwtVcVerifier.verify(serializeSdJwt(jwt, []), {
      issuerPublicKey: issuerPrivateKey.toPublicKey(),
      expectedIssuer: 'https://trusted-issuer.example',
      now: 1_000
    })
    expect(configured.verified).toBe(false)
    expect(configured.errors[0]).toContain('signature verification failed')
  })

  test('binds did:key issuer identity even when a different key is configured', async () => {
    const credential = await issue()
    const result = await SdJwtVcVerifier.verify(credential.sdJwt, {
      issuerPublicKey: otherPrivateKey.toPublicKey(),
      now: 1_000
    })
    expect(result.verified).toBe(false)
    expect(result.errors[0]).toContain('does not match did:key')
  })

  test('enforces credential type, temporal validity, explicit type, and JWT audience', async () => {
    const make = (payload: Record<string, unknown>, typ = 'dc+sd-jwt') =>
      serializeSdJwt(
        signJwt(
          { typ },
          {
            iss: issuerDid,
            iat: 1_000,
            vct: credentialType,
            cnf: { jwk: publicKeyToJwk(holderPrivateKey.toPublicKey()) },
            ...payload
          },
          issuerPrivateKey
        ),
        []
      )

    expect(
      (await SdJwtVcVerifier.verify(make({ exp: 999 }), { now: 1_000, clockToleranceSeconds: 0 }))
        .verified
    ).toBe(false)
    expect(
      (await SdJwtVcVerifier.verify(make({ nbf: 1_001 }), { now: 1_000, clockToleranceSeconds: 0 }))
        .verified
    ).toBe(false)
    expect((await SdJwtVcVerifier.verify(make({}, 'JWT'), { now: 1_000 })).verified).toBe(false)
    expect(
      (
        await SdJwtVcVerifier.verify(make({ aud: 'https://rp.example' }), {
          now: 1_000
        })
      ).verified
    ).toBe(false)
    expect(
      (
        await SdJwtVcVerifier.verify(make({ aud: 'https://rp.example' }), {
          expectedCredentialAudience: 'https://rp.example',
          expectedVct: credentialType,
          now: 1_000
        })
      ).verified
    ).toBe(true)
  })

  test('requires transaction context and freshness for Key Binding and clears failed payloads', async () => {
    const credential = await issue()
    const presentation = await SdJwtVcHolder.generatePresentation(credential, ['role'], {
      holderPrivateKey,
      audience: 'https://verifier.example',
      nonce: 'nonce-1',
      issuedAt: 1_000
    })
    const wire = SdJwtVcPresenter.present(presentation)

    const noNonce = await SdJwtVcVerifier.verify(wire, {
      expectedAudience: 'https://verifier.example',
      now: 1_000
    })
    expect(noNonce.verified).toBe(false)
    expect(noNonce.errors[0]).toContain('expectedAudience and expectedNonce')

    const stale = await SdJwtVcVerifier.verify(wire, {
      expectedAudience: 'https://verifier.example',
      expectedNonce: 'nonce-1',
      now: 2_000,
      clockToleranceSeconds: 0,
      maxKeyBindingAgeSeconds: 300
    })
    expect(stale).toMatchObject({ verified: false, issuerSignedJwtVerified: true, payload: null })
    expect(stale.disclosedClaims).toEqual({})
    expect(stale.errors[0]).toContain('too old')
  })

  test('keeps legacy low-level Key Binding helpers compatible without treating them as authorization policy', async () => {
    const credential = await issue()
    const parsed = parseSdJwt(credential.sdJwt)
    const selected = serializeSdJwt(parsed.issuerSignedJwt, [])
    const legacy = createKeyBindingJwt(selected, holderPrivateKey, { issuedAt: 1_000 })

    expect(
      verifyKeyBindingJwt(selected, legacy, publicKeyToJwk(holderPrivateKey.toPublicKey()), {
        now: 1_000
      })
    ).toBe(true)
    expect(() =>
      verifyKeyBindingJwt(selected, legacy, publicKeyToJwk(holderPrivateKey.toPublicKey()), {
        audience: 'https://verifier.example',
        nonce: 'nonce-1',
        now: 1_000
      })
    ).toThrow('audience mismatch')
  })

  test('rejects duplicate digests, cleartext collisions, reserved names, and nested hash policy', () => {
    const roleDisclosure = base64UrlEncodeJson(['0123456789abcdef', 'role', 'admin'])
    const roleDigest = disclosureDigest(roleDisclosure)

    expect(() => applyDisclosures({ role: 'reader', _sd: [roleDigest] }, [roleDisclosure])).toThrow(
      'collides'
    )
    expect(() =>
      applyDisclosures({ _sd: [roleDigest], nested: { _sd: [roleDigest] } }, [roleDisclosure])
    ).toThrow('more than once')
    const reserved = base64UrlEncodeJson(['0123456789abcdef', '_sd', ['forged']])
    expect(() => applyDisclosures({ _sd: [disclosureDigest(reserved)] }, [reserved])).toThrow(
      'reserved'
    )
    expect(() => applyDisclosures({ nested: { _sd_alg: 'sha-256' } }, [])).toThrow(
      'only permitted at the top level'
    )

    const prototypeClaim = base64UrlEncodeJson([
      '0123456789abcdef',
      '__proto__',
      { polluted: true }
    ])
    const prototypeResult = applyDisclosures({ _sd: [disclosureDigest(prototypeClaim)] }, [
      prototypeClaim
    ])
    expect(Object.getPrototypeOf(prototypeResult.payload)).toBe(Object.prototype)
    expect(Object.hasOwn(prototypeResult.payload, '__proto__')).toBe(true)
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })

  test('processes recursive object and array disclosures with required ancestors', () => {
    const child = base64UrlEncodeJson(['0123456789abcdef', 'DE'])
    const childDigest = disclosureDigest(child)
    const parent = base64UrlEncodeJson([
      'fedcba9876543210',
      'nationalities',
      [{ '...': childDigest }]
    ])
    const parentDigest = disclosureDigest(parent)
    const payload = { _sd_alg: 'sha-256', _sd: [parentDigest] }

    const applied = applyDisclosures(payload, [parent, child])
    expect(applied.payload).toEqual({ nationalities: ['DE'] })
    expect(selectDisclosures(payload, [parent, child], ['nationalities.0'])).toEqual([
      parent,
      child
    ])
  })

  test('does not over-disclose a nested claim requested only by its short name', async () => {
    const credential = await issue()
    const parsed = parseSdJwt(credential.sdJwt)
    const payload = decodeJwt(parsed.issuerSignedJwt).payload
    expect(() => selectDisclosures(payload, parsed.disclosures, ['given_name'])).toThrow(
      'was not found'
    )
    expect(selectDisclosures(payload, parsed.disclosures, ['profile.given_name'])).toHaveLength(1)
  })

  test('verifies a credential before the Holder signs and binds the holder private key', async () => {
    const attacker = new PrivateKey(99)
    const untrustedJwt = signJwt(
      { typ: 'dc+sd-jwt', jwk: publicKeyToJwk(attacker.toPublicKey()) },
      {
        iss: 'https://attacker-selected.example',
        vct: credentialType,
        cnf: { jwk: publicKeyToJwk(holderPrivateKey.toPublicKey()) }
      },
      attacker
    )
    await expect(
      SdJwtVcHolder.generatePresentation(serializeSdJwt(untrustedJwt, []), [], {
        holderPrivateKey,
        audience: 'https://verifier.example',
        nonce: 'nonce-1'
      })
    ).rejects.toThrow('Credential verification failed')

    const credential = await issue()
    await expect(
      SdJwtVcHolder.generatePresentation(credential, ['role'], {
        holderPrivateKey: otherPrivateKey,
        audience: 'https://verifier.example',
        nonce: 'nonce-1'
      })
    ).rejects.toThrow('does not match credential cnf.jwk')
  })

  test('stores owned wire-derived credential state instead of caller metadata', async () => {
    const credential = await issue()
    credential.claims.role = 'administrator'
    SdJwtVcHolder.store(credential)
    const first = SdJwtVcHolder.getAll()[0]
    expect(first.claims.role).toBe('reader')
    first.claims.role = 'mutated'
    expect(SdJwtVcHolder.getAll()[0].claims.role).toBe('reader')
  })

  test('rejects duplicate JSON keys, invalid UTF-8, and ambiguous compact framing', () => {
    const duplicateHeader = base64UrlEncode('{"alg":"none","alg":"ES256K"}')
    const payload = base64UrlEncodeJson({})
    const signature = base64UrlEncode(new Uint8Array(64))
    expect(() => decodeJwt(`${duplicateHeader}.${payload}.${signature}`)).toThrow(
      'duplicate JSON key'
    )
    expect(() => base64UrlDecodeJson(base64UrlEncode([0xc3, 0x28]))).toThrow('valid UTF-8')
    expect(() => parseSdJwt(`${duplicateHeader}.${payload}.${signature}~~`)).toThrow(
      'invalid length'
    )
  })

  test('does not invoke option or claim accessors at a trust boundary', async () => {
    const credential = await issue()
    let invoked = 0
    const options = {}
    Object.defineProperty(options, 'expectedIssuer', {
      enumerable: true,
      get() {
        invoked += 1
        return issuerDid
      }
    })
    const result = await SdJwtVcVerifier.verify(credential.sdJwt, options as never)
    expect(result.verified).toBe(false)
    expect(invoked).toBe(0)

    const claims = {}
    Object.defineProperty(claims, 'role', {
      enumerable: true,
      get() {
        invoked += 1
        return 'administrator'
      }
    })
    await expect(
      SdJwtVcIssuer.create({
        issuer: issuerDid,
        issuerPrivateKey,
        holderPublicKey: holderPrivateKey.toPublicKey(),
        vct: credentialType,
        claims
      })
    ).rejects.toThrow('own data property')
    expect(invoked).toBe(0)
  })

  test('validates exact public JWK coordinates, purpose metadata, and private material', () => {
    const jwk = publicKeyToJwk(holderPrivateKey.toPublicKey())
    expect(jwkToPublicKey(jwk).toString()).toBe(holderPrivateKey.toPublicKey().toString())
    expect(() => jwkToPublicKey({ ...jwk, x: base64UrlEncode([1]) })).toThrow('32 bytes')
    expect(() => jwkToPublicKey({ ...jwk, use: 'enc' } as never)).toThrow('use')
    expect(() => jwkToPublicKey({ ...jwk, key_ops: ['sign'] } as never)).toThrow('key_ops')
    expect(() => jwkToPublicKey({ ...jwk, alg: 'none' } as never)).toThrow('algorithm')
    expect(() =>
      jwkToPublicKey({ ...jwk, d: base64UrlEncode(new Uint8Array(32)) } as never)
    ).toThrow('private material')
  })
})
