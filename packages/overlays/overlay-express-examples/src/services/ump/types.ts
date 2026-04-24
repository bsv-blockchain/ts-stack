export interface UMPRecord {
  txid: string
  outputIndex: number
  presentationHash: string
  recoveryHash: string
}

export interface UTXOReference {
  txid: string
  outputIndex: number
}
