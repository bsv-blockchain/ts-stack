export interface UMPRecord {
  txid: string
  outputIndex: number
  presentationHash: string
  recoveryHash: string
  // V3 metadata fields (optional for legacy tokens)
  umpVersion?: number
  kdfAlgorithm?: string
  kdfIterations?: number
}

export interface UTXOReference {
  txid: string
  outputIndex: number
}
