import { LookupFormula } from '@bsv/overlay'

export interface OwnerOutpointStorage {
  findByOwner: (ownerHash160: string, limit?: number, skip?: number) => Promise<LookupFormula>
  findByOutpoint: (txid: string, outputIndex: number) => Promise<LookupFormula>
}

/**
 * Shared tail of the STAS/BSV-21 `lookup()` implementations: once the
 * token-specific primary key (assetId/tokenId) has been checked and missed,
 * every token type falls back to the same owner/outpoint queries.
 */
export async function lookupByOwnerOrOutpoint(
  storage: OwnerOutpointStorage,
  query: { ownerHash160?: string; txid?: string; outputIndex?: number },
  limit = 100,
  skip = 0
): Promise<LookupFormula> {
  if (query.ownerHash160 !== undefined) {
    return await storage.findByOwner(query.ownerHash160, limit, skip)
  }
  if (query.txid !== undefined && query.outputIndex !== undefined) {
    return await storage.findByOutpoint(query.txid, query.outputIndex)
  }
  throw new Error('Unsupported query')
}
