import type { StorageInternalizeActionResult, TrxToken } from '../../sdk/WalletStorage.interfaces'

/**
 * Installed local hook only: no new BRC-100 wire field or default behavior.
 * Keep this boundary independent of optional SDK output-protocol types so
 * existing storage-method imports retain their declared SDK compatibility.
 */
export interface FundingRecoveryCommit {
  readonly protocol: 'wallet-funding-recovery-v1'
  reject(): Promise<void>
  commit(run: (trx: TrxToken) => Promise<StorageInternalizeActionResult>): Promise<StorageInternalizeActionResult>
}
