import { PubKeyHex } from '@bsv/sdk'

export type { Bsv21TokenDecoded } from '@bsv/templates'

/**
 * An indexed BSV-21 token UTXO. `amount` is the raw bigint token amount stored
 * as a string (BSV-21 is divisible, unlike satoshi-denominated classic STAS).
 */
export interface Bsv21TokenRecord {
  txid: string
  outputIndex: number
  /** Token id `<txid>_<vout>` of the deploy+mint. */
  tokenId: string
  amount: string
  sym?: string
  ownerHash160: string
  createdAt: Date
}

export interface UTXOReference {
  txid: string
  outputIndex: number
}

export interface Bsv21Query {
  tokenId?: string
  txid?: string
  outputIndex?: number
  ownerHash160?: PubKeyHex
}
