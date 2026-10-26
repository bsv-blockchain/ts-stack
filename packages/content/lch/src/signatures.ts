import { verify as verifySignedMessage } from '@bsv/sdk/messages/SignedMessage'
import PublicKey from '@bsv/sdk/primitives/PublicKey'
import { toBase64 } from '@bsv/sdk/primitives/utils'
import { LCH_SIGNING_PROTOCOL } from './constants.js'
import { lchAssert } from './errors.js'
import { concatBytes, fromHex, toBase64Url, toHex } from './hash.js'
import type { LCHSignatureVerifier, LCHSigner, WalletSignerOptions } from './types.js'
import { ownDataValue, requiredOwnDataValue, snapshotBytes } from './boundary.js'

const BRC77_VERSION = Uint8Array.of(0x42, 0x42, 0x33, 0x01)

export function isCompressedPublicKey(value: Uint8Array): boolean {
  if (value.length !== 33 || (value[0] !== 2 && value[0] !== 3)) return false
  try {
    PublicKey.fromString(toHex(value))
    return true
  } catch {
    return false
  }
}

function defaultRandom(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

export class WalletBRC77Signer implements LCHSigner {
  readonly identityKey: Uint8Array
  private readonly wallet: WalletSignerOptions['wallet']
  private readonly random: (length: number) => Uint8Array

  private constructor(
    identityKey: Uint8Array,
    wallet: WalletSignerOptions['wallet'],
    random: (length: number) => Uint8Array
  ) {
    this.identityKey = snapshotBytes(identityKey, 'Wallet identity key')
    this.wallet = {
      getPublicKey: wallet.getPublicKey.bind(wallet),
      createSignature: wallet.createSignature.bind(wallet)
    }
    this.random = random
  }

  static async create(options: WalletSignerOptions): Promise<WalletBRC77Signer> {
    const wallet = ownDataValue(options, 'wallet', 'Wallet signer options')
    const configuredIdentity = ownDataValue(options, 'identityKey', 'Wallet signer options')
    const random = ownDataValue(options, 'random', 'Wallet signer options')
    lchAssert(
      wallet !== null &&
        typeof wallet === 'object' &&
        typeof (wallet as WalletSignerOptions['wallet']).getPublicKey === 'function' &&
        typeof (wallet as WalletSignerOptions['wallet']).createSignature === 'function',
      'ERR_LCH_SIGNATURE',
      'Wallet signer wallet is invalid'
    )
    lchAssert(
      configuredIdentity === undefined || typeof configuredIdentity === 'string',
      'ERR_LCH_SIGNATURE',
      'Configured wallet identity key is invalid'
    )
    lchAssert(
      random === undefined || typeof random === 'function',
      'ERR_LCH_SIGNATURE',
      'Signature random source is invalid'
    )
    const identity =
      configuredIdentity ??
      requiredOwnDataValue(
        await (wallet as WalletSignerOptions['wallet']).getPublicKey({ identityKey: true }),
        'publicKey',
        'Wallet getPublicKey result'
      )
    lchAssert(typeof identity === 'string', 'ERR_LCH_SIGNATURE', 'Wallet identity key is invalid')
    const identityKey = fromHex(identity)
    lchAssert(
      isCompressedPublicKey(identityKey),
      'ERR_LCH_SIGNATURE',
      'Wallet identity key must be a valid compressed public key'
    )
    return new WalletBRC77Signer(
      identityKey,
      wallet as WalletSignerOptions['wallet'],
      (random as ((length: number) => Uint8Array) | undefined) ?? defaultRandom
    )
  }

  async sign(preimage: Uint8Array): Promise<Uint8Array> {
    const returnedKeyId = this.random(32)
    lchAssert(
      returnedKeyId instanceof Uint8Array && returnedKeyId.length === 32,
      'ERR_LCH_SIGNATURE',
      'Signature random source returned invalid key ID'
    )
    const keyId = snapshotBytes(returnedKeyId, 'Signature Key ID')
    const signature = requiredOwnDataValue(
      await this.wallet.createSignature({
        data: Array.from(preimage),
        protocolID: [...LCH_SIGNING_PROTOCOL],
        keyID: toBase64(Array.from(keyId)),
        counterparty: 'anyone'
      }),
      'signature',
      'Wallet createSignature result'
    )
    lchAssert(
      Array.isArray(signature) &&
        signature.length > 0 &&
        signature.length <= 1024 &&
        signature.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255),
      'ERR_LCH_SIGNATURE',
      'Wallet returned an invalid signature byte array'
    )
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
      return verifySignedMessage(Array.from(preimage), Array.from(signature))
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
  const identity = signature.slice(4, 37)
  lchAssert(
    isCompressedPublicKey(identity),
    'ERR_LCH_SIGNATURE',
    'BRC-77 signer identity is not a valid compressed public key'
  )
  return identity
}

export function brc78KeyId(keyId: Uint8Array): string {
  lchAssert(keyId.length === 32, 'ERR_LCH_KEY', 'BRC-78 Key ID must contain 32 bytes')
  return toBase64Url(keyId)
}
