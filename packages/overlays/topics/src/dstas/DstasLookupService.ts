import {
  LookupService, LookupQuestion, LookupFormula,
  AdmissionMode, SpendNotificationMode, OutputAdmittedByTopic, OutputSpent
} from '@bsv/overlay'
import { Db } from 'mongodb'
import { DstasToken } from '@bsv/templates'
import { DstasStorageManager } from './DstasStorageManager.js'
import { DstasQuery } from './types.js'
import docs from './DstasLookupDocs.md.js'

export interface DstasLookupDeps {
  storage: DstasStorageManager
}

export class DstasLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'script'

  constructor (private readonly deps: DstasLookupDeps) {}

  async outputAdmittedByTopic (payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') return
    if (payload.topic !== 'tm_dstas') return
    let decoded
    try {
      decoded = DstasToken.decode(payload.lockingScript)
    } catch {
      return // not a DSTAS output
    }
    await this.deps.storage.storeToken({
      txid: payload.txid,
      outputIndex: payload.outputIndex,
      tokenId: decoded.tokenId,
      ownerHash160: decoded.ownerHash160,
      frozen: decoded.frozen,
      createdAt: new Date()
    })
  }

  async outputSpent (payload: OutputSpent): Promise<void> {
    if (payload.topic !== 'tm_dstas') return
    await this.deps.storage.deleteToken(payload.txid, payload.outputIndex)
  }

  async outputEvicted (txid: string, outputIndex: number): Promise<void> {
    await this.deps.storage.deleteToken(txid, outputIndex)
  }

  async lookup (question: LookupQuestion): Promise<LookupFormula> {
    const query = ((question as any).query ?? {}) as DstasQuery
    const frozen = typeof query.frozen === 'boolean' ? query.frozen : undefined
    if (typeof query.tokenId === 'string') {
      return await this.deps.storage.findByTokenId(query.tokenId, frozen)
    }
    if (typeof query.ownerHash160 === 'string') {
      return await this.deps.storage.findByOwner(query.ownerHash160, frozen)
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
      name: 'ls_dstas',
      shortDescription: 'DSTAS token index by tokenId/owner/outpoint.'
    }
  }
}

export function createDstasLookupService () {
  return (db: Db): DstasLookupService => new DstasLookupService({
    storage: new DstasStorageManager(db)
  })
}
