export interface DesktopIntegrityRecord {
  txid: string
  outputIndex: number
  fileHash: string
  createdAt: Date
}

export interface UTXOReference {
  txid: string
  outputIndex: number
}
