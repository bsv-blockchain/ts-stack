export interface DesktopIntegrityRecord {
  txid: string
  outputIndex: number
  fileHash: string
  offChainValues: Array<number>
  createdAt: Date
}

export interface UTXOReference {
  txid: string
  outputIndex: number
  context?: number[]
}