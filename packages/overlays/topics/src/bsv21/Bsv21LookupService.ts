import {
  LookupService, LookupQuestion, LookupFormula,
  AdmissionMode, SpendNotificationMode, OutputAdmittedByTopic, OutputSpent
} from '@bsv/overlay'
import { Db } from 'mongodb'
import { Bsv21Token } from '@bsv/templates'
import { Bsv21StorageManager } from './Bsv21StorageManager.js'
import { Bsv21Query } from './types.js'
import { lookupByOwnerOrOutpoint } from '../shared/tokenLookupTail.js'
import docs from './Bsv21LookupDocs.md.js'

export interface Bsv21LookupDeps {
  storage: Bsv21StorageManager
}

export class Bsv21LookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'script'

  constructor (private readonly deps: Bsv21LookupDeps) {}

  async outputAdmittedByTopic (payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') return
    if (payload.topic !== 'tm_bsv21') return
    let decoded
    try {
      decoded = Bsv21Token.decode(payload.lockingScript)
    } catch {
      return // not a BSV-21 output
    }
    // A mint output's tokenId is its own outpoint; a transfer names it in the JSON.
    const tokenId = decoded.isMint || decoded.id === ''
      ? `${payload.txid}_${payload.outputIndex}`
      : decoded.id
    await this.deps.storage.storeToken({
      txid: payload.txid,
      outputIndex: payload.outputIndex,
      tokenId,
      amount: decoded.amt,
      sym: decoded.sym,
      ownerHash160: decoded.ownerHash160,
      createdAt: new Date()
    })
  }

  async outputSpent (payload: OutputSpent): Promise<void> {
    if (payload.topic !== 'tm_bsv21') return
    await this.deps.storage.deleteToken(payload.txid, payload.outputIndex)
  }

  async outputEvicted (txid: string, outputIndex: number): Promise<void> {
    await this.deps.storage.deleteToken(txid, outputIndex)
  }

  async lookup (question: LookupQuestion): Promise<LookupFormula> {
    const query = ((question as any).query ?? {}) as Bsv21Query
    if (typeof query.tokenId === 'string') {
      return await this.deps.storage.findByTokenId(query.tokenId)
    }
    return await lookupByOwnerOrOutpoint(this.deps.storage, query)
  }

  async getDocumentation (): Promise<string> {
    return docs
  }

  async getMetaData (): Promise<{ name: string, shortDescription: string }> {
    return {
      name: 'ls_bsv21',
      shortDescription: 'BSV-21 token index by tokenId/owner/outpoint.'
    }
  }
}

export function createBsv21LookupService () {
  return (db: Db): Bsv21LookupService => new Bsv21LookupService({
    storage: new Bsv21StorageManager(db)
  })
}
