import { LookupFormula } from '@bsv/overlay'

export interface OwnerOutpointStorage {
  findByOwner: (ownerHash160: string) => Promise<LookupFormula>
  findByOutpoint: (txid: string, outputIndex: number) => Promise<LookupFormula>
}

/**
 * Shared tail of the STAS/BSV-21 `lookup()` implementations: once the
 * token-specific primary key (assetId/tokenId) has been checked and missed,
 * every token type falls back to the same owner/outpoint queries.
 */
export async function lookupByOwnerOrOutpoint (
  storage: OwnerOutpointStorage,
  query: { ownerHash160?: unknown, txid?: unknown, outputIndex?: unknown }
): Promise<LookupFormula> {
  if (typeof query.ownerHash160 === 'string') {
    return await storage.findByOwner(query.ownerHash160)
  }
  if (typeof query.txid === 'string' && typeof query.outputIndex === 'number') {
    return await storage.findByOutpoint(query.txid, query.outputIndex)
  }
  throw new Error('Unsupported query')
}
