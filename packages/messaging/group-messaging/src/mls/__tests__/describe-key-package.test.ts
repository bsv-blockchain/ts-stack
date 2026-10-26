import { BigNumber, ECDSA, Hash, KeyDeriver, PrivateKey, PublicKey, Signature } from '@bsv/sdk'
import { defaultCapabilities, generateKeyPackageWithKey } from 'ts-mls'
import { decodeKeyPackage, encodeKeyPackage } from 'ts-mls/keyPackage.js'
import { describe, expect, it } from 'vitest'
import { fromHex } from '../../bytes.js'
import { attestationPreimage, attestationPublicKey, IdentityService } from '../../identity/index.js'
import { DEFAULT_CIPHERSUITE } from '../../types.js'
import { resolveCiphersuite } from '../ciphersuite.js'
import { MlsEngine } from '../engine.js'
import { asKeyPackageBytes } from '../key-package-codec.js'

const newEngine = async () =>
  new MlsEngine({ identity: await IdentityService.open(new KeyDeriver(PrivateKey.fromRandom())) })

/** Bob's KeyPackage, re-labelled with a credential naming Mallory over his leaf key. */
const relabelled = async (bob: MlsEngine, mallory: MlsEngine) => {
  const keyPackage = decodeKeyPackage((await bob.createKeyPackage()).keyPackage, 0)![0]
  const { credential } = await mallory.identity.createCredential({
    ciphersuite: DEFAULT_CIPHERSUITE,
    mlsSignaturePublicKey: keyPackage.leafNode.signaturePublicKey
  })
  return asKeyPackageBytes(
    encodeKeyPackage({
      ...keyPackage,
      leafNode: {
        ...keyPackage.leafNode,
        credential: { credentialType: 'basic' as const, identity: credential }
      }
    })
  )
}

describe('describeKeyPackage', () => {
  it('reports what the bytes say, and passes no judgment on them', async () => {
    const engine = await newEngine()
    const minted = await engine.createKeyPackage()

    const described = await engine.describeKeyPackage(minted.keyPackage)

    expect(described.ref).toBe(minted.ref)
    expect(described.ciphersuite).toBe(DEFAULT_CIPHERSUITE)
    expect(described.leafNode?.credential.identityKey).toBe(engine.identity.identityKey)
    expect(described.leafNode?.credential.keyId).toBe(minted.keyId)
    expect(described.leafNode?.credential.version).toBe(1)
    expect(described.error).toBeUndefined()

    // No verdict fields anywhere: a description is facts, and nothing else.
    const json = JSON.stringify(described)
    expect(json).not.toMatch(/valid|verified/i)
  })

  it('carries every signature in the KeyPackage, as bytes rather than as a verdict', async () => {
    const engine = await newEngine()
    const described = await engine.describeKeyPackage((await engine.createKeyPackage()).keyPackage)

    expect(described.signature).toMatch(/^[0-9a-f]+$/)
    expect(described.leafNode?.signature).toMatch(/^[0-9a-f]+$/)
    expect(described.leafNode?.credential.signature).toMatch(/^[0-9a-f]+$/)
    expect(described.initKey).toMatch(/^[0-9a-f]+$/)
    expect(described.leafNode?.encryptionKey).toMatch(/^[0-9a-f]+$/)
    expect(described.leafNode?.leafNodeSource).toBe('key_package')
  })

  it('advertises only the basic credential type', async () => {
    const engine = await newEngine()
    const described = await engine.describeKeyPackage((await engine.createKeyPackage()).keyPackage)
    expect(described.leafNode?.capabilities.credentials).toEqual(['basic'])
  })

  /**
   * A description is the same shape whoever minted it. The re-labelled
   * KeyPackage below is one MLS refuses, and it still describes cleanly — which
   * is the point of the split: `verifyKeyPackage` is where it fails.
   */
  it('describes a re-labelled KeyPackage without complaint', async () => {
    const bob = await newEngine()
    const mallory = await newEngine()

    const described = await bob.describeKeyPackage(await relabelled(bob, mallory))

    expect(described.error).toBeUndefined()
    expect(described.leafNode?.credential.identityKey).toBe(mallory.identity.identityKey)
    expect(described.leafNode?.credential.signature).toBeDefined()
  })

  it('keeps the raw credential when it is not in our format', async () => {
    const engine = await newEngine()
    const suite = await resolveCiphersuite(DEFAULT_CIPHERSUITE)
    const keyPair = await suite.signature.keygen()
    const notBefore = BigInt(Math.floor(Date.now() / 1000))
    const { publicPackage } = await generateKeyPackageWithKey(
      { credentialType: 'basic', identity: Uint8Array.from([1, 2, 3]) },
      defaultCapabilities(),
      { notBefore, notAfter: notBefore + 3600n },
      [],
      keyPair,
      suite
    )

    const described = await engine.describeKeyPackage(
      asKeyPackageBytes(encodeKeyPackage(publicPackage))
    )

    expect(described.error).toBeUndefined()
    expect(described.leafNode?.credential.identity).toBe('010203')
    expect(described.leafNode?.credential.identityKey).toBeUndefined()
  })

  /**
   * `notBefore` and `notAfter` are u64s straight off the wire, so a hostile
   * KeyPackage can carry seconds no `Date` can represent. That must cost the
   * lifetime field, and nothing else.
   */
  it('describes a KeyPackage whose lifetime is beyond any representable date', async () => {
    const engine = await newEngine()
    const keyPackage = decodeKeyPackage((await engine.createKeyPackage()).keyPackage, 0)![0]
    const outOfRange = asKeyPackageBytes(
      encodeKeyPackage({
        ...keyPackage,
        leafNode: {
          ...keyPackage.leafNode,
          lifetime: { notBefore: 2n ** 62n, notAfter: 2n ** 63n }
        }
      })
    )

    const described = await engine.describeKeyPackage(outOfRange)

    expect(described.error).toBeUndefined()
    expect(described.ref).toMatch(/^[0-9a-f]+$/)
    expect(described.leafNode?.credential.identityKey).toBe(engine.identity.identityKey)
    expect(described.leafNode?.lifetime.notBefore).toBe('unparseable')
    expect(described.leafNode?.lifetime.notAfter).toBe('unparseable')
  })

  it('returns an error for bytes that are not a KeyPackage at all', async () => {
    const engine = await newEngine()
    const described = await engine.describeKeyPackage(asKeyPackageBytes(Uint8Array.from([1, 2, 3])))

    expect(described.error).toBeDefined()
    expect(described.leafNode).toBeUndefined()
  })

  /**
   * The description prints the wallet's signature; the preimage and the key it
   * verifies against are derivable from other printed fields. This test is the
   * skeptical reviewer: it recomputes both and checks the signature using only
   * what a description carries.
   */
  it('carries enough for a reviewer to verify the wallet signature themselves', async () => {
    const engine = await newEngine()
    const described = await engine.describeKeyPackage((await engine.createKeyPackage()).keyPackage)
    const credential = described.leafNode!.credential

    const preimage = attestationPreimage(
      described.ciphersuite!,
      fromHex(described.leafNode!.signaturePublicKey)
    )
    const verified = ECDSA.verify(
      new BigNumber(Hash.sha256([...preimage])),
      Signature.fromDER([...fromHex(credential.signature!)]),
      PublicKey.fromString(
        attestationPublicKey(credential.identityKey!, credential.keyId!).toString()
      )
    )

    expect(verified).toBe(true)
  })
})

