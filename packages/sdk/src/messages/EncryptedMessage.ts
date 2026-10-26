import PublicKey from '../primitives/PublicKey.js'
import PrivateKey from '../primitives/PrivateKey.js'
import SymmetricKey from '../primitives/SymmetricKey.js'
import Random from '../primitives/Random.js'
import { toBase64, toArray, Reader, toHex } from '../primitives/utils.js'
import {
  copyMessageBytes,
  copyPrivateKey,
  copyPublicKey,
  MAX_ENCRYPTED_MESSAGE_BYTES,
  MIN_ENCRYPTED_MESSAGE_BYTES
} from './MessageValidation.js'

const VERSION = '42421033'

/**
 * Encrypts a message from one party to another using the BRC-78 message encryption protocol.
 * @param message The message to encrypt
 * @param sender The private key of the sender
 * @param recipient The public key of the recipient
 *
 * @returns The encrypted message
 */
/**
 * SECURITY NOTE – NON-AUTHENTICATED KEY EXCHANGE
 *
 * This encrypted message protocol does NOT implement a formally authenticated
 * key exchange (AKE). Session keys are deterministically derived from long-term
 * identity keys and a sender-chosen invoice value.
 *
 * As a result, this protocol does NOT provide:
 *  - Forward secrecy
 *  - Replay protection
 *  - Explicit authentication of peer identity
 *
 * This scheme SHOULD NOT be used for high-value, long-lived, or sensitive
 * communications. It is intended for lightweight messaging where both parties
 * already possess each other's long-term public keys and accept these risks.
 * Applications must bind their own purpose, challenge/message identifier, and
 * expiry into the plaintext and reject reuse. The helper accepts at most 16 MiB
 * and requires canonical SDK key instances and dense byte arrays.
 *
 * Future versions may introduce a protocol upgrade based on a standard AKE
 * (e.g. X3DH, Noise, or SIGMA).
 */
export const encrypt = (message: number[], sender: PrivateKey, recipient: PublicKey): number[] => {
  const plaintext = copyMessageBytes(message, 'Message')
  const senderKey = copyPrivateKey(sender, 'Sender')
  const recipientKey = copyPublicKey(recipient, 'Recipient')
  const keyID = Random(32)
  const keyIDBase64 = toBase64(keyID)
  const invoiceNumber = `2-message encryption-${keyIDBase64}`
  const signingPriv = senderKey.deriveChild(recipientKey, invoiceNumber)
  const recipientPub = recipientKey.deriveChild(senderKey, invoiceNumber)
  const sharedSecret = signingPriv.deriveSharedSecret(recipientPub)
  const symmetricKey = new SymmetricKey(sharedSecret.encode(true).slice(1))
  const encrypted = symmetricKey.encrypt(plaintext) as number[]
  const senderPublicKey = senderKey.toPublicKey().encode(true)
  const version = toArray(VERSION, 'hex')
  return version.concat(senderPublicKey, recipientKey.encode(true), keyID, encrypted)
}

/**
 * Decrypts a message from one party to another using the BRC-78 message encryption protocol.
 * @param message The message to decrypt
 * @param sender The private key of the recipient
 *
 * @returns The decrypted message
 *
 * Successful decryption authenticates the encrypted bytes but does not make a
 * replay fresh. Applications must validate and consume their embedded challenge
 * or message identifier exactly once.
 */
export const decrypt = (message: number[], recipient: PrivateKey): number[] => {
  const ciphertext = copyMessageBytes(
    message,
    'Encrypted message',
    MAX_ENCRYPTED_MESSAGE_BYTES,
    MIN_ENCRYPTED_MESSAGE_BYTES
  )
  const recipientKey = copyPrivateKey(recipient, 'Recipient')
  const reader = new Reader(ciphertext)
  const messageVersion = toHex(reader.read(4))
  if (messageVersion !== VERSION) {
    throw new Error(`Message version mismatch: Expected ${VERSION}, received ${messageVersion}`)
  }
  const sender = PublicKey.fromString(toHex(reader.read(33)))
  const expectedRecipientDER = toHex(reader.read(33))
  const actualRecipientDER = recipientKey.toPublicKey().encode(true, 'hex') as string
  if (expectedRecipientDER !== actualRecipientDER) {
    throw new Error(
      `The encrypted message expects a recipient public key of ${expectedRecipientDER}, but the provided key is ${actualRecipientDER}`
    )
  }
  const keyID = toBase64(reader.read(32))
  const encrypted = reader.read(reader.bin.length - reader.pos)
  const invoiceNumber = `2-message encryption-${keyID}`
  const signingPriv = sender.deriveChild(recipientKey, invoiceNumber)
  const recipientPub = recipientKey.deriveChild(sender, invoiceNumber)
  const sharedSecret = signingPriv.deriveSharedSecret(recipientPub)
  const symmetricKey = new SymmetricKey(sharedSecret.encode(true).slice(1))
  return symmetricKey.decrypt(encrypted) as number[]
}
