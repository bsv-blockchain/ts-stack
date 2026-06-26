/**
 * Issuer-authority policy shared by the token topic managers (STAS, BSV-21,
 * DSTAS).
 *
 * Minting a token is permissionless in Bitcoin Script: anyone can create an
 * output that claims any tokenId / protoID, and the script engine will admit
 * it. Token *authority* — "is this protoID really issued by who it claims?" —
 * is therefore established off-chain, via the issuer's published TokenScheme
 * (see the STAS protocol study §4: "indexers reconstruct a token's identity by
 * combining the on-chain locking script with the off-chain TokenScheme").
 *
 * An overlay cannot derive that authority from the chain alone. What it CAN do
 * is let its operator decide which issuances to index. `allowIssuance` is the
 * hook for that decision: it is consulted only for *issuance* outputs — a
 * tokenId that appears in a transaction's outputs with no admitted input of the
 * same tokenId (a mint, not a transfer). Transfers are always governed by value
 * conservation, which the script engine already enforces on-chain.
 *
 * Omitting the policy (or `allowIssuance`) keeps the permissionless default:
 * every issuance is admitted. Supplying an allowlist-backed predicate restricts
 * the index to known issuers without changing transfer behaviour.
 */
export interface TokenIssuerPolicy {
  /**
   * Decide whether an issuance of `tokenId` may be admitted (indexed).
   * Return true to admit, false to reject. Consulted once per issuance tokenId.
   * Omitted ⇒ permissionless (admit all issuances).
   */
  allowIssuance?: (tokenId: string) => boolean
}

/**
 * Build an `allowIssuance` predicate from a fixed allowlist of tokenIds
 * (protoIDs). A convenience for the common "only these known issuers" case.
 */
export function allowlistIssuerPolicy (tokenIds: Iterable<string>): TokenIssuerPolicy {
  const allowed = new Set(tokenIds)
  return { allowIssuance: (tokenId: string) => allowed.has(tokenId) }
}