describe('verifyKeyPackage', () => {
  it('passes every check on a KeyPackage the engine minted', async () => {
    const engine = await newEngine()
    const verdict = await engine.verifyKeyPackage((await engine.createKeyPackage()).keyPackage)

    expect(verdict).toEqual({
      credentialBinding: true,
      leafSignature: true,
      keyPackageSignature: true,
      declaredCiphersuite: DEFAULT_CIPHERSUITE
    })
  })

  /**
   * The attestation binds an identity to an MLS signature key and nothing else,
   * and anyone may attest to a public key they did not generate — so the
   * credential on a re-labelled KeyPackage genuinely verifies. The leaf
   * signature is what refuses it, and the two verdicts have to be separable to
   * show that.
   */
  it('separates a credential that verifies from a leaf signature that does not', async () => {
    const bob = await newEngine()
    const mallory = await newEngine()

    const verdict = await bob.verifyKeyPackage(await relabelled(bob, mallory))

    expect(verdict.credentialBinding).toBe(true)
    expect(verdict.leafSignature).toBe(false)
    expect(verdict.keyPackageSignature).toBe(false)
    expect(verdict.error).toBeUndefined()
  })

  it('fails the leaf signature when the lifetime has been extended', async () => {
    const engine = await newEngine()
    const keyPackage = decodeKeyPackage((await engine.createKeyPackage()).keyPackage, 0)![0]
    const extended = asKeyPackageBytes(
      encodeKeyPackage({
        ...keyPackage,
        leafNode: {
          ...keyPackage.leafNode,
          lifetime: {
            ...keyPackage.leafNode.lifetime,
            notAfter: keyPackage.leafNode.lifetime.notAfter + 86400n * 3650n
          }
        }
      })
    )

    const verdict = await engine.verifyKeyPackage(extended)

    expect(verdict.credentialBinding).toBe(true)
    expect(verdict.leafSignature).toBe(false)
  })

  it('fails the binding when the credential attests to a different key', async () => {
    const engine = await newEngine()
    const suite = await resolveCiphersuite(DEFAULT_CIPHERSUITE)

    const attested = await suite.signature.keygen()
    const { credential } = await engine.identity.createCredential({
      ciphersuite: DEFAULT_CIPHERSUITE,
      mlsSignaturePublicKey: attested.publicKey
    })
    const leafKeyPair = await suite.signature.keygen()
    const notBefore = BigInt(Math.floor(Date.now() / 1000))
    const { publicPackage } = await generateKeyPackageWithKey(
      { credentialType: 'basic', identity: credential },
      defaultCapabilities(),
      { notBefore, notAfter: notBefore + 3600n },
      [],
      leafKeyPair,
      suite
    )

    const verdict = await engine.verifyKeyPackage(
      asKeyPackageBytes(encodeKeyPackage(publicPackage))
    )

    // The leaf signed itself honestly; only the attestation points elsewhere.
    expect(verdict.credentialBinding).toBe(false)
    expect(verdict.leafSignature).toBe(true)
  })

  it('reports an error rather than throwing on bytes that do not decode', async () => {
    const engine = await newEngine()
    const verdict = await engine.verifyKeyPackage(asKeyPackageBytes(Uint8Array.from([9, 9, 9])))

    expect(verdict.error).toBeDefined()
    expect(verdict.credentialBinding).toBe(false)
    expect(verdict.leafSignature).toBe(false)
    expect(verdict.keyPackageSignature).toBe(false)
  })
})

describe('verifyKeyPackage judges under its own ciphersuite', () => {
  /**
   * `mls/state.ts` states the rule: the suite must be the caller's configured
   * one, never a value read out of the thing being judged. A credential does
   * not get to choose the authority that validates it, and `credentialBinding`
   * reads as a verdict to anyone rendering it.
   */
  it('refuses to vouch for a credential attested under a suite this engine does not serve', async () => {
    const identity = await IdentityService.open(new KeyDeriver(PrivateKey.fromRandom()))
    const p256 = new MlsEngine({
      identity,
      ciphersuite: 'MLS_128_DHKEMP256_AES128GCM_SHA256_P256'
    })
    const minted = await p256.createKeyPackage()

    const verdict = await new MlsEngine({ identity }).verifyKeyPackage(minted.keyPackage)

    expect(verdict.credentialBinding).toBe(false)
    expect(verdict.declaredCiphersuite).toBe('MLS_128_DHKEMP256_AES128GCM_SHA256_P256')
    // The signatures are still judged under the suite the artifact was built
    // with, so they must pass: without this the test would also accept having
    // wrongly moved them to this engine's suite, where they would silently
    // catch to false.
    expect(verdict.leafSignature).toBe(true)
    expect(verdict.keyPackageSignature).toBe(true)
  })
})

describe('verifyKeyPackage reports a suite it cannot resolve', () => {
  /**
   * The declared suite is attacker-controlled and only two are supported, so
   * an unresolvable one is reachable. The name is the one fact that explains
   * the failure, and dropping it on the error path loses it exactly then.
   */
  it("names the declared suite rather than leaking the backend's error", async () => {
    const engine = await newEngine()
    const minted = await engine.createKeyPackage()
    const bytes = Uint8Array.from(minted.keyPackage)
    // cipherSuite is a u16 at the head of a KeyPackage, after the u16 version.
    bytes[2] = 0xff
    bytes[3] = 0xff

    const verdict = await engine.verifyKeyPackage(bytes as typeof minted.keyPackage)

    expect(verdict.credentialBinding).toBe(false)
    expect(verdict.declaredCiphersuite).toBeDefined()
    // Pinned, not matched: `/ciphersuite/i` also matches parseKeyPackage's
    // message, so a loose assertion could pass for the wrong reason.
    expect(verdict.error).toBe('Unsupported ciphersuite 65535')
  })
})

describe('verifyKeyPackage rejects a suite this library does not serve', () => {
  /**
   * A real RFC suite ts-mls can build but this library does not offer. Before
   * the gate it resolved, so the verdict was `credentialBinding: false` with no
   * error at all — indistinguishable from a forged credential.
   */
  it('names it unsupported rather than judging it', async () => {
    const engine = await newEngine()
    const minted = await engine.createKeyPackage()
    const bytes = Uint8Array.from(minted.keyPackage)
    // 0x0003 = MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519
    bytes[2] = 0x00
    bytes[3] = 0x03

    const verdict = await engine.verifyKeyPackage(bytes as typeof minted.keyPackage)

    expect(verdict.error).toMatch(/^Unsupported ciphersuite /)
    expect(verdict.declaredCiphersuite).toBeDefined()
  })
})
