import PublicKey from '../primitives/PublicKey.js'
import Signature from '../primitives/Signature.js'
import { Reader, toHex, toUTF8Strict } from '../primitives/utils.js'
import type LockingScript from '../script/LockingScript.js'
import { decodeCanonicalPushDrop } from '../script/templates/PushDropValidation.js'
import ProtoWallet from '../wallet/ProtoWallet.js'
import type { WalletProtocol } from '../wallet/Wallet.interfaces.js'

export const UHRP_ADVERTISEMENT_PROTOCOL: WalletProtocol = [2, 'uhrp advertisement']
export const UHRP_ADVERTISEMENT_KEY_ID = '1'
export const MAX_UHRP_ADVERTISEMENT_URL_BYTES = 2048

export interface VerifiedUHRPAdvertisement {
  hostIdentityKey: string
  hash: number[]
  hostedFileLocation: string
  expiryTime: number
  fileSize: number
  lockingPublicKey: PublicKey
  signature: number[]
}

function readPositiveCompactSize(field: number[], name: string): number {
  const reader = new Reader(field)
  const value = reader.readVarIntNumStrict(false)
  if (!reader.eof() || value < 1 || !Number.isSafeInteger(value)) {
    throw new Error(`UHRP advertisement ${name} is invalid`)
  }
  return value
}

function equalBytes(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/** Decode and cryptographically authenticate one canonical UHRP advertisement. */
export async function decodeAndVerifyUHRPAdvertisement(
  lockingScript: LockingScript
): Promise<VerifiedUHRPAdvertisement> {
  const { fields, lockingPublicKey } = decodeCanonicalPushDrop(lockingScript, {
    fieldCount: 6,
    maximumFieldBytes: MAX_UHRP_ADVERTISEMENT_URL_BYTES,
    maximumPayloadBytes: MAX_UHRP_ADVERTISEMENT_URL_BYTES + 256
  })

  if (fields[0].length !== 33 || (fields[0][0] !== 2 && fields[0][0] !== 3)) {
    throw new Error('UHRP advertisement host identity key is invalid')
  }
  const hostIdentityKey = toHex(fields[0])
  const hostKey = PublicKey.fromString(hostIdentityKey)
  if (!equalBytes(hostKey.toDER() as number[], fields[0])) {
    throw new Error('UHRP advertisement host identity key is not canonical')
  }
  if (fields[1].length !== 32) throw new Error('UHRP advertisement hash is invalid')
  if (fields[2].length < 1 || fields[2].length > MAX_UHRP_ADVERTISEMENT_URL_BYTES) {
    throw new Error('UHRP advertisement URL is invalid')
  }
  const hostedFileLocation = toUTF8Strict(fields[2])
  if (/\p{Cc}/u.test(hostedFileLocation)) {
    throw new Error('UHRP advertisement URL contains control characters')
  }
  let location: URL
  try {
    location = new URL(hostedFileLocation)
  } catch {
    throw new Error('UHRP advertisement URL is invalid')
  }
  if (
    location.protocol !== 'https:' ||
    location.hostname.length === 0 ||
    location.username.length !== 0 ||
    location.password.length !== 0 ||
    location.hash.length !== 0
  ) {
    throw new Error('UHRP advertisement must use a credential-free HTTPS URL')
  }

  const expiryTime = readPositiveCompactSize(fields[3], 'expiry time')
  const fileSize = readPositiveCompactSize(fields[4], 'file size')
  if (fields[5].length < 8 || fields[5].length > 80) {
    throw new Error('UHRP advertisement signature is invalid')
  }
  const canonicalSignature = Signature.fromDER(fields[5]).toDER() as number[]
  if (!equalBytes(canonicalSignature, fields[5])) {
    throw new Error('UHRP advertisement signature is not canonical')
  }

  const anyoneWallet = new ProtoWallet('anyone')
  const { publicKey: expectedLockingKey } = await anyoneWallet.getPublicKey({
    counterparty: hostIdentityKey,
    protocolID: UHRP_ADVERTISEMENT_PROTOCOL,
    keyID: UHRP_ADVERTISEMENT_KEY_ID
  })
  if (expectedLockingKey.toLowerCase() !== lockingPublicKey.toString().toLowerCase()) {
    throw new Error('UHRP advertisement locking key is not linked to its host')
  }
  const { valid } = await anyoneWallet.verifySignature({
    data: fields.slice(0, 5).flat(),
    signature: fields[5],
    counterparty: hostIdentityKey,
    protocolID: UHRP_ADVERTISEMENT_PROTOCOL,
    keyID: UHRP_ADVERTISEMENT_KEY_ID
  })
  if (valid !== true) throw new Error('UHRP advertisement signature is invalid')

  return {
    hostIdentityKey,
    hash: [...fields[1]],
    hostedFileLocation,
    expiryTime,
    fileSize,
    lockingPublicKey,
    signature: [...fields[5]]
  }
}
