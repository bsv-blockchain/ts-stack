import { PubKeyHex } from '@bsv/sdk'

export type { DstasTokenDecoded } from '@bsv/templates'

/**
 * An indexed DSTAS token UTXO. DSTAS is satoshi-denominated, so the amount is
 * the output's satoshi value and is not stored here (the admission payload
 * carries no satoshis; conservation is enforced upstream).
 */
export interface DstasTokenRecord {
  txid: string
  outputIndex: number
  /** Redemption / protoID pkh — the token id. */
  tokenId: string
  ownerHash160: string
  frozen: boolean
  createdAt: Date
}

export interface UTXOReference {
  txid: string
  outputIndex: number
}

export interface DstasQuery {
  tokenId?: string
  txid?: string
  outputIndex?: number
  ownerHash160?: PubKeyHex
  /**
   * Optional compliance filter, combinable with tokenId/owner queries. DSTAS
   * freeze is enforced on-chain by Bitcoin Script (a frozen UTXO cannot be
   * transferred by its owner); the overlay still indexes frozen outputs as real
   * state. Set `frozen: false` to discover only spendable holdings, `true` to
   * find frozen ones. Omitted ⇒ both.
   */
  frozen?: boolean
}
