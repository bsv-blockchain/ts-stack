import { Base64String } from '@bsv/sdk'

export interface DIDRecord {
  txid: string
  outputIndex: number
  serialNumber: Base64String
}

export interface DIDQuery {
  serialNumber?: Base64String
  outpoint?: string
}
