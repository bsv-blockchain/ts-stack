import { BigNumber, PrivateKey, PublicKey, Signature } from '@bsv/sdk/primitives'
import { sign as signECDSA, verify as verifyECDSA } from '@bsv/sdk/primitives/ECDSA'
import { hash256 } from '@bsv/sdk/primitives/Hash'
import { Writer, toArray, toBase64 } from '@bsv/sdk/primitives/utils'

const BSM_PREFIX = 'Bitcoin Signed Message:\n'

function bsmVarInt(n: number): number[] {
  return Writer.varIntNum(n)
}

function p2pMessageHash(message: string): BigNumber {
  const prefixBytes = toArray(BSM_PREFIX, 'utf8')
  const messageBytes = toArray(message, 'utf8')
  return new BigNumber(
    hash256([
      ...bsmVarInt(prefixBytes.length),
      ...prefixBytes,
      ...bsmVarInt(messageBytes.length),
      ...messageBytes
    ])
  )
}

export function createP2PSignature(message: string, privateKey: PrivateKey): string {
  const messageHash = p2pMessageHash(message)
  const signature = signECDSA(messageHash, privateKey, true)
  const recovery = signature.CalculateRecoveryFactor(privateKey.toPublicKey(), messageHash)
  return signature.toCompact(recovery, true, 'base64') as string
}

export interface P2PSignatureVerification {
  publicKeyMatches: boolean
  signatureValid: boolean
}

export function isCanonicalCompressedPublicKey(value: string): boolean {
  if (!/^(?:02|03)[0-9a-fA-F]{64}$/.test(value)) return false
  try {
    return PublicKey.fromString(value).toString() === value.toLowerCase()
  } catch {
    return false
  }
}

export function verifyP2PSignature(
  message: string,
  encodedSignature: string,
  expectedPublicKey: string
): P2PSignatureVerification {
  if (!/^[A-Za-z0-9+/]{87}=$/.test(encodedSignature)) {
    throw new Error('Invalid Compact Signature')
  }
  if (!isCanonicalCompressedPublicKey(expectedPublicKey)) {
    throw new Error('Invalid Public Key')
  }
  const compactBytes = toArray(encodedSignature, 'base64')
  const header = compactBytes[0]
  if (
    compactBytes.length !== 65 ||
    header === undefined ||
    toBase64(compactBytes) !== encodedSignature
  ) {
    throw new Error('Invalid Compact Signature')
  }

  const recovery = header - (header >= 31 ? 31 : 27)
  if (recovery < 0 || recovery > 3) {
    throw new Error('Invalid Compact Signature')
  }

  const signature = Signature.fromCompact(encodedSignature, 'base64')
  const messageHash = p2pMessageHash(message)
  const recoveredPublicKey = signature.RecoverPublicKey(recovery, messageHash)

  return {
    publicKeyMatches:
      recoveredPublicKey.toString().toLowerCase() === expectedPublicKey.toLowerCase(),
    signatureValid: verifyECDSA(messageHash, signature, recoveredPublicKey)
  }
}
