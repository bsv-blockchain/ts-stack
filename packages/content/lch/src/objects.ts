import { lchAssert } from './errors.js'
import { objectPreimage, toHex } from './hash.js'
import { brc77SignerIdentity } from './signatures.js'
import type {
  LCHObjectType,
  LCHSigner,
  LCHSignatureVerifier,
  LCHValue,
  SignedObject
} from './types.js'

export async function signObject<T extends Record<string, LCHValue>>(
  type: LCHObjectType,
  body: T,
  signer: LCHSigner
): Promise<SignedObject<T>> {
  return { body, signatures: [await signer.sign(objectPreimage(type, body))] }
}

export async function verifySignedObject(
  type: LCHObjectType,
  object: SignedObject,
  verifier: LCHSignatureVerifier,
  requiredSigner?: Uint8Array
): Promise<void> {
  lchAssert(object.signatures.length > 0, 'ERR_LCH_SIGNATURE', 'Signed object has no signatures')
  const preimage = objectPreimage(type, object.body)
  let matched = false
  for (const signature of object.signatures) {
    try {
      if (
        requiredSigner !== undefined &&
        toHex(brc77SignerIdentity(signature)) !== toHex(requiredSigner)
      )
        continue
      if (await verifier.verify(preimage, signature)) matched = true
    } catch {
      // A malformed co-signature is invalid, not fatal to another valid signature.
    }
  }
  lchAssert(matched, 'ERR_LCH_SIGNATURE', 'No valid signature from the required signer')
}

export { objectId, objectIri } from './hash.js'
