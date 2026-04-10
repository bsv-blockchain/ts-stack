export interface DesktopIntegrityRecord {
  txid: string
  outputIndex: number
  fileHash: string
  offChainValues: Buffer | null
  createdAt: Date
}

export interface UTXOReference {
  txid: string
  outputIndex: number
  context?: number[]
}