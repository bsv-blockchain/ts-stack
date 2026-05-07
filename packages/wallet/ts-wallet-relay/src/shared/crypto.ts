import type { WalletProtocol } from '@bsv/sdk'
import type { WalletLike } from '../types.js'
import { bytesToBase64url, base64urlToBytes } from './encoding.js'

export interface CryptoParams {
  protocolID: WalletProtocol
  keyID: string
  counterparty: string
}

/**
 * Encrypt a plaintext string and return a base64url ciphertext.
 * Works in Node.js, browsers, and React Native (no Buffer dependency).
 */
export async function encryptEnvelope(
  wallet: WalletLike,
  params: CryptoParams,
  payload: string
): Promise<string> {
  const plaintext = Array.from(new TextEncoder().encode(payload))
  const { ciphertext } = await wallet.encrypt({
    protocolID: params.protocolID,
    keyID: params.keyID,
    counterparty: params.counterparty,
    plaintext,
  })
  return bytesToBase64url(ciphertext)
}

/**
 * Decrypt a base64url ciphertext and return the plaintext string.
 * Works in Node.js, browsers, and React Native (no Buffer dependency).
 */
export async function decryptEnvelope(
  wallet: WalletLike,
  params: CryptoParams,
  ciphertextB64: string
): Promise<string> {
  const ciphertext = base64urlToBytes(ciphertextB64)
  const { plaintext } = await wallet.decrypt({
    protocolID: params.protocolID,
    keyID: params.keyID,
    counterparty: params.counterparty,
    ciphertext,
  })
  return new TextDecoder().decode(new Uint8Array(plaintext))
}
