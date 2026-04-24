export interface BasketMapLookupQuery {
  basketID?: string
  name?: string
  registryOperators?: string[]
}

export interface UTXOReference {
  txid: string
  outputIndex: number
}

export interface BasketMapRegistration {
  basketID: string
  name: string
  registryOperator: string
}

export interface BasketMapRecord {
  txid: string
  outputIndex: number
  registration: BasketMapRegistration
  createdAt: Date
}

export interface BasketMapQuery {
  basketID?: string
  registryOperators?: string[]
  name?: string
}
