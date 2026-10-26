import BigNumber from '../primitives/BigNumber.js'
import { Writer, toArray } from '../primitives/utils.js'
import { sign as ECDSASign, verify as ECDSAVerify } from '../primitives/ECDSA.js'
import { hash256 } from '../primitives/Hash.js'
import PrivateKey from '../primitives/PrivateKey.js'
import PublicKey from '../primitives/PublicKey.js'
import Signature from '../primitives/Signature.js'
import { compatBytes } from './CompatValidation.js'

const prefix = 'Bitcoin Signed Message:\n'

/**
 * Internal implementation shared by the legacy BSM compatibility exports.
 */
const computeMagicHash = (messageBuf: number[]): number[] => {
  messageBuf = compatBytes(messageBuf, 'BSM message')
  const bw = new Writer()
  bw.writeVarIntNum(prefix.length)
  bw.write(toArray(prefix, 'utf8'))
  bw.writeVarIntNum(messageBuf.length)
  bw.write(messageBuf)
  const buf = bw.toArray()
  const hashBuf = hash256(buf)
  return hashBuf
}

/**
 * Generates a SHA256 double-hash of the prefixed message.
 * The legacy prefix carries no application audience, verifier, expiry, or challenge. Callers
 * must supply and enforce those semantics inside the signed bytes and reject replay.
 * @deprecated Replaced by BRC-77 which uses a more secure and private method for message signing.
 */
export const magicHash = (messageBuf: number[]): number[] => computeMagicHash(messageBuf)

/**
 * Signs a BSM message using the given private key.
 * This is a public, reusable-key signature and must not be treated as a fresh application command
 * unless the message itself commits to purpose, audience, challenge, and expiry.
 * @deprecated Replaced by BRC-77 which employs BRC-42 key derivation and BRC-43 invoice numbers for enhanced security and privacy.
 * @param message The message to be signed as a number array.
 * @param privateKey The private key used for signing the message.
 * @param mode The mode of operation. When "base64", the BSM format signature is returned. When "raw", a Signature object is returned. Default: "base64".
 * @returns The signature object when in raw mode, or the BSM base64 string when in base64 mode.
 */
export const sign = (
  message: number[],
  privateKey: PrivateKey,
  mode: 'raw' | 'base64' = 'base64'
): Signature | string => {
  if (mode !== 'raw' && mode !== 'base64') {
    throw new TypeError('BSM signature mode must be raw or base64')
  }
  const hashBuf = computeMagicHash(message)
  const sig = ECDSASign(new BigNumber(hashBuf), privateKey, true)
  if (mode === 'raw') {
    return sig
  }
  const h = new BigNumber(hashBuf)
  const r = sig.CalculateRecoveryFactor(privateKey.toPublicKey(), h)
  return sig.toCompact(r, true, 'base64') as string
}

/**
 * Verifies a BSM signed message using the given public key.
 * @deprecated Replaced by BRC-77 which provides privately-verifiable signatures and avoids key reuse.
 * @param message The message to be verified as a number array.
 * @param sig The signature object.
 * @param pubKey The public key for verification.
 * @returns True if the signature is valid, false otherwise.
 */
export const verify = (message: number[], sig: Signature, pubKey: PublicKey): boolean => {
  const hashBuf = computeMagicHash(message)
  return ECDSAVerify(new BigNumber(hashBuf), sig, pubKey) === true
}
