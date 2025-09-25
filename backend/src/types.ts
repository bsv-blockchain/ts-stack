import { OutpointString, PubKeyHex } from "@bsv/sdk"

export interface KVStoreQuery {
  // Filter parameters
  protectedKey?: string
  namespace?: string
  controller?: string

  // Pagination parameters
  limit?: number    // Maximum number of results to return (default: 50)
  skip?: number     // Number of results to skip (default: 0)

  // Sorting parameters
  sortOrder?: 'asc' | 'desc'  // Sort direction (default: 'desc' - newest first)

  // History depth for chain tracking
  history?: boolean
}

/**
 * KVStore token metadata extracted from PushDrop fields
 * Field 0: Public key (32 bytes)
 * Field 1: Value data
 */
export interface KVStoreTokenData {
  publicKey: Buffer
  value: Buffer
  protectedKey: string // base64 encoded protected key
}

/**
 * A record stored in the KVStore lookup database
 */
export interface KVStoreRecord {
  txid: string
  outputIndex: number
  protectedKey: string
  namespace: string
  controller: PubKeyHex
  createdAt: Date
  spent?: boolean
  spentAt?: Date
}

/**
 * Query result with history support
 */
export interface KVStoreLookupResult {
  txid: string
  outputIndex: number
  history?: (output: any, currentDepth: number) => Promise<boolean>
}

export const kvProtocol = {
  namespace: 0,
  protectedKey: 1,
  value: 2,
  controller: 3,
  signature: 4
}