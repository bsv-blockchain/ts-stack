import { lchAssert } from './errors.js'
import { objectPreimage, toHex } from './hash.js'
import { brc77SignerIdentity } from './signatures.js'
import {
  ownDataValue,
  snapshotBytes,
  snapshotLCHRecord,
  snapshotSignedObject,
  snapshotStringSet
} from './boundary.js'
import type {
  LCHObjectType,
  LCHSigner,
  LCHSignatureVerifier,
  LCHValue,
  SignedObject
} from './types.js'

const MAX_SIGNATURES = 64
const MAX_SIGNATURE_BYTES = 4096
const VERSIONED_SIGNED_OBJECT_TYPES = new Set<LCHObjectType>([
  'authority',
  'offer',
  'license-request',
  'quote',
  'payment-demand',
  'payment-readiness',
  'payment-authorization',
  'payment-delivery',
  'payment-delivery-retrieval',
  'transaction-evidence',
  'payment-delivery-ack',
  'payment-receipt',
  'license'
])

export interface SignedObjectVerificationOptions {
  /** Critical extension identifiers whose semantics the caller implements. */
  supportedCriticalIdentifiers?: ReadonlySet<string>
}

export function validateCriticalIdentifiers(
  body: Record<string, LCHValue>,
  supported: ReadonlySet<string> = new Set()
): void {
  const critical = body.critical
  if (critical === undefined) return
  lchAssert(
    Array.isArray(critical) &&
      critical.length > 0 &&
      critical.length <= 64 &&
      critical.every(
        identifier =>
          typeof identifier === 'string' && identifier.length > 0 && identifier.length <= 2048
      ) &&
      new Set(critical).size === critical.length,
    'ERR_LCH_PROFILE_UNSUPPORTED',
    'Critical extension identifiers are invalid'
  )
  for (const identifier of critical) {
    lchAssert(
      typeof identifier === 'string',
      'ERR_LCH_PROFILE_UNSUPPORTED',
      'Critical extension identifier is invalid'
    )
    let absolute = false
    try {
      absolute = new URL(identifier).protocol.length > 1
    } catch {
      // The stable assertion below handles malformed identifiers.
    }
    lchAssert(
      absolute && supported.has(identifier),
      'ERR_LCH_PROFILE_UNSUPPORTED',
      `Critical extension is unsupported: ${identifier}`
    )
  }
}

export function validateExtensionIdentifiers(body: Record<string, LCHValue>): void {
  const extensions = body.extensions
  if (extensions === undefined) return
  lchAssert(
    extensions !== null &&
      typeof extensions === 'object' &&
      !Array.isArray(extensions) &&
      !(extensions instanceof Uint8Array) &&
      Object.keys(extensions).length <= 64,
    'ERR_LCH_PROFILE_UNSUPPORTED',
    'Extensions map is invalid'
  )
  for (const identifier of Object.keys(extensions)) {
    let absolute = false
    try {
      absolute = identifier.length <= 2048 && new URL(identifier).protocol.length > 1
    } catch {
      // The stable assertion below handles malformed identifiers.
    }
    lchAssert(
      absolute,
      'ERR_LCH_PROFILE_UNSUPPORTED',
      `Extension identifier is not absolute: ${identifier}`
    )
  }
}

export async function signObject<T extends Record<string, LCHValue>>(
  type: LCHObjectType,
  body: T,
  signer: LCHSigner
): Promise<SignedObject<T>> {
  const ownedBody = snapshotLCHRecord(body, `${type} body`) as T
  const signature = await signer.sign(objectPreimage(type, ownedBody))
  lchAssert(
    signature instanceof Uint8Array &&
      signature.length > 0 &&
      signature.length <= MAX_SIGNATURE_BYTES,
    'ERR_LCH_SIGNATURE',
    'Signer returned an invalid signature'
  )
  return { body: ownedBody, signatures: [snapshotBytes(signature, 'Signature')] }
}

export async function verifySignedObject(
  type: LCHObjectType,
  object: SignedObject,
  verifier: LCHSignatureVerifier,
  requiredSigner?: Uint8Array,
  options: SignedObjectVerificationOptions = {}
): Promise<void> {
  const owned = snapshotSignedObject(object)
  requiredSigner =
    requiredSigner === undefined ? undefined : snapshotBytes(requiredSigner, 'Required signer')
  const supported = snapshotStringSet(
    ownDataValue(options, 'supportedCriticalIdentifiers', 'Signed object verification options'),
    'supportedCriticalIdentifiers'
  )
  lchAssert(
    owned.signatures.length > 0 &&
      owned.signatures.length <= MAX_SIGNATURES &&
      owned.signatures.every(
        signature =>
          signature instanceof Uint8Array &&
          signature.length > 0 &&
          signature.length <= MAX_SIGNATURE_BYTES
      ),
    'ERR_LCH_SIGNATURE',
    'Signed object envelope or signatures are invalid'
  )
  if (VERSIONED_SIGNED_OBJECT_TYPES.has(type))
    lchAssert(owned.body.version === 1, 'ERR_LCH_PROFILE_UNSUPPORTED', 'Unsupported object version')
  validateExtensionIdentifiers(owned.body)
  validateCriticalIdentifiers(owned.body, supported)
  const preimage = objectPreimage(type, owned.body)
  let matched = false
  for (const signature of owned.signatures) {
    try {
      if (
        requiredSigner !== undefined &&
        toHex(brc77SignerIdentity(signature)) !== toHex(requiredSigner)
      )
        continue
      if ((await verifier.verify(preimage.slice(), signature.slice())) === true) matched = true
    } catch {
      // A malformed co-signature is invalid, not fatal to another valid signature.
    }
  }
  lchAssert(matched, 'ERR_LCH_SIGNATURE', 'No valid signature from the required signer')
}

export { objectId, objectIri } from './hash.js'
