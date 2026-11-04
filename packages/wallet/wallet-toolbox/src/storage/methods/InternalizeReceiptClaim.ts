import type { TrxToken } from '../../sdk/WalletStorage.interfaces'

/** Same-database receipt fence; every effect rechecks the current SQL owner. */
export interface InternalizeReceiptClaim {
  retryNew: boolean
  assertActive: (trx: TrxToken) => Promise<void>
  markNew: (trx: TrxToken) => Promise<void>
  complete: (trx: TrxToken) => Promise<void>
}
