/**
 * `uora-anchor-v2`: an on-chain anchor for a UORA attestation.
 *
 * A UORA attestation is a claim one party makes about one product: who made it,
 * who it passed to, what happened to it. The claims themselves never go on
 * chain, both because they can carry personal data and because a digest is 32
 * bytes whatever the claim's size, which is what keeps per-event anchoring
 * affordable at fleet scale. What goes on chain is the digest, plus enough in
 * the clear for an index to be keyed on it.
 *
 * See `UoraDppTopicManager` for the admission rules and what they prove.
 */

/** One admitted anchor, flattened for the queries `ls_uora_dpp` answers. */
export interface UoraDppRecord {
  txid: string
  outputIndex: number
  /** Lower-case hex SHA-256 of the attestation's canonical form (RFC 8785). */
  digest: string
  /** The issuing registry's identifier for the attestation this digest covers. */
  attestationId: string
  /** The party that made the claim, as a `did:key`. Carried, not proved. */
  issuer: string
  /** The same key as hex, so a caller holding a chain key need not encode one. */
  issuerKey: string
  /** What the claim is about: a product passport identifier. */
  subject: string
  /** The UORA attestation type, verbatim and unvalidated against any list. */
  uoraType: string
  /** The anchoring service that wrote the output. Proved, not merely carried. */
  anchoredBy: string
  createdAt: Date
}

/**
 * What a caller may select on.
 *
 * Every field is an exact match. There is deliberately no prefix or regex
 * search: an unanchored pattern over an index whose contents anyone can write
 * is the cheapest denial of service an overlay offers.
 */
export interface UoraDppQuery {
  /** The claiming party's `did:key`. The question this topic exists for. */
  issuer?: string
  /** The same party as a compressed secp256k1 key in hex. */
  issuerKey?: string
  /** A product passport identifier: every claim about it, from every party. */
  subject?: string
  attestationId?: string
  /** Given an attestation in hand, has anyone anchored exactly this. */
  digest?: string
  /** The anchoring service. Narrows; cannot select on its own. */
  anchoredBy?: string
  /** The UORA attestation type. Narrows; cannot select on its own. */
  uoraType?: string
  limit?: number
  skip?: number
}
