export interface UTXOReference {
  txid: string
  outputIndex: number
}

export interface SHIPRecord {
  txid: string
  outputIndex: number
  identityKey: string
  domain: string
  topic: string
  createdAt: Date
}

export interface SLAPRecord {
  txid: string
  outputIndex: number
  identityKey: string
  domain: string
  service: string
  createdAt: Date
}

export interface SHIPQuery {
  findAll?: boolean
  domain?: string
  topics?: string[]
  identityKey?: string
  limit?: number
  skip?: number
  sortOrder?: 'asc' | 'desc'
}

export interface SLAPQuery {
  findAll?: boolean
  domain?: string
  service?: string
  identityKey?: string
  limit?: number
  skip?: number
  sortOrder?: 'asc' | 'desc'
}
