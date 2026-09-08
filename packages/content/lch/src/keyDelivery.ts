import { Utils, type WalletInterface } from '@bsv/sdk'
import { LCHError, lchAssert } from './errors.js'
import { concatBytes, fromHex, toHex } from './hash.js'
import { keyIdFor } from './encryption.js'

const BRC78_VERSION = Uint8Array.of(0x42, 0x42, 0x10, 0x33)
const ENCRYPTION_PROTOCOL = [2, 'message encryption'] as const

function secureRandom(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

export class WalletBRC78KeyDelivery {
  private readonly issuedMessageKeyIds = new Set<string>()

  constructor(
    private readonly wallet: Pick<WalletInterface, 'getPublicKey' | 'encrypt' | 'decrypt'>,
    private readonly random: (length: number) => Uint8Array = secureRandom
  ) {}

  async deliver(recipient: string, keyId: Uint8Array, cek: Uint8Array): Promise<Uint8Array> {
    lchAssert(
      keyId.length === 32 && cek.length === 32,
      'ERR_LCH_KEY',
      'Key ID and CEK must contain 32 bytes'
    )
    lchAssert(
      toHex(await keyIdFor(cek)) === toHex(keyId),
      'ERR_LCH_KEY',
      'CEK does not match Key ID'
    )
    const sender = fromHex((await this.wallet.getPublicKey({ identityKey: true })).publicKey)
    const recipientBytes = fromHex(recipient)
    lchAssert(
      recipientBytes.length === 33,
      'ERR_LCH_KEY',
      'Recipient identity key must be compressed'
    )
    const messageKeyId = this.random(32)
    lchAssert(
      messageKeyId.length === 32,
      'ERR_LCH_KEY',
      'Random source returned invalid BRC-78 Key ID'
    )
    const messageKeyIdHex = toHex(messageKeyId)
    lchAssert(
      !this.issuedMessageKeyIds.has(messageKeyIdHex),
      'ERR_LCH_KEY',
      'Random source reused a BRC-78 message Key ID'
    )
    this.issuedMessageKeyIds.add(messageKeyIdHex)
    const { ciphertext } = await this.wallet.encrypt({
      plaintext: Array.from(concatBytes(keyId, cek)),
      protocolID: [...ENCRYPTION_PROTOCOL],
      keyID: Utils.toBase64(Array.from(messageKeyId)),
      counterparty: recipient
    })
    return concatBytes(
      BRC78_VERSION,
      sender,
      recipientBytes,
      messageKeyId,
      Uint8Array.from(ciphertext)
    )
  }

  async recover(payload: Uint8Array): Promise<{ keyId: Uint8Array; cek: Uint8Array }> {
    lchAssert(payload.length > 102, 'ERR_LCH_KEY', 'Truncated BRC-78 payload')
    lchAssert(
      BRC78_VERSION.every((byte, index) => payload[index] === byte),
      'ERR_LCH_KEY',
      'Invalid BRC-78 version'
    )
    const sender = payload.slice(4, 37)
    const recipient = payload.slice(37, 70)
    const identity = fromHex((await this.wallet.getPublicKey({ identityKey: true })).publicKey)
    lchAssert(
      toHex(recipient) === toHex(identity),
      'ERR_LCH_KEY',
      'BRC-78 payload is addressed to another identity'
    )
    const messageKeyId = payload.slice(70, 102)
    let plaintext: number[]
    try {
      ;({ plaintext } = await this.wallet.decrypt({
        ciphertext: Array.from(payload.slice(102)),
        protocolID: [...ENCRYPTION_PROTOCOL],
        keyID: Utils.toBase64(Array.from(messageKeyId)),
        counterparty: toHex(sender)
      }))
    } catch (error) {
      throw new LCHError('ERR_LCH_KEY', 'BRC-78 key recovery failed', { cause: error })
    }
    lchAssert(
      plaintext.length === 64,
      'ERR_LCH_KEY',
      'BRC-78 LCH plaintext must contain Key ID and CEK'
    )
    const keyId = Uint8Array.from(plaintext.slice(0, 32))
    const cek = Uint8Array.from(plaintext.slice(32))
    lchAssert(
      toHex(await keyIdFor(cek)) === toHex(keyId),
      'ERR_LCH_KEY',
      'Recovered CEK does not match Key ID'
    )
    return { keyId, cek }
  }
}
