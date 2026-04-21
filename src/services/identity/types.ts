import { Base64String, Certificate, PubKeyHex } from '@bsv/sdk'

export interface UTXOReference {
  txid: string
  outputIndex: number
}

export interface IdentityAttributes {
  [key: string]: string
}

export interface IdentityRecord {
  txid: string
  outputIndex: number
  certificate: Certificate
  createdAt: Date
  searchableAttributes?: string
}

export interface IdentityQuery {
  attributes?: IdentityAttributes
  certifiers?: PubKeyHex[]
  identityKey?: PubKeyHex
  certificateTypes?: Base64String[]
  serialNumber?: Base64String
  limit?: number
  offset?: number
}
