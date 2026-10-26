import { toBase64 } from '@bsv/sdk/primitives/utils'
import type { WalletInterface } from '@bsv/sdk/wallet/Wallet.interfaces'
import { LCH_LIMITS } from './constants.js'
import { LCHError, lchAssert } from './errors.js'
import { concatBytes, fromHex, toHex } from './hash.js'
import { keyIdFor } from './encryption.js'
import { isCompressedPublicKey } from './signatures.js'
import { requiredOwnDataValue, snapshotBytes } from './boundary.js'

const BRC78_VERSION = Uint8Array.of(0x42, 0x42, 0x10, 0x33)
const ENCRYPTION_PROTOCOL = [2, 'message encryption'] as const
const MAX_BRC78_PAYLOAD_BYTES = 64 * 1024

function secureRandom(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

export class WalletBRC78KeyDelivery {
  private readonly issuedMessageKeyIds = new Set<string>()
  private readonly wallet: Pick<WalletInterface, 'getPublicKey' | 'encrypt' | 'decrypt'>
  private readonly random: (length: number) => Uint8Array

  constructor(
    wallet: Pick<WalletInterface, 'getPublicKey' | 'encrypt' | 'decrypt'>,
    random: (length: number) => Uint8Array = secureRandom
  ) {
    this.wallet = {
      getPublicKey: wallet.getPublicKey.bind(wallet),
      encrypt: wallet.encrypt.bind(wallet),
      decrypt: wallet.decrypt.bind(wallet)
    }
    this.random = random
  }

  async deliver(recipient: string, keyId: Uint8Array, cek: Uint8Array): Promise<Uint8Array> {
    lchAssert(
      keyId.length === 32 && cek.length === 32,
      'ERR_LCH_KEY',
      'Key ID and CEK must contain 32 bytes'
    )
    keyId = snapshotBytes(keyId, 'Key ID')
    cek = snapshotBytes(cek, 'CEK')
    lchAssert(
      toHex(await keyIdFor(cek)) === toHex(keyId),
      'ERR_LCH_KEY',
      'CEK does not match Key ID'
    )
    const senderValue = requiredOwnDataValue(
      await this.wallet.getPublicKey({ identityKey: true }),
      'publicKey',
      'Wallet getPublicKey result'
    )
    lchAssert(typeof senderValue === 'string', 'ERR_LCH_KEY', 'Wallet identity key is invalid')
    const sender = fromHex(senderValue)
    const recipientBytes = fromHex(recipient)
    lchAssert(
      isCompressedPublicKey(sender) && isCompressedPublicKey(recipientBytes),
      'ERR_LCH_KEY',
      'Sender and recipient identities must be valid compressed public keys'
    )
    const returnedMessageKeyId = this.random(32)
    lchAssert(
      returnedMessageKeyId instanceof Uint8Array && returnedMessageKeyId.length === 32,
      'ERR_LCH_KEY',
      'Random source returned invalid BRC-78 Key ID'
    )
    const messageKeyId = snapshotBytes(returnedMessageKeyId, 'BRC-78 Key ID')
    const messageKeyIdHex = toHex(messageKeyId)
    lchAssert(
      this.issuedMessageKeyIds.size < LCH_LIMITS.cborEntries &&
        !this.issuedMessageKeyIds.has(messageKeyIdHex),
      'ERR_LCH_KEY',
      'BRC-78 Key ID detector is exhausted or the random source reused an ID'
    )
    this.issuedMessageKeyIds.add(messageKeyIdHex)
    const encrypted = await this.wallet.encrypt({
      plaintext: Array.from(concatBytes(keyId, cek)),
      protocolID: [...ENCRYPTION_PROTOCOL],
      keyID: toBase64(Array.from(messageKeyId)),
      counterparty: recipient
    })
    const ciphertext = walletBytes(
      requiredOwnDataValue(encrypted, 'ciphertext', 'Wallet encrypt result'),
      MAX_BRC78_PAYLOAD_BYTES - 102,
      'encrypted key payload'
    )
    return concatBytes(BRC78_VERSION, sender, recipientBytes, messageKeyId, ciphertext)
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

function walletBytes(
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
