export interface UTXOReference {
  txid: string
  outputIndex: number
}

export interface CertMapRegistration {
  type: string
  name: string
  registryOperator: string
}

export interface CertMapRecord {
  txid: string
  outputIndex: number
  registration: CertMapRegistration
  createdAt: Date
}

export interface CertMapQuery {
  type?: string
  name?: string
  registryOperators?: string[]
}
