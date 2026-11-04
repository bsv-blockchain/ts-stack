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

/** Mirrors `CLOCK_SKEW_SECONDS` in the engine. */
const SKEW = 300n

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
    const before = BigInt(Math.floor(Date.now() / 1000))
    const minted = await engine.createKeyPackage({
      ciphersuite: 'MLS_128_DHKEMP256_AES128GCM_SHA256_P256',
      lifetimeSeconds: 60
    })
    const after = BigInt(Math.floor(Date.now() / 1000))

    expect(minted.ciphersuite).toBe('MLS_128_DHKEMP256_AES128GCM_SHA256_P256')
    // `lifetimeSeconds` is how far forward the package is good for; the window
    // reaches past that at both ends by the skew allowance, so an admitter
    // whose clock disagrees in either direction can still take it.
    expect(minted.lifetime.notAfter).toBeGreaterThanOrEqual(before + 60n + SKEW)
    expect(minted.lifetime.notAfter).toBeLessThanOrEqual(after + 60n + SKEW)
    expect(minted.lifetime.notBefore).toBeLessThan(before)
  })

  /**
   * The allowance has to be wider than the skew that was actually observed
   * between two devices, or the fix does not cover the case it was written
   * for. Nothing else in the suite would notice it being cut: every other
   * assertion is a direction rather than a distance.
   */
  it('covers a clock difference bigger than the one seen between two devices', async () => {
    const engine = await engineFor()
    const OBSERVED_DEVICE_SKEW = 162n

    const before = BigInt(Math.floor(Date.now() / 1000))
    const minted = await engine.createKeyPackage({ lifetimeSeconds: 60 })
    const after = BigInt(Math.floor(Date.now() / 1000))

    // An admitter that far behind us, and one that far ahead, both see a
    // package that is currently valid.
    expect(minted.lifetime.notBefore).toBeLessThanOrEqual(before - OBSERVED_DEVICE_SKEW)
    expect(minted.lifetime.notAfter).toBeGreaterThanOrEqual(after + OBSERVED_DEVICE_SKEW)
  })
})
