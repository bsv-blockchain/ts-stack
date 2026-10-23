import type { MandalaStateStore, MandalaStorageManager } from '@bsv/overlay-topics'

/**
 * The topic manager is constructed before lookup configuration assigns the
 * shared manager, so every call resolves that manager at use time.
 */
export function createMandalaStateStore(resolve: () => MandalaStorageManager): MandalaStateStore {
  return {
    getAssetState: async tokenId => await resolve().getAssetState(tokenId),
    getTokenRow: async (txid, outputIndex) => await resolve().getTokenRow(txid, outputIndex),
    getAuthorityRow: async (txid, outputIndex) =>
      await resolve().getAuthorityRow(txid, outputIndex),
    getOwnerJournal: async (txid, outputIndex, topic) =>
      await resolve().getOwnerJournal(txid, outputIndex, topic),
    recordOwners: async rows => await resolve().recordOwners(rows),
    repairOwnerRow: async journal => await resolve().repairOwnerRow(journal),
    takeToken: async (txid, outputIndex) => await resolve().takeToken(txid, outputIndex),
    takeAuthority: async (txid, outputIndex) => await resolve().takeAuthority(txid, outputIndex),
    adjustBalance: async (identityKey, delta) => await resolve().adjustBalance(identityKey, delta),
    circulatingSupply: async tokenId => await resolve().circulatingSupply(tokenId)
  }
}
