import { ProtoWallet, type KeyDeriverApi, type PrivateKey, type WalletInterface } from '@bsv/sdk'
import { fromNumbers, toNumbers } from '../bytes.js'
import type { IdentityKey, MlsCiphersuiteName } from '../types.js'
import {
  createCredentialIdentity,
  verifyCredentialIdentity,
  type CredentialIdentity
} from './credential.js'
import { GROUP_MESSAGING_PROTOCOL, newCredentialKeyId } from './protocol.js'

/** The crypto subset of a BRC-100 wallet this library needs. */
export type WalletLike = Pick<WalletInterface, 'getPublicKey' | 'createSignature'>

/**
 * What callers may pass as `wallet`: a live BRC-100 wallet (`WalletClient`), a
 * local `KeyDeriver`, or a bare root `PrivateKey` for headless use.
 */
export type IdentityInput = IdentityService | WalletLike | KeyDeriverApi | PrivateKey

/**
 * Wallet identity, as the rest of the library sees it.
 *
 * Owns the BRC-42/43 details — which protocol ID, which counterparty, how a
 * credential is shaped — so nothing above it has to know them. MLS signature
 * keys are deliberately *not* wallet keys; this class only attests that a
 * wallet vouches for one.
 */
export class IdentityService {
  private constructor(
    readonly identityKey: IdentityKey,
    private readonly wallet: WalletLike
  ) {}

  /** Read the identity key from the wallet, which may prompt the user. */
  static async open(input: IdentityInput): Promise<IdentityService> {
    if (input instanceof IdentityService) return input
    const wallet = toWallet(input)
    const { publicKey } = await wallet.getPublicKey({ identityKey: true })
    return new IdentityService(publicKey, wallet)
  }

  /**
   * Sign under the group-messaging protocol with `counterparty: "anyone"`.
   *
   * "anyone" is load-bearing. BRC-42 derivation against the anyone key (1·G) is
   * computable by any observer from the signer's identity key alone, so the
   * result is publicly verifiable — which is what a credential attestation
   * needs, since every group member must be able to check every other member's
   * binding, including members they never spoke to.
   */
  async sign(keyId: string, data: Uint8Array): Promise<Uint8Array> {
    const { signature } = await this.wallet.createSignature({
      data: toNumbers(data),
      protocolID: GROUP_MESSAGING_PROTOCOL,
      keyID: keyId,
      counterparty: 'anyone'
    })
    return fromNumbers(signature)
  }

  /**
   * Mint the credential identity bytes that bind an MLS signature key to this
   * wallet. Returns the key ID too, since it identifies the KeyPackage for
   * rotation.
   */
  async createCredential(input: {
    ciphersuite: MlsCiphersuiteName
    mlsSignaturePublicKey: Uint8Array
    keyId?: string
  }): Promise<{ credential: Uint8Array; keyId: string }> {
    const keyId = input.keyId ?? newCredentialKeyId()
    const credential = await createCredentialIdentity({
      sign: async data => this.sign(keyId, data),
      identityKey: this.identityKey,
      keyId,
      ciphersuite: input.ciphersuite,
      mlsSignaturePublicKey: input.mlsSignaturePublicKey
    })
    return { credential, keyId }
  }

  /**
   * Check somebody else's credential. Static and wallet-free on purpose: this
   * runs inside the MLS engine's authentication hook, which has no wallet, and
   * needs to work for members this client has never contacted.
   */
  static verifyCredential(
    credential: Uint8Array,
    mlsSignaturePublicKey: Uint8Array,
    ciphersuite: MlsCiphersuiteName
  ): CredentialIdentity {
    return verifyCredentialIdentity(credential, mlsSignaturePublicKey, ciphersuite)
  }
}

const toWallet = (input: WalletLike | KeyDeriverApi | PrivateKey): WalletLike =>
  typeof (input as WalletLike).createSignature === 'function'
    ? (input as WalletLike)
    : new ProtoWallet(input as KeyDeriverApi | PrivateKey)
