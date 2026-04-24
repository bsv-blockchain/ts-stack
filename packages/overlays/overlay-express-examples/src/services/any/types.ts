export interface UTXOReference {
  txid: string
  outputIndex: number
}

export interface AnyRecord {
  txid: string
  outputIndex: number
  createdAt: Date
}

export interface AnyQuery {
  txid?: string
  limit?: number
  skip?: number
  startDate?: Date
  endDate?: Date
  sortOrder?: 'asc' | 'desc'
}