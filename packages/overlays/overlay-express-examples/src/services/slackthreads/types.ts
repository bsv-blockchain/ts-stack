export interface SlackThreadRecord {
  txid: string
  outputIndex: number
  threadHash: string
  createdAt: Date
}

export interface UTXOReference {
  txid: string
  outputIndex: number
}