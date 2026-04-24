import { Base64String } from "@bsv/sdk"

export interface DIDRecord {
  txid: string
  outputIndex: number
  serialNumber: Base64String
  createdAt: Date
}

export interface DIDQuery {
  serialNumber?: Base64String,
  outpoint?: string
}

export interface UTXOReference {
  txid: string
  outputIndex: number
}
