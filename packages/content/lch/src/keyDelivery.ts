import { toBase64 } from '@bsv/sdk/primitives/utils'
import type { WalletInterface } from '@bsv/sdk/wallet/Wallet.interfaces'
import { LCH_LIMITS } from './constants.js'
import { lchAssert } from './errors.js'
import { concatBytes, fromHex, toHex } from './hash.js'
import { keyIdFor } from './encryption.js'
import { isCompressedPublicKey } from './signatures.js'
import { requiredOwnDataValue, snapshotBytes } from './boundary.js'
import { WalletBRC78KeyRecovery, walletBytes } from './keyRecovery.js'

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
    return new WalletBRC78KeyRecovery(this.wallet).recover(payload)
  }
}
