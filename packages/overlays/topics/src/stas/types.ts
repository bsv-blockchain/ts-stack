import { PubKeyHex } from '@bsv/sdk'

export type { StasTokenDecoded } from '@bsv/templates'

/**
 * An indexed classic-STAS token UTXO. Classic STAS is satoshi-denominated (the
 * token amount IS the output's satoshi value); the amount is not stored here
 * because the overlay admission payload does not carry satoshis — conservation
 * is enforced upstream in the topic manager, and queries return outpoints.
 */
export interface StasTokenRecord {
  txid: string
  outputIndex: number
  assetId: string
  ownerHash160: string
  createdAt: Date
}

export interface UTXOReference {
  txid: string
  outputIndex: number
}

export interface StasQuery {
  assetId?: string
  txid?: string
  outputIndex?: number
  ownerHash160?: PubKeyHex
}
