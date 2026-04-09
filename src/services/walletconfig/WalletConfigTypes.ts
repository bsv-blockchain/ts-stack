export interface WalletConfigLookupQuery {
  configID?: string
  name?: string
  wab?: string
  storage?: string
  messagebox?: string
  registryOperators?: string[]
}

export interface UTXOReference {
  txid: string
  outputIndex: number
}

export interface WalletConfigRegistration {
  configID: string
  name: string
  icon: string
  wab: string
  storage: string
  messagebox: string
  legal: string
  registryOperator: string
}

export interface WalletConfigRecord {
  txid: string
  outputIndex: number
  registration: WalletConfigRegistration
  createdAt: Date
}

export interface WalletConfigQuery {
  configID?: string
  name?: string
  wab?: string
  storage?: string
  messagebox?: string
  registryOperators?: string[]
}
