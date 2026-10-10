import { toBase64 } from '@bsv/sdk/primitives/utils'
import type { WalletInterface } from '@bsv/sdk/wallet/Wallet.interfaces'
import { LCHError, lchAssert } from './errors.js'
import { fromHex, toHex } from './hash.js'
import { keyIdFor } from './encryption.js'
import { isCompressedPublicKey } from './signatures.js'
import { requiredOwnDataValue, snapshotBytes } from './boundary.js'

const BRC78_VERSION = Uint8Array.of(0x42, 0x42, 0x10, 0x33)
const ENCRYPTION_PROTOCOL = [2, 'message encryption'] as const
const MAX_BRC78_PAYLOAD_BYTES = 64 * 1024

/** Internal recipient-only owner; it holds no encryption or delivery capability. */
export class WalletBRC78KeyRecovery {
  private readonly wallet: Pick<WalletInterface, 'getPublicKey' | 'decrypt'>
  constructor(wallet: Pick<WalletInterface, 'getPublicKey' | 'decrypt'>) {
    this.wallet = {
      getPublicKey: wallet.getPublicKey.bind(wallet),
      decrypt: wallet.decrypt.bind(wallet)
    }
  }
  async recover(payload: Uint8Array): Promise<{ keyId: Uint8Array; cek: Uint8Array }> {
    lchAssert(
      payload instanceof Uint8Array &&
        payload.length > 102 &&
        payload.length <= MAX_BRC78_PAYLOAD_BYTES,
      'ERR_LCH_KEY',
      'BRC-78 payload is truncated or oversized'
    )
    payload = snapshotBytes(payload, 'BRC-78 payload')
    lchAssert(
      BRC78_VERSION.every((byte, index) => payload[index] === byte),
      'ERR_LCH_KEY',
      'Invalid BRC-78 version'
    )
    const sender = payload.slice(4, 37)
    const recipient = payload.slice(37, 70)
    const identityValue = requiredOwnDataValue(
      await this.wallet.getPublicKey({ identityKey: true }),
      'publicKey',
      'Wallet getPublicKey result'
    )
    lchAssert(typeof identityValue === 'string', 'ERR_LCH_KEY', 'Wallet identity key is invalid')
    const identity = fromHex(identityValue)
    lchAssert(
      isCompressedPublicKey(sender) &&
        isCompressedPublicKey(recipient) &&
        isCompressedPublicKey(identity) &&
        toHex(recipient) === toHex(identity),
      'ERR_LCH_KEY',
      'BRC-78 payload identity binding is invalid'
    )
    const messageKeyId = payload.slice(70, 102)
    let plaintext: unknown
    try {
      plaintext = requiredOwnDataValue(
        await this.wallet.decrypt({
          ciphertext: Array.from(payload.slice(102)),
          protocolID: [...ENCRYPTION_PROTOCOL],
          keyID: toBase64(Array.from(messageKeyId)),
          counterparty: toHex(sender)
        }),
        'plaintext',
        'Wallet decrypt result'
      )
    } catch (error) {
      throw new LCHError('ERR_LCH_KEY', 'BRC-78 key recovery failed', { cause: error })
    }
    const recovered = walletBytes(plaintext, 64, 'decrypted key payload', 64)
    const keyId = recovered.slice(0, 32)
    const cek = recovered.slice(32)
    lchAssert(
      toHex(await keyIdFor(cek)) === toHex(keyId),
      'ERR_LCH_KEY',
      'Recovered CEK does not match Key ID'
    )
    return { keyId, cek }
  }
}

export function walletBytes(
  value: unknown,
  maximum: number,
  name: string,
  exactLength?: number
): Uint8Array {
  lchAssert(
    Array.isArray(value) &&
      value.length > 0 &&
      value.length <= maximum &&
      (exactLength === undefined || value.length === exactLength) &&
      value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255),
    'ERR_LCH_KEY',
    `Wallet returned an invalid ${name}`
  )
  return Uint8Array.from(value)
}
