import {
  LookupService, LookupQuestion, LookupFormula,
  AdmissionMode, SpendNotificationMode, OutputAdmittedByTopic, OutputSpent
} from '@bsv/overlay'
import { WalletInterface } from '@bsv/sdk'
import { Db } from 'mongodb'
import { MandalaToken, MandalaAdmin } from '@bsv/templates'
import { MandalaStorageManager } from './MandalaStorageManager.js'
import { verifyKeyLinkage } from './verifyKeyLinkage.js'
import { decodeLinkagePayload } from './types.js'
import docs from './MandalaLookupDocs.md.js'

export interface MandalaLookupDeps {
  storage: MandalaStorageManager
  verifierWallet: WalletInterface
}

export class MandalaLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'script'

  constructor (private readonly deps: MandalaLookupDeps) {}

  async outputAdmittedByTopic (payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') return
    if (payload.topic !== 'tm_mandala') return
    let decoded
    try {
      decoded = MandalaToken.decode(payload.lockingScript)
    } catch {
      // Not an FT. If it is an admin output carrying publicData, index it as metadata
      // keyed by its own outpoint (= assetId). Anchored on-chain; served by assetId.
      try {
        const admin = MandalaAdmin.decode(payload.lockingScript)
        if (admin.publicData != null) {
          await this.deps.storage.storeMetadata({
            txid: payload.txid,
            outputIndex: payload.outputIndex,
            assetId: `${payload.txid}.${payload.outputIndex}`
          })
        }
      } catch { /* not a mandala admin output */ }
      return
    }
    // Resolve controlling identity from the matching off-chain linkage.
    let identityKey = ''
    let matchedLinkage = null
    if (payload.offChainValues != null) {
      const parsed = decodeLinkagePayload(payload.offChainValues)
      const match = parsed.outputs.find(o => o.index === payload.outputIndex)
      if (match != null) {
        const v = await verifyKeyLinkage(match.linkage, this.deps.verifierWallet)
        identityKey = v.identityKey
        matchedLinkage = match.linkage
      }
    }
    const now = new Date()
    await this.deps.storage.storeToken({
      txid: payload.txid,
      outputIndex: payload.outputIndex,
      assetId: decoded.assetId,
      amount: decoded.amount,
      identityKey,
      createdAt: now
    })
    if (identityKey !== '') {
      await this.deps.storage.adjustBalance(identityKey, decoded.amount)
      if (matchedLinkage != null) {
        await this.deps.storage.storeLinkage({
          txid: payload.txid,
          outputIndex: payload.outputIndex,
          identityKey,
          linkage: matchedLinkage,
          createdAt: now
        })
      }
    }
  }

  async outputSpent (payload: OutputSpent): Promise<void> {
    if (payload.topic !== 'tm_mandala') return
    const rows = await this.deps.storage.findByOutpoint(payload.txid, payload.outputIndex)
    if (rows.length > 0) {
      const tokenRow = await this.deps.storage.getTokenRow(payload.txid, payload.outputIndex)
      if (tokenRow != null && tokenRow.identityKey !== '') {
        await this.deps.storage.adjustBalance(tokenRow.identityKey, -tokenRow.amount)
      }
    }
    await this.deps.storage.deleteToken(payload.txid, payload.outputIndex)
  }

  async outputEvicted (txid: string, outputIndex: number): Promise<void> {
    await this.deps.storage.deleteToken(txid, outputIndex)
    await this.deps.storage.deleteMetadata(txid, outputIndex)
  }

  async lookup (question: LookupQuestion): Promise<LookupFormula> {
    const query = (question as any).query ?? {}
    if (typeof query.metadataAssetId === 'string') {
      return await this.deps.storage.findMetadataByAssetId(query.metadataAssetId)
    }
    if (typeof query.assetId === 'string') {
      return await this.deps.storage.findByAssetId(query.assetId)
    }
    if (typeof query.txid === 'string' && typeof query.outputIndex === 'number') {
      return await this.deps.storage.findByOutpoint(query.txid, query.outputIndex)
    }
    throw new Error('Unsupported query')
  }

  async getDocumentation (): Promise<string> {
    return docs
  }

  async getMetaData (): Promise<{ name: string, shortDescription: string }> {
    return {
      name: 'ls_mandala',
      shortDescription: 'Mandala token index by assetId/outpoint. No public identity-balance query.'
    }
  }
}

export function createMandalaLookupService (verifierWallet: WalletInterface) {
  return (db: Db): MandalaLookupService => new MandalaLookupService({
    storage: new MandalaStorageManager(db),
    verifierWallet
  })
}
