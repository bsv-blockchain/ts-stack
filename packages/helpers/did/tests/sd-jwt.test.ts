import { PrivateKey } from '@bsv/sdk'
import {
  BsvDid,
  SdJwtVcHolder,
  SdJwtVcIssuer,
  SdJwtVcPresenter,
  SdJwtVcVerifier,
  applyDisclosures,
  decodeJwt,
  generateQrCode,
  parseSdJwt,
  publicKeyToJwk
} from '../src/index.js'

describe('SD-JWT VC', () => {
  const issuerPrivateKey = PrivateKey.fromHex('0000000000000000000000000000000000000000000000000000000000000001')
  const holderPrivateKey = PrivateKey.fromHex('0000000000000000000000000000000000000000000000000000000000000002')
  const issuerDid = BsvDid.fromPublicKey(issuerPrivateKey.toPublicKey().toDER() as number[])

  test('issues an SD-JWT VC with holder cnf key and salted disclosures', async () => {
    const credential = await SdJwtVcIssuer.create({
      issuer: issuerDid,
      issuerPrivateKey,
      holderPublicKey: holderPrivateKey.toPublicKey(),
      vct: 'https://credentials.example.com/identity_credential',
      claims: {
        given_name: 'Alice',
        family_name: 'Ng',
        is_over_21: true
      },
      disclosureFrame: {
        given_name: true,
        is_over_21: true
      },
      issuedAt: 1770000000
    })
    const parsed = parseSdJwt(credential.sdJwt)
    const payload = decodeJwt(parsed.issuerSignedJwt).payload

    expect(parsed.disclosures).toHaveLength(2)
    expect(payload.given_name).toBeUndefined()
    expect(payload.family_name).toBe('Ng')
    expect(payload.cnf).toEqual({ jwk: publicKeyToJwk(holderPrivateKey.toPublicKey()) })
    expect(payload._sd).toHaveLength(2)
    expect(payload._sd_alg).toBe('sha-256')
  })

  test('generates a selective presentation and verifies issuer and key binding signatures', async () => {
    const credential = await SdJwtVcIssuer.create({
      issuer: issuerDid,
      issuerPrivateKey,
      holderPublicKey: holderPrivateKey.toPublicKey(),
      vct: 'https://credentials.example.com/identity_credential',
      claims: {
        given_name: 'Alice',
        family_name: 'Ng',
        email: 'alice@example.com',
        is_over_21: true
      },
      disclosureFrame: {
        given_name: true,
        email: true,
        is_over_21: true
      },
      issuedAt: 1770000000
    })
    const presentation = await SdJwtVcHolder.generatePresentation(
      credential,
      ['given_name', 'is_over_21'],
      {
        holderPrivateKey,
        audience: 'https://verifier.example',
        nonce: 'nonce-123',
        issuedAt: 1770000100
      }
    )
    const wirePayload = SdJwtVcPresenter.present(presentation)
    const result = await SdJwtVcVerifier.verify(wirePayload, {
      expectedAudience: 'https://verifier.example',
      expectedNonce: 'nonce-123',
      requireKeyBinding: true
    })

    expect(result.verified).toBe(true)
    expect(result.issuerSignedJwtVerified).toBe(true)
    expect(result.keyBindingVerified).toBe(true)
    expect(result.disclosedClaims).toEqual({
      given_name: 'Alice',
      is_over_21: true
    })
    expect(result.payload?.given_name).toBe('Alice')
    expect(result.payload?.is_over_21).toBe(true)
    expect(result.payload?.email).toBeUndefined()
    expect(result.payload?.family_name).toBe('Ng')
  })

  test('rejects tampered disclosures', async () => {
    const credential = await SdJwtVcIssuer.create({
      issuer: issuerDid,
      issuerPrivateKey,
      holderPublicKey: holderPrivateKey.toPublicKey(),
      vct: 'https://credentials.example.com/identity_credential',
      claims: {
        given_name: 'Alice'
      },
      disclosureFrame: {
        given_name: true
      },
      issuedAt: 1770000000
    })
    const parsed = parseSdJwt(credential.sdJwt)

    expect(() => applyDisclosures(decodeJwt(parsed.issuerSignedJwt).payload, ['bad-disclosure'])).toThrow()
  })

  test('protects registered SD-JWT VC metadata and JOSE headers', async () => {
    await expect(SdJwtVcIssuer.create({
      issuer: issuerDid,
      issuerPrivateKey,
      holderPublicKey: holderPrivateKey.toPublicKey(),
      vct: 'https://credentials.example.com/identity_credential',
      claims: {
        vct: 'https://attacker.example.com/other'
      }
    })).rejects.toThrow('managed by SD-JWT VC metadata')

    const credential = await SdJwtVcIssuer.create({
      issuer: issuerDid,
      issuerPrivateKey,
      holderPublicKey: holderPrivateKey.toPublicKey(),
      vct: 'https://credentials.example.com/identity_credential',
      claims: {
        given_name: 'Alice'
      },
      header: {
        alg: 'none',
        typ: 'bad+jwt'
      }
    })
    const header = decodeJwt(parseSdJwt(credential.sdJwt).issuerSignedJwt).header

    expect(header.alg).toBe('ES256K')
    expect(header.typ).toBe('dc+sd-jwt')
  })

  test('rejects unsupported SD-JWT hash algorithms', () => {
    expect(() => applyDisclosures({ _sd_alg: 'sha-512' }, [])).toThrow('Unsupported SD-JWT hash algorithm')
  })

  test('generates SVG QR codes for DID and VC display modes', async () => {
    const credential = await SdJwtVcIssuer.create({
      issuer: issuerDid,
      issuerPrivateKey,
      holderPublicKey: holderPrivateKey.toPublicKey(),
      vct: 'https://credentials.example.com/identity_credential',
      claims: {
        given_name: 'Alice'
      }
    })
    const didSvg = generateQrCode(issuerDid, 'did')
    const vcSvg = generateQrCode(credential.sdJwt, 'vc')

    expect(didSvg).toContain('<svg')
    expect(vcSvg).toContain('<rect')
  })
})
