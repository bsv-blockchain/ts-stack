export interface UMPRecord {
  txid: string
  outputIndex: number
  presentationHash: string
  recoveryHash: string
  umpVersion?: number
  kdfAlgorithm?: string
  kdfIterations?: number
}

export interface UTXOReference {
  txid: string
  outputIndex: number
}
