import { toBase64 } from '@bsv/sdk/primitives/utils'
import type { WalletInterface } from '@bsv/sdk/wallet/Wallet.interfaces'
import { LCH_LIMITS } from './constants.js'
import { concatBytes, fromHex, toHex } from './hash.js'
import { keyIdFor } from './encryption.js'
import { isCompressedPublicKey } from './signatures.js'
import { requiredOwnDataValue, snapshotBytes } from './boundary.js'
import {
  assertKey,
  BRC78_VERSION,
  ENCRYPTION_PROTOCOL,
  MAX_BRC78_PAYLOAD_BYTES,
  WalletBRC78KeyRecovery,
  walletBytes,
  walletIdentity
} from './keyRecovery.js'

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
    assertKey(keyId.length === 32 && cek.length === 32, 'Key ID and CEK must contain 32 bytes')
    keyId = snapshotBytes(keyId, 'Key ID')
    cek = snapshotBytes(cek, 'CEK')
    assertKey(toHex(await keyIdFor(cek)) === toHex(keyId), 'CEK does not match Key ID')
    const sender = await walletIdentity(this.wallet)
    const recipientBytes = fromHex(recipient)
    assertKey(
      isCompressedPublicKey(sender) && isCompressedPublicKey(recipientBytes),
      'Sender and recipient identities must be valid compressed public keys'
    )
    const returnedMessageKeyId = this.random(32)
    assertKey(
      returnedMessageKeyId instanceof Uint8Array && returnedMessageKeyId.length === 32,
      'Random source returned invalid BRC-78 Key ID'
    )
    const messageKeyId = snapshotBytes(returnedMessageKeyId, 'BRC-78 Key ID')
    const messageKeyIdHex = toHex(messageKeyId)
    assertKey(
      this.issuedMessageKeyIds.size < LCH_LIMITS.cborEntries &&
        !this.issuedMessageKeyIds.has(messageKeyIdHex),
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
