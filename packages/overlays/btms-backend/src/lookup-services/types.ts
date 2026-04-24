import { PubKeyHex } from '@bsv/sdk'

/**
 * Query parameters for BTMS token lookups
 */
export interface BTMSQuery {
  assetId?: string
  ownerKey?: PubKeyHex
  limit?: number
  skip?: number
  sortOrder?: 'asc' | 'desc'
  history?: boolean
}

/**
 * A record stored in the BTMS lookup database
 */
export interface BTMSRecord {
  txid: string
  outputIndex: number
  assetId: string
  amount: number
  ownerKey: PubKeyHex
  metadata?: string
  createdAt: Date
}

/**
 * Query result with history support
 */
export interface BTMSLookupResult {
  txid: string
  outputIndex: number
  history?: (beef: number[], outputIndex: number, currentDepth: number) => Promise<boolean>
}

/**
 * Field indices for BTMS PushDrop tokens
 * Format: [assetId, amount, metadata?]
 */
export const btmsProtocol = {
  assetId: 0,
  amount: 1,
  metadata: 2
}
