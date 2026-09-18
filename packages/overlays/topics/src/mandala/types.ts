import { PubKeyHex, WalletProtocol, Utils } from '@bsv/sdk'
import { MandalaActionDetails } from '@bsv/templates'

export type { MandalaActionDetails }
export type { AssetAdminState, FrozenRef } from './AssetStateReducer.js'

export interface AdminHistoryEntry {
  assetId: string
  txid: string
  outputIndex: number
  height: number
  offset: number
  admitSeq: number
  actionDetails: MandalaActionDetails
  createdAt: Date
}

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
  admin?: Array<{ index: number, actionDetails: MandalaActionDetails }>
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
    this.banned = new Set(bannedIdentityKeys.map(key => key.toLowerCase()))
  }

  async isSanctioned (identityKey: PubKeyHex): Promise<boolean> {
    return this.banned.has(identityKey.toLowerCase())
  }
}

export const encodeLinkagePayload = (payload: MandalaLinkagePayload): number[] => {
  return Utils.toArray(JSON.stringify(payload), 'utf8')
}

function validateIndices (entries: unknown, label: string): void {
  if (!Array.isArray(entries)) throw new Error(`Mandala ${label} must be an array`)
  const seen = new Set<number>()
  for (const entry of entries) {
    const index = entry?.index
    if (!Number.isSafeInteger(index) || index < 0 || seen.has(index)) {
      throw new Error(`Mandala ${label} must contain unique non-negative integer indices`)
    }
    seen.add(index)
  }
}

export const decodeLinkagePayload = (bytes: number[]): MandalaLinkagePayload => {
  const payload = JSON.parse(Utils.toUTF8(bytes)) as MandalaLinkagePayload
  if (payload == null || typeof payload !== 'object') throw new Error('Mandala payload must be an object')
  validateIndices(payload.inputs, 'inputs')
  validateIndices(payload.outputs, 'outputs')
  if (payload.admin !== undefined) validateIndices(payload.admin, 'admin')
  return payload
}
