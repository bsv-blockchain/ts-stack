import { WERR_NETWORK_CHAIN } from '../../sdk/WERR_errors'
import type { ProcessSyncChunkResult } from '../../sdk/WalletStorage.interfaces'
import type { TableSettings } from '../schema/tables'

/**
 * Live-sync handshake: compare reader and writer chain before any chunk moves.
 */
export function assertLiveSyncChainsMatch(readerSettings: TableSettings, writerSettings: TableSettings): void {
  if (readerSettings.chain !== writerSettings.chain) {
    throw new WERR_NETWORK_CHAIN(
      `Configured network chain is invalid or does not match across services. Reader '${readerSettings.storageName}' is '${String(readerSettings.chain)}'; writer '${writerSettings.storageName}' is '${String(writerSettings.chain)}'.`
    )
  }
}

/**
 * Honor a custom writer's non-throwing `ProcessSyncChunkResult.error`.
 */
export function throwIfProcessSyncChunkError(result: ProcessSyncChunkResult): void {
  if (result.error != null) {
    throw result.error
  }
}
