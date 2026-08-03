import { CachedKeyDeriver, LockingScript, ProtoWallet, PublicKey, PushDrop, Utils } from '@bsv/sdk'
import type { WalletProtocol } from '@bsv/sdk'

/**
 * Reading and validating a `uora-anchor-v3` output.
 *
 * The format is specified independently of this implementation; this file is a
 * reader for it, written so the topic manager and the lookup service cannot
 * disagree about what an anchor is.
 *
 * v2 is not read here, and deliberately so. Its signature covered the field
 * bytes run together, which fixes the total string and not where any field
 * ends, so the boundary between the subject and the type could be re-cut by
 * anyone holding the output while the signature still verified. v3 changes only
 * the preimage. See `anchorSigningPreimage`.
 */

/** Marks the output as this format and versions the field layout. */
export const UORA_ANCHOR_PREFIX = 'uora-anchor-v3'

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
 * The key id is the attestation id rather than a constant, so every anchor locks
 * to a different key. That does not hide which service wrote them: field 6
 * carries the anchoring service's identity key in the clear, so grouping a
 * service's anchors is trivial by reading it. What the per-anchor key id buys is
 * that the locking keys themselves share no visible structure.
 */
export const UORA_ANCHOR_PROTOCOL: WalletProtocol = [1, 'uora anchor v3']

/** Fields before the appended signature. */
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
   * cannot derive from is claiming something untrue about itself.
   *
   * This check on its own proves nothing about authorship: counterparty
   * `anyone` is what makes the derivation reproducible, so anybody can compute
   * this key and lock an output to it. What needs the service's private key is
   * the signature, checked separately in `assertAnchorSignature`. Reading this
   * check as the proof is the mistake that let v2 through: it holds on a re-cut
   * anchor, because the two fields it pins are the two the re-cut leaves alone.
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
 * The bytes a v3 signature covers: every field preceded by its own length, so
 * the boundaries between fields are part of what is signed.
 *
 * v2 signed the fields run together, with nothing between them. That fixes the
 * total byte string and not where one field ends and the next begins. Four of
 * the seven boundaries are pinned anyway: the prefix is a fixed literal, the
 * digest is exactly 64 hex characters, and the attestation id and the anchoring
 * key are both fixed by the locking-key derivation. The subject and the type are
 * neither, and they are adjacent, so any holder of an anchor could re-cut that
 * one boundary into a different subject and type, copy the signature verbatim,
 * and pass every check this file made. The one v2 anchor on mainnet admits 63
 * such readings of itself.
 *
 * Length prefixes close it: any other split is different bytes, so the signature
 * no longer verifies. This is deliberately not `PushDrop.lock`'s built-in
 * signature, which signs `fields.flat()` and has no option to commit to
 * boundaries; a writer signs this preimage and appends it as the last field.
 */
export function anchorSigningPreimage(fields: number[][]): number[] {
  const writer = new Utils.Writer()
  for (const field of fields) {
    writer.writeVarIntNum(field.length)
    writer.write(field)
  }
  return writer.toArray()
}

/**
 * The appended signature, checked against the service the output names. This is
 * the step that needs the anchoring service's private key, and so the only one
 * that proves who wrote the anchor.
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
  // `verifySignature` throws on a bad signature rather than returning a verdict,
  // so the failure has to be caught to become this format's own error. Left
  // uncaught, the branch below was unreachable and a reader saw the wallet's
  // wording instead of a reason that names the anchor.
  let valid = false
  try {
    ;({ valid } = await new ProtoWallet('anyone').verifySignature({
      data: anchorSigningPreimage(fields.slice(0, -1)),
      signature,
      counterparty: anchoredBy,
      protocolID: UORA_ANCHOR_PROTOCOL,
      keyID: attestationId
    }))
  } catch {
    valid = false
  }
  if (!valid) throw new Error('the anchor fields were not signed by the anchoring service')
}
