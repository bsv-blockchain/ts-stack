import { StorageIdb } from '../StorageIdb'
import { PurgeParams, PurgeResults, TrxToken } from '../../sdk/WalletStorage.interfaces'

export async function purgeDataIdb (storage: StorageIdb, params: PurgeParams, trx?: TrxToken): Promise<PurgeResults> {
  const r: PurgeResults = { count: 0, log: '' }
  // Stub: purgeDataIdb not yet implemented
  return r
}
