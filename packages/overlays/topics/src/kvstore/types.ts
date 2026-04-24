import { PubKeyHex, WalletProtocol } from '@bsv/sdk'

export interface KVStoreQuery {
  key?: string
  controller?: PubKeyHex
  protocolID?: WalletProtocol
  tags?: string[]
  tagQueryMode?: 'all' | 'any'
  limit?: number
  skip?: number
  sortOrder?: 'asc' | 'desc'
  history?: boolean
}

export interface KVStoreRecord {
  txid: string
  outputIndex: number
  key: string
  protocolID: string
  controller: PubKeyHex
  tags?: string[]
  createdAt: Date
}

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
  tags: 4,
  signature: 5
}
