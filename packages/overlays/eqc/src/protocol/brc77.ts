import { PublicKey, Random, SignedMessage, Utils, type WalletInterface } from '@bsv/sdk'

const VERSION = [0x42, 0x42, 0x33, 0x01]
const SIGNER_END = VERSION.length + 33
const MINIMUM_LENGTH = SIGNER_END + 1 + 32 + 8

/**
 * Signs `message` under BRC-77 for verification by anyone, using only a `WalletInterface`.
 * `SignedMessage.sign` needs a raw private key; its derivation is BRC-42 with invoice
 * `2-message signing-<base64 keyID>` toward the "anyone" key, which `createSignature` reproduces.
 */
export async function signBRC77(
  wallet: WalletInterface,
  message: number[],
  originator?: string
): Promise<number[]> {
  const keyID = Random(32)
  const [{ signature }, { publicKey }] = await Promise.all([
    wallet.createSignature(
      {
        data: message,
        protocolID: [2, 'message signing'],
        keyID: Utils.toBase64(keyID),
        counterparty: 'anyone'
      },
      originator
    ),
    wallet.getPublicKey({ identityKey: true }, originator)
  ])
  return [...VERSION, ...Utils.toArray(publicKey, 'hex'), 0, ...keyID, ...signature]
}

/** Verifies an anyone-verifiable BRC-77 signature and reports the signer it names. */
export function verifyBRC77(
  message: number[],
  signature: number[]
): { valid: boolean; signer?: string } {
  if (signature.length < MINIMUM_LENGTH) return { valid: false }
  if (VERSION.some((byte, index) => signature[index] !== byte)) return { valid: false }
  const signer = Utils.toHex(signature.slice(VERSION.length, SIGNER_END))
  if (signature[SIGNER_END] !== 0) return { valid: false, signer }
  try {
    PublicKey.fromString(signer)
    return { valid: SignedMessage.verify(message, signature) === true, signer }
  } catch {
    return { valid: false, signer }
  }
}
