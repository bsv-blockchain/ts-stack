import type { MandalaStorageManager } from '@bsv/overlay-topics'

type MandalaStore = Pick<
  MandalaStorageManager,
  'getAssetState' | 'getTokenRow' | 'findAdminHistoryByAssetId'
>

/** Resolve lazily because Mongo lookup configuration initializes the shared store. */
export function createMandalaStateStore(resolve: () => MandalaStore) {
  return {
    getAssetState: async (assetId: string) => await resolve().getAssetState(assetId),
    getTokenRow: async (txid: string, outputIndex: number) =>
      await resolve().getTokenRow(txid, outputIndex),
    // Use the existing history API to support the currently published store.
    isAdminOutpoint: async (assetId: string, txid: string, outputIndex: number) => {
      const history = await resolve().findAdminHistoryByAssetId(assetId)
      return history.some(
        entry =>
          entry.assetId === assetId && entry.txid === txid && entry.outputIndex === outputIndex
      )
    }
  }
}
