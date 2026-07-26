import { BigNumber, ECDSA, Hash, PrivateKey, Signature, Utils } from '@bsv/sdk'

const BSM_PREFIX = 'Bitcoin Signed Message:\n'

function bsmVarInt(n: number): number[] {
  return Utils.Writer.varIntNum(n)
}

function p2pMessageHash(message: string): BigNumber {
  const prefixBytes = Utils.toArray(BSM_PREFIX, 'utf8')
  const messageBytes = Utils.toArray(message, 'utf8')
  return new BigNumber(
    Hash.hash256([
      ...bsmVarInt(prefixBytes.length),
      ...prefixBytes,
      ...bsmVarInt(messageBytes.length),
      ...messageBytes
    ])
  )
}

export function createP2PSignature(message: string, privateKey: PrivateKey): string {
  const messageHash = p2pMessageHash(message)
  const signature = ECDSA.sign(messageHash, privateKey, true)
  const recovery = signature.CalculateRecoveryFactor(privateKey.toPublicKey(), messageHash)
  return signature.toCompact(recovery, true, 'base64') as string
}

export interface P2PSignatureVerification {
  publicKeyMatches: boolean
  signatureValid: boolean
}

export function verifyP2PSignature(
  message: string,
  encodedSignature: string,
  expectedPublicKey: string
): P2PSignatureVerification {
  const compactBytes = Utils.toArray(encodedSignature, 'base64')
  const header = compactBytes[0]
  if (compactBytes.length !== 65 || header === undefined) {
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
    publicKeyMatches: recoveredPublicKey.toString() === expectedPublicKey,
    signatureValid: ECDSA.verify(messageHash, signature, recoveredPublicKey)
  }
}
