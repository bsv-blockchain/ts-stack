import { SignedMessage, Utils } from '@bsv/sdk'
import { LCH_SIGNING_PROTOCOL } from './constants.js'
import { lchAssert } from './errors.js'
import { concatBytes, fromHex, toBase64Url } from './hash.js'
import type { LCHSignatureVerifier, LCHSigner, WalletSignerOptions } from './types.js'

const BRC77_VERSION = Uint8Array.of(0x42, 0x42, 0x33, 0x01)

function defaultRandom(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

export class WalletBRC77Signer implements LCHSigner {
  readonly identityKey: Uint8Array

  private constructor(
    identityKey: Uint8Array,
    private readonly options: WalletSignerOptions
  ) {
    this.identityKey = identityKey
  }

  static async create(options: WalletSignerOptions): Promise<WalletBRC77Signer> {
    const identity =
      options.identityKey ?? (await options.wallet.getPublicKey({ identityKey: true })).publicKey
    const identityKey = fromHex(identity)
    lchAssert(
      identityKey.length === 33,
      'ERR_LCH_SIGNATURE',
      'Wallet identity key must be compressed'
    )
    return new WalletBRC77Signer(identityKey, options)
  }

  async sign(preimage: Uint8Array): Promise<Uint8Array> {
    const keyId = (this.options.random ?? defaultRandom)(32)
    lchAssert(
      keyId.length === 32,
      'ERR_LCH_SIGNATURE',
      'Signature random source returned invalid key ID'
    )
    const { signature } = await this.options.wallet.createSignature({
      data: Array.from(preimage),
      protocolID: [...LCH_SIGNING_PROTOCOL],
      keyID: Utils.toBase64(Array.from(keyId)),
      counterparty: 'anyone'
    })
    return concatBytes(
      BRC77_VERSION,
      this.identityKey,
      Uint8Array.of(0),
      keyId,
      Uint8Array.from(signature)
    )
  }
}

export class PublicBRC77Verifier implements LCHSignatureVerifier {
  async verify(preimage: Uint8Array, signature: Uint8Array): Promise<boolean> {
    try {
      return SignedMessage.verify(Array.from(preimage), Array.from(signature))
    } catch {
      return false
    }
  }
}

export function brc77SignerIdentity(signature: Uint8Array): Uint8Array {
  lchAssert(signature.length >= 70, 'ERR_LCH_SIGNATURE', 'Truncated BRC-77 signature')
  lchAssert(
    BRC77_VERSION.every((byte, index) => signature[index] === byte),
    'ERR_LCH_SIGNATURE',
    'Invalid BRC-77 version'
  )
  return signature.slice(4, 37)
}

export function brc78KeyId(keyId: Uint8Array): string {
  lchAssert(keyId.length === 32, 'ERR_LCH_KEY', 'BRC-78 Key ID must contain 32 bytes')
  return toBase64Url(keyId)
}
