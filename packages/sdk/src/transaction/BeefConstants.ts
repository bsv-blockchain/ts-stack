/**
 * BEEF format constants extracted to avoid the Beef.ts <-> BeefTx.ts circular import.
 *
 * BEEF standard: BRC-62: Background Evaluation Extended Format (BEEF) Transactions
 * https://github.com/bsv-blockchain/BRCs/blob/master/transactions/0062.md
 */

export const BEEF_V1 = 4022206465 // 0100BEEF in LE order
export const BEEF_V2 = 4022206466 // 0200BEEF in LE order
export const ATOMIC_BEEF = 0x01010101 // 01010101

export enum TX_DATA_FORMAT {
  RAWTX = 0, // rawtx without BUMP
  RAWTX_AND_BUMP_INDEX = 1, // rawtx with bump index
  TXID_ONLY = 2, // txid only
}
