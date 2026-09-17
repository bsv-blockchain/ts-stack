import { ECDSA, BigNumber, Hash, KeyDeriver, PrivateKey, Signature } from '@bsv/sdk'
import { CredentialBindingError } from '../errors.js'
import { concat, fromHex, toHex, toNumbers, utf8 } from '../bytes.js'
import type { IdentityKey, MlsCiphersuiteName } from '../types.js'
import { GROUP_MESSAGING_PROTOCOL } from './protocol.js'

const VERSION = 1
const IDENTITY_KEY_BYTES = 33
const DOMAIN = 'bsv-group-messaging/credential/v1'

/**
 * The attested claim, as bytes.
 *
 * Domain-separated, and it binds the ciphersuite as well as the MLS signature
 * key so an attestation minted for one suite cannot be replayed into another.
 */
export const attestationPreimage = (
  ciphersuite: MlsCiphersuiteName,
  mlsSignaturePublicKey: Uint8Array
): Uint8Array =>
  concat(
    utf8(DOMAIN),
    new Uint8Array([0]),
    utf8(ciphersuite),
    new Uint8Array([0]),
    mlsSignaturePublicKey
  )

/**
 * The decoded contents of a `BasicCredential.identity` field.
 *
 * Everything needed to verify the binding travels inside the credential. That
 * matters because `ts-mls`'s `AuthenticationService.validateCredential` receives
 * only the credential and the MLS signature key — it has no access to the
 * bootstrap envelope the KeyPackage arrived in. A member who is added to a
 * group by somebody else never sees that envelope, so a binding proof carried
 * alongside the credential would go unverified by exactly the members who did
 * not do the adding.
 */
export interface CredentialIdentity {
  version: number
  identityKey: IdentityKey
  /** BRC-43 key ID the attestation was signed under. */
  keyId: string
  /** DER-encoded ECDSA signature over {@link attestationPreimage}. */
  signature: Uint8Array
}

/**
 * Encode a credential identity:
 *
 *   u8   version
 *   [33] compressed secp256k1 identity key
 *   u8   key ID length, then UTF-8 key ID
 *   u8   signature length, then DER signature
 */
export const encodeCredentialIdentity = (identity: CredentialIdentity): Uint8Array => {
  const keyId = utf8(identity.keyId)
  const key = fromHex(identity.identityKey)
  if (key.length !== IDENTITY_KEY_BYTES) {
    throw new CredentialBindingError(
      `Identity key must be ${IDENTITY_KEY_BYTES} compressed bytes, got ${key.length}`
    )
  }
  if (keyId.length > 255) throw new CredentialBindingError('Key ID exceeds 255 bytes')
  if (identity.signature.length > 255) {
    throw new CredentialBindingError('Signature exceeds 255 bytes')
  }
  return concat(
    new Uint8Array([identity.version]),
    key,
    new Uint8Array([keyId.length]),
    keyId,
    new Uint8Array([identity.signature.length]),
    identity.signature
  )
}

export const decodeCredentialIdentity = (bytes: Uint8Array): CredentialIdentity => {
  let offset = 0
  const need = (n: number): void => {
    if (offset + n > bytes.length) {
      throw new CredentialBindingError('Truncated credential identity')
    }
  }

  need(1)
  const version = bytes[offset++]!
  if (version !== VERSION) {
    throw new CredentialBindingError(`Unsupported credential version ${version}`)
  }

  need(IDENTITY_KEY_BYTES)
  const identityKey = toHex(bytes.subarray(offset, offset + IDENTITY_KEY_BYTES))
  offset += IDENTITY_KEY_BYTES

  need(1)
  const keyIdLength = bytes[offset++]!
  need(keyIdLength)
  const keyId = new TextDecoder().decode(bytes.subarray(offset, offset + keyIdLength))
  offset += keyIdLength

  need(1)
  const signatureLength = bytes[offset++]!
  need(signatureLength)
  const signature = bytes.slice(offset, offset + signatureLength)
  offset += signatureLength

  if (offset !== bytes.length) {
    throw new CredentialBindingError('Trailing bytes in credential identity')
  }
  return { version, identityKey, keyId, signature }
}

/** Mint a credential identity attesting that `identityKey` owns an MLS signature key. */
export const createCredentialIdentity = async (input: {
  /** Signs under the group-messaging protocol with counterparty "anyone". */
  sign: (data: Uint8Array) => Promise<Uint8Array>
  identityKey: IdentityKey
  keyId: string
  ciphersuite: MlsCiphersuiteName
  mlsSignaturePublicKey: Uint8Array
}): Promise<Uint8Array> => {
  const signature = await input.sign(
    attestationPreimage(input.ciphersuite, input.mlsSignaturePublicKey)
  )
  return encodeCredentialIdentity({
    version: VERSION,
    identityKey: input.identityKey,
    keyId: input.keyId,
    signature
  })
}

/**
 * The public key an attestation must verify against.
 *
 * BRC-42 derivation from the signer's identity key against the "anyone" root
 * (1·G), which is why any observer can compute it without a wallet and without
 * ever having spoken to the signer. Exposed so a reviewer can recompute it from
 * the `identityKey` and `keyId` printed beside a credential and check the
 * signature by hand.
 */
export const attestationPublicKey = (identityKey: IdentityKey, keyId: string) =>
  new KeyDeriver(new PrivateKey(1)).derivePublicKey(
    GROUP_MESSAGING_PROTOCOL,
    keyId,
    identityKey,
    false
  )

/**
 * Verify a credential identity against the MLS signature key it claims to bind.
 *
 * Deliberately wallet-free: it derives the signer's public key from the
 * "anyone" root (1·G), which any party can do. That keeps verification
 * synchronous, dependency-light, and usable inside an
 * `AuthenticationService` that has no wallet to call.
 */
export const verifyCredentialIdentity = (
  credentialIdentity: Uint8Array,
  mlsSignaturePublicKey: Uint8Array,
  ciphersuite: MlsCiphersuiteName
): CredentialIdentity => {
  const parsed = decodeCredentialIdentity(credentialIdentity)

  const attestationKey = attestationPublicKey(parsed.identityKey, parsed.keyId)

  const digest = Hash.sha256(toNumbers(attestationPreimage(ciphersuite, mlsSignaturePublicKey)))
  const valid = ECDSA.verify(
    new BigNumber(digest),
    Signature.fromDER(toNumbers(parsed.signature)),
    attestationKey
  )
  if (!valid) {
    throw new CredentialBindingError(
      `Credential for ${parsed.identityKey} does not attest to this MLS signature key`
    )
  }
  return parsed
}
