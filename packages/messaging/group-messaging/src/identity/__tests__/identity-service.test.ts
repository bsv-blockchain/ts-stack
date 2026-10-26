import { KeyDeriver, PrivateKey, ProtoWallet } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { CredentialBindingError } from '../../errors.js'
import { DEFAULT_CIPHERSUITE } from '../../types.js'
import { decodeCredentialIdentity } from '../credential.js'
import { IdentityService } from '../identity-service.js'
import { GROUP_MESSAGING_PROTOCOL } from '../protocol.js'

const aliceRoot = PrivateKey.fromRandom()
const mlsSignatureKey = new Uint8Array(32).fill(7)

const openAlice = async (): Promise<IdentityService> =>
  IdentityService.open(new KeyDeriver(aliceRoot))

const mint = async (identity: IdentityService, mlsKey = mlsSignatureKey) =>
  identity.createCredential({
    ciphersuite: DEFAULT_CIPHERSUITE,
    mlsSignaturePublicKey: mlsKey
  })

describe('IdentityService.open', () => {
  it('accepts a KeyDeriver', async () => {
    const identity = await openAlice()
    expect(identity.identityKey).toBe(aliceRoot.toPublicKey().toString())
  })

  it('accepts a bare PrivateKey', async () => {
    const identity = await IdentityService.open(aliceRoot)
    expect(identity.identityKey).toBe(aliceRoot.toPublicKey().toString())
  })

  it('accepts a wallet and passes an existing service through', async () => {
    const fromWallet = await IdentityService.open(new ProtoWallet(aliceRoot))
    expect(fromWallet.identityKey).toBe(aliceRoot.toPublicKey().toString())
    expect(await IdentityService.open(fromWallet)).toBe(fromWallet)
  })
})

describe('BRC-43 protocol ID', () => {
  it("is accepted by the SDK's protocol name validation", async () => {
    const wallet = new ProtoWallet(aliceRoot)
    await expect(
      wallet.createSignature({
        data: [1, 2, 3],
        protocolID: GROUP_MESSAGING_PROTOCOL,
        keyID: 'x',
        counterparty: 'anyone'
      })
    ).resolves.toBeDefined()
  })

  it('rejects the hyphenated name the spec suggested', async () => {
    const wallet = new ProtoWallet(aliceRoot)
    await expect(
      wallet.createSignature({
        data: [1, 2, 3],
        protocolID: [2, 'group-messaging'],
        keyID: 'x',
        counterparty: 'anyone'
      })
    ).rejects.toThrow(/letters, numbers and spaces/)
  })
})

describe('credential binding', () => {
  it('round-trips through encode and decode', async () => {
    const identity = await openAlice()
    const { credential, keyId } = await mint(identity)

    const parsed = decodeCredentialIdentity(credential)
    expect(parsed.version).toBe(1)
    expect(parsed.identityKey).toBe(identity.identityKey)
    expect(parsed.keyId).toBe(keyId)
    expect(parsed.signature.length).toBeGreaterThan(0)
  })

  it('gives each KeyPackage its own key ID, for rotation', async () => {
    const identity = await openAlice()
    const first = await mint(identity)
    const second = await mint(identity)
    expect(first.keyId).not.toBe(second.keyId)
  })

  it('verifies with no wallet, from the identity key alone', async () => {
    const identity = await openAlice()
    const { credential } = await mint(identity)

    const parsed = IdentityService.verifyCredential(
      credential,
      mlsSignatureKey,
      DEFAULT_CIPHERSUITE
    )
    expect(parsed.identityKey).toBe(identity.identityKey)
  })

  it('rejects a credential bound to a different MLS signature key', async () => {
    const { credential } = await mint(await openAlice())
    expect(() =>
      IdentityService.verifyCredential(credential, new Uint8Array(32).fill(9), DEFAULT_CIPHERSUITE)
    ).toThrow(CredentialBindingError)
  })

  it('rejects a credential replayed into a different ciphersuite', async () => {
    const { credential } = await mint(await openAlice())
    expect(() =>
      IdentityService.verifyCredential(
        credential,
        mlsSignatureKey,
        'MLS_128_DHKEMP256_AES128GCM_SHA256_P256'
      )
    ).toThrow(CredentialBindingError)
  })

  it("rejects an impersonator who swaps in someone else's identity key", async () => {
    const alice = await openAlice()
    const mallory = await IdentityService.open(PrivateKey.fromRandom())
    const forged = Uint8Array.from((await mint(mallory)).credential)

    // Mallory keeps her own signature over her own MLS key but claims Alice's
    // identity. The attestation key derives from the *claimed* identity, so
    // this is exactly the check that catches her.
    forged.set(
      alice.identityKey.match(/../g)!.map(byte => Number.parseInt(byte, 16)),
      1
    )

    expect(() =>
      IdentityService.verifyCredential(forged, mlsSignatureKey, DEFAULT_CIPHERSUITE)
    ).toThrow(CredentialBindingError)
  })

  it('rejects truncated credential bytes', async () => {
    const { credential } = await mint(await openAlice())
    expect(() => decodeCredentialIdentity(credential.slice(0, 10))).toThrow(CredentialBindingError)
  })
})
