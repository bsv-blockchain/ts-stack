export interface UTXOReference {
  txid: string
  outputIndex: number
}

export interface FractionalizeRecord {
  txid: string
  outputIndex: number
  createdAt: Date
}

export interface FractionalizeQuery {
  txid?: string
  limit?: number
  skip?: number
  startDate?: Date
  endDate?: Date
  sortOrder?: 'asc' | 'desc'
}