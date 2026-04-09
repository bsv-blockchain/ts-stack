export interface TokenDemoDetails {
  amount: string,
  tokenId: string,
  customFields?: Object
}

export interface UTXOReference {
  txid: string
  outputIndex: number
}

export interface TokenDemoRecord extends TokenDemoDetails {
  txid: string
  outputIndex: number
  createdAt: Date
}

export interface TokenDemoQuery {
  outpoint?: string
  tokenId?: string
  limit?: number
  skip?: number
  sortOrder?: 'asc' | 'desc'
  startDate?: Date
  endDate?: Date
}