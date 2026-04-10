export interface SupplyChainRecord {
  txid: string
  outputIndex: number
  offChainValues: Record<string, any>
  createdAt: Date
}

export interface UTXOReference {
  txid: string
  outputIndex: number
}