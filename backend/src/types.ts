import { PubKeyHex, WalletProtocol } from "@bsv/sdk"

export interface KVStoreQuery {
  key?: string
  controller?: PubKeyHex
  protocolID?: WalletProtocol  // Client sends this as WalletProtocol, we stringify for storage
  limit?: number
  skip?: number
  sortOrder?: 'asc' | 'desc'  // Sort direction (default: 'desc' - newest first)

  // History depth for chain tracking
  history?: boolean
}

/**
 * A record stored in the KVStore lookup database
 */
export interface KVStoreRecord {
  txid: string
  outputIndex: number
  key: string
  protocolID: string
  controller: PubKeyHex
  createdAt: Date
}

/**
 * Query result with history support
 */
export interface KVStoreLookupResult {
  txid: string
  outputIndex: number
  history?: (beef: number[], outputIndex: number, currentDepth: number) => Promise<boolean>
}

export const kvProtocol = {
  protocolID: 0,
  key: 1,
  value: 2,
  controller: 3,
  signature: 4
}