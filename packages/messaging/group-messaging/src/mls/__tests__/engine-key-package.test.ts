import { KeyDeriver, PrivateKey } from '@bsv/sdk'
import { decodeKeyPackage } from 'ts-mls/keyPackage.js'
import { describe, expect, it } from 'vitest'
import { IdentityService } from '../../identity/index.js'
import { DEFAULT_CIPHERSUITE } from '../../types.js'
import { MlsEngine } from '../engine.js'
import { decodePrivateKeyPackage } from '../key-package-codec.js'

const engineFor = async () =>
  new MlsEngine({
    identity: await IdentityService.open(new KeyDeriver(PrivateKey.fromRandom()))
  })

describe('MlsEngine.createKeyPackage', () => {
  it('returns a decodable RFC 9420 KeyPackage', async () => {
    const engine = await engineFor()
    const minted = await engine.createKeyPackage()

    const decoded = decodeKeyPackage(minted.keyPackage, 0)
    expect(decoded).toBeDefined()
    expect(decoded![0].cipherSuite).toBe(DEFAULT_CIPHERSUITE)
  })

  it("binds the credential to the leaf's signature key", async () => {
    const engine = await engineFor()
    const minted = await engine.createKeyPackage()
    const [keyPackage] = decodeKeyPackage(minted.keyPackage, 0)!

    expect(keyPackage.leafNode.credential.credentialType).toBe('basic')
    const parsed = IdentityService.verifyCredential(
      (keyPackage.leafNode.credential as { identity: Uint8Array }).identity,
      keyPackage.leafNode.signaturePublicKey,
      DEFAULT_CIPHERSUITE
    )
    expect(parsed.identityKey).toBe(engine.identity.identityKey)
    expect(parsed.keyId).toBe(minted.keyId)
  })

  it('returns three private keys the library does not keep', async () => {
    const engine = await engineFor()
    const minted = await engine.createKeyPackage()

    const parts = decodePrivateKeyPackage(minted.privateKeyPackage)
    expect(parts.initPrivateKey.length).toBeGreaterThan(0)
    expect(parts.hpkePrivateKey.length).toBeGreaterThan(0)
    expect(parts.signaturePrivateKey.length).toBeGreaterThan(0)
  })

  it('gives every KeyPackage its own ref and key ID', async () => {
    const engine = await engineFor()
    const first = await engine.createKeyPackage()
    const second = await engine.createKeyPackage()

    expect(first.ref).not.toBe(second.ref)
    expect(first.keyId).not.toBe(second.keyId)
    expect(first.ref).toMatch(/^[0-9a-f]+$/)
  })

  it('honours an explicit ciphersuite and lifetime', async () => {
    const engine = await engineFor()
    const minted = await engine.createKeyPackage({
      ciphersuite: 'MLS_128_DHKEMP256_AES128GCM_SHA256_P256',
      lifetimeSeconds: 60
    })

    expect(minted.ciphersuite).toBe('MLS_128_DHKEMP256_AES128GCM_SHA256_P256')
    expect(minted.lifetime.notAfter - minted.lifetime.notBefore).toBe(60n)
  })
})
