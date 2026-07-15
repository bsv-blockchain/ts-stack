import {
  LookupService, LookupQuestion, LookupFormula,
  AdmissionMode, SpendNotificationMode, OutputAdmittedByTopic, OutputSpent
} from '@bsv/overlay'
import { Db } from 'mongodb'
import { StasToken } from '@bsv/templates'
import { StasStorageManager } from './StasStorageManager.js'
import { StasQuery } from './types.js'
import { lookupByOwnerOrOutpoint } from '../shared/tokenLookupTail.js'
import docs from './StasLookupDocs.md.js'

export interface StasLookupDeps {
  storage: StasStorageManager
}

export class StasLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'script'

  constructor (private readonly deps: StasLookupDeps) {}

  async outputAdmittedByTopic (payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') return
    if (payload.topic !== 'tm_stas') return
    let decoded
    try {
      decoded = StasToken.decode(payload.lockingScript)
    } catch {
      return // not a STAS output
    }
    await this.deps.storage.storeToken({
      txid: payload.txid,
      outputIndex: payload.outputIndex,
      assetId: decoded.assetId,
      ownerHash160: decoded.ownerHash160,
      createdAt: new Date()
    })
  }

  async outputSpent (payload: OutputSpent): Promise<void> {
    if (payload.topic !== 'tm_stas') return
    await this.deps.storage.deleteToken(payload.txid, payload.outputIndex)
  }

  async outputEvicted (txid: string, outputIndex: number): Promise<void> {
    await this.deps.storage.deleteToken(txid, outputIndex)
  }

  async lookup (question: LookupQuestion): Promise<LookupFormula> {
    const query = ((question as any).query ?? {}) as StasQuery
    if (typeof query.assetId === 'string') {
      return await this.deps.storage.findByAssetId(query.assetId)
    }
    return await lookupByOwnerOrOutpoint(this.deps.storage, query)
  }

  async getDocumentation (): Promise<string> {
    return docs
  }

  async getMetaData (): Promise<{ name: string, shortDescription: string }> {
    return {
      name: 'ls_stas',
      shortDescription: 'Classic STAS token index by assetId/owner/outpoint.'
    }
  }
}

export function createStasLookupService () {
  return (db: Db): StasLookupService => new StasLookupService({
    storage: new StasStorageManager(db)
  })
}
