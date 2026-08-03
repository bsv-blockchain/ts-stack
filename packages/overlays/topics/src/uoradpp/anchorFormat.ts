import { CachedKeyDeriver, LockingScript, ProtoWallet, PublicKey, PushDrop, Utils } from '@bsv/sdk'
import type { WalletProtocol } from '@bsv/sdk'

/**
 * Reading and validating a `uora-anchor-v2` output.
 *
 * The format is specified independently of this implementation; this file is a
 * reader for it, written so the topic manager and the lookup service cannot
 * disagree about what an anchor is.
 */

/** Marks the output as this format and versions the field layout. */
export const UORA_ANCHOR_PREFIX = 'uora-anchor-v2'

/**
 * The BRC-42 child the output is locked under, with the attestation id as key
 * id and counterparty `anyone`.
 *
 * Counterparty `anyone` is the whole design. The shared secret is ECDH(1, P),
 * so a third party holding only the anchoring service's public identity key can
 * reproduce the locking key, and producing an output that matches needs the
 * private half. That is what makes an anchor attributable to a named service by
 * anybody, rather than only by the service itself.
 *
 * The key id being the attestation id rather than a constant means every anchor
 * locks to a different key, so anchors by one service are not linkable to each
 * other by inspection, while each remains linkable to that service by anyone
 * who asks. That trade is deliberate.
 */
export const UORA_ANCHOR_PROTOCOL: WalletProtocol = [1, 'uora anchor v2']

/** Fields before the signature `PushDrop.lock` appends. */
export const UORA_ANCHOR_FIELD_COUNT = 7

/**
 * Bounds on the free-text fields. An overlay admits from whoever can reach it,
 * and an index keyed on a field a stranger controls is a field a stranger can
 * make expensive. Generous enough that no honest value approaches them: a GS1
 * Digital Link with a long serial is under 200 characters.
 */
const MAX_ATTESTATION_ID = 256
const MAX_SUBJECT = 512
const MAX_TYPE = 64

const HEX_64 = /^[0-9a-f]{64}$/
const COMPRESSED_KEY = /^0[23][0-9a-f]{64}$/

/** Multicodec prefix for a compressed secp256k1 public key: varint 0xe7. */
const SECP256K1_PUB_MULTICODEC = [0xe7, 0x01]
const DID_KEY_PREFIX = 'did:key:z'

const anyone = new CachedKeyDeriver('anyone')

/** One anchor, fully read and fully checked. */
export interface UoraAnchor {
  digest: string
  attestationId: string
  issuer: string
  issuerKey: string
  subject: string
  uoraType: string
  anchoredBy: string
}

/**
 * The compressed secp256k1 key inside a `did:key`, or undefined.
 *
 * Refuses another curve rather than returning bytes that would fail later: an
 * Ed25519 `did:key` is well formed and a meaningless secp256k1 key, and the
 * difference is two bytes at the front. Also refuses a non-canonical encoding,
 * because the SDK reduces `x >= p` rather than rejecting it and would otherwise
 * hand back a key that indexes under a DID nobody else computes.
 */
export function identityKeyFromDidKey(did: string): string | undefined {
  if (!did.startsWith(DID_KEY_PREFIX)) return undefined
  let bytes: number[]
  try {
    bytes = Utils.fromBase58(did.slice(DID_KEY_PREFIX.length))
  } catch {
    return undefined
  }
  if (bytes[0] !== SECP256K1_PUB_MULTICODEC[0] || bytes[1] !== SECP256K1_PUB_MULTICODEC[1]) {
    return undefined
  }
  const key = bytes.slice(2)
  if (key.length !== 33) return undefined
  const hex = Utils.toHex(key)
  return canonicalKey(hex) ? hex : undefined
}

/** The inverse, so a writer and a reader cannot drift on the encoding. */
export function didKeyFromIdentityKey(identityKeyHex: string): string {
  if (!canonicalKey(identityKeyHex)) throw new Error('not a canonical compressed public key')
  const key = PublicKey.fromString(identityKeyHex)
  return `${DID_KEY_PREFIX}${Utils.toBase58([
    ...SECP256K1_PUB_MULTICODEC,
    ...(key.encode(true) as number[])
  ])}`
}

function canonicalKey(hex: string): boolean {
  if (!COMPRESSED_KEY.test(hex)) return false
  try {
    return PublicKey.fromString(hex).toString() === hex
  } catch {
    return false
  }
}

