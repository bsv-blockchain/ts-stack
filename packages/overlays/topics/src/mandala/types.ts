import { PubKeyHex, WalletProtocol, Utils } from '@bsv/sdk'

export interface SpecificLinkage {
  prover: PubKeyHex
  verifier: PubKeyHex
  counterparty: PubKeyHex
  protocolID: WalletProtocol
  keyID: string
  encryptedLinkage: number[]
  encryptedLinkageProof: number[]
  proofType: number
}

export interface MandalaLinkagePayload {
  inputs: Array<{ index: number, linkage: SpecificLinkage }>
  outputs: Array<{ index: number, linkage: SpecificLinkage }>
}

export interface MandalaTokenRecord {
  txid: string
  outputIndex: number
  assetId: string
  amount: number
  identityKey: PubKeyHex
  createdAt: Date
}

export interface MandalaLinkageRecord {
  txid: string
  outputIndex: number
  identityKey: PubKeyHex
  linkage: SpecificLinkage
  createdAt: Date
}

export interface UTXOReference {
  txid: string
  outputIndex: number
}

export interface ScreeningProvider {
  isSanctioned: (identityKey: PubKeyHex) => Promise<boolean>
}

export class InMemoryScreeningProvider implements ScreeningProvider {
  private readonly banned: Set<string>
  constructor (bannedIdentityKeys: PubKeyHex[] = []) {
    this.banned = new Set(bannedIdentityKeys)
  }

  async isSanctioned (identityKey: PubKeyHex): Promise<boolean> {
    return this.banned.has(identityKey)
  }
}

export const encodeLinkagePayload = (payload: MandalaLinkagePayload): number[] => {
  return Utils.toArray(JSON.stringify(payload), 'utf8')
}

export const decodeLinkagePayload = (bytes: number[]): MandalaLinkagePayload => {
  return JSON.parse(Utils.toUTF8(bytes)) as MandalaLinkagePayload
}
