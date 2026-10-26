import {
  LookupService,
  LookupQuestion,
  LookupFormula,
  AdmissionMode,
  SpendNotificationMode,
  OutputAdmittedByTopic,
  OutputSpent
} from '@bsv/overlay'
import { Db } from 'mongodb'
import { Bsv21Token } from '@bsv/templates'
import { Bsv21StorageManager } from './Bsv21StorageManager.js'
import { lookupByOwnerOrOutpoint } from '../shared/tokenLookupTail.js'
import docs from './Bsv21LookupDocs.md.js'
import {
  readInteger,
  readString,
  requireHex,
  requireLookupQuery,
  requireTxid
} from '../shared/queryValidation.js'

export interface Bsv21LookupDeps {
  storage: Bsv21StorageManager
}

export class Bsv21LookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'script'

  constructor(private readonly deps: Bsv21LookupDeps) {}

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') return
    if (payload.topic !== 'tm_bsv21') return
    let decoded
    try {
      decoded = Bsv21Token.decode(payload.lockingScript)
    } catch {
      return // not a BSV-21 output
    }
    // A mint output's tokenId is its own outpoint; a transfer names it in the JSON.
    const tokenId =
      decoded.isMint || decoded.id === '' ? `${payload.txid}_${payload.outputIndex}` : decoded.id
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

  async outputSpent(payload: OutputSpent): Promise<void> {
    if (payload.topic !== 'tm_bsv21') return
    await this.deps.storage.deleteToken(payload.txid, payload.outputIndex)
  }

  async outputEvicted(txid: string, outputIndex: number): Promise<void> {
    await this.deps.storage.deleteToken(txid, outputIndex)
  }

  async lookup(question: LookupQuestion): Promise<LookupFormula> {
    const query = requireLookupQuery(question, 'ls_bsv21', [
      'tokenId',
      'ownerHash160',
      'txid',
      'outputIndex',
      'limit',
      'skip'
    ])
    const tokenId = readString(query, 'tokenId', { maxBytes: 100 })
    const ownerHash160 = requireHex(
      readString(query, 'ownerHash160', { maxBytes: 40 }),
      'ownerHash160',
      20
    )
    const txid = requireTxid(readString(query, 'txid', { maxBytes: 64 }))
    const outputIndex =
      query.outputIndex === undefined
        ? undefined
        : readInteger(query, 'outputIndex', 0, 0, 0xffffffff)
    const limit = readInteger(query, 'limit', 100, 1, 100)
    const skip = readInteger(query, 'skip', 0, 0, 100000)
    if (tokenId !== undefined) {
      return await this.deps.storage.findByTokenId(tokenId, limit, skip)
    }
    return await lookupByOwnerOrOutpoint(
      this.deps.storage,
      { ownerHash160, txid, outputIndex },
      limit,
      skip
    )
  }

  async getDocumentation(): Promise<string> {
    return docs
  }

  async getMetaData(): Promise<{ name: string; shortDescription: string }> {
    return {
      name: 'ls_bsv21',
      shortDescription: 'BSV-21 token index by tokenId/owner/outpoint.'
    }
  }
}

export function createBsv21LookupService() {
  return (db: Db): Bsv21LookupService =>
    new Bsv21LookupService({
      storage: new Bsv21StorageManager(db)
    })
}
