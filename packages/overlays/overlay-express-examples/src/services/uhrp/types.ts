export interface UHRPRecord {
  txid: string
  outputIndex: number
  uhrpUrl: string
  hostIdentityKey: string
  hostedFileLocation: string
  expiryTime: number
  fileSize: number
}

export interface UTXOReference {
  txid: string
  outputIndex: number
}
