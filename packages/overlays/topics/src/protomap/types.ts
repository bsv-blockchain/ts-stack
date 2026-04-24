import { WalletProtocol } from '@bsv/sdk'

export interface UTXOReference {
  txid: string
  outputIndex: number
}

export interface ProtoMapRegistration {
  registryOperator: string
  protocolID: {
    securityLevel: number
    protocol: string
  }
  name: string
}

export interface ProtoMapRecord {
  txid: string
  outputIndex: number
  registration: ProtoMapRegistration
  createdAt: Date
}

export interface ProtoMapQuery {
  name?: string
  registryOperators?: string[]
  protocolID?: WalletProtocol
}