/** The key an anchor for this attestation id must lock to, given the service. */
export function expectedLockingKey(anchorServiceKey: string, attestationId: string): string {
  return anyone.derivePublicKey(UORA_ANCHOR_PROTOCOL, attestationId, anchorServiceKey).toString()
}

/** UTF-8 that round-trips, so a field that is not text is not read as text. */
function text(bytes: number[]): string | undefined {
  let decoded: string
  try {
    decoded = Utils.toUTF8(bytes)
  } catch {
    return undefined
  }
  if (decoded === '') return undefined
  return Utils.toHex(Utils.toArray(decoded, 'utf8')) === Utils.toHex(bytes) ? decoded : undefined
}

/**
 * Read and validate one output, or throw.
 *
 * Throwing rather than returning undefined so it composes with
 * `identifyPushDropOutputs`, whose `validateOutput` reports the reason it
 * rejected each output. Every message names what was wrong, because an operator
 * reading a log wants to know whether a submission was malformed or simply not
 * this format.
 *
 * `PushDrop.decode` is safe here specifically because no field may be empty:
 * the decoder renders an empty push as a single zero byte, which would make the
 * signature preimage one byte too long, and this format rejects empty fields
 * before that can matter.
 */
export function readUoraAnchor(lockingScript: LockingScript): {
  anchor: UoraAnchor
  fields: number[][]
  lockingPublicKey: PublicKey
} {
  const { fields, lockingPublicKey } = PushDrop.decode(lockingScript)
  if (fields.length !== UORA_ANCHOR_FIELD_COUNT + 1) {
    throw new Error(
      `expected ${UORA_ANCHOR_FIELD_COUNT} fields and a signature, found ${fields.length}`
    )
  }

  const parts = fields.slice(0, UORA_ANCHOR_FIELD_COUNT).map(field => text(field))
  if (parts.includes(undefined)) throw new Error('a field is empty or not UTF-8')
  const [prefix, digest, attestationId, issuer, subject, uoraType, anchoredBy] = parts as string[]

  if (prefix !== UORA_ANCHOR_PREFIX) throw new Error(`not an anchor output (prefix "${prefix}")`)
  if (!HEX_64.test(digest)) throw new Error('the digest is not 64 lower-case hex characters')
  if (attestationId.length > MAX_ATTESTATION_ID) throw new Error('the attestation id is too long')
  if (subject.length > MAX_SUBJECT) throw new Error('the subject is too long')
  if (uoraType.length > MAX_TYPE) throw new Error('the attestation type is too long')

  const issuerKey = identityKeyFromDidKey(issuer)
  if (issuerKey === undefined) throw new Error('the issuer is not a secp256k1 did:key')

  if (!canonicalKey(anchoredBy)) {
    throw new Error('the anchoring service is not a canonical compressed key')
  }
  /*
   * The attribution check, and it is part of being well formed rather than a
   * policy on top of it. An output naming an anchoring service its locking key
   * cannot derive from is claiming something untrue about itself. Producing one
   * that passes needs that service's private key, which is the entire proof.
   */
  if (expectedLockingKey(anchoredBy, attestationId) !== lockingPublicKey.toString()) {
    throw new Error('the locking key is not derived from the anchoring service named in field 6')
  }

  return {
    anchor: { digest, attestationId, issuer, issuerKey, subject, uoraType, anchoredBy },
    fields,
    lockingPublicKey
  }
}

/**
 * The appended signature, checked against the service the output names.
 *
 * Separate from `readUoraAnchor` because it is the only asynchronous step and
 * the only one the lookup service does not need: by the time an output is being
 * indexed the topic manager has already checked it.
 */
export async function assertAnchorSignature(
  fields: number[][],
  anchoredBy: string,
  attestationId: string
): Promise<void> {
  const signature = fields.at(-1)
  if (signature === undefined) throw new Error('the anchor carries no signature')
  const { valid } = await new ProtoWallet('anyone').verifySignature({
    data: fields.slice(0, -1).flat(),
    signature,
    counterparty: anchoredBy,
    protocolID: UORA_ANCHOR_PROTOCOL,
    keyID: attestationId
  })
  if (!valid) throw new Error('the anchor fields were not signed by the anchoring service')
}
