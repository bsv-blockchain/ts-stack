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
import { DstasToken } from '@bsv/templates'
import { DstasStorageManager } from './DstasStorageManager.js'
import docs from './DstasLookupDocs.md.js'
import {
  readBoolean,
  readInteger,
  readString,
  requireHex,
  requireLookupQuery,
  requireTxid
} from '../shared/queryValidation.js'

export interface DstasLookupDeps {
  storage: DstasStorageManager
}

export class DstasLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'script'

  constructor(private readonly deps: DstasLookupDeps) {}

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
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

  async outputSpent(payload: OutputSpent): Promise<void> {
    if (payload.topic !== 'tm_dstas') return
    await this.deps.storage.deleteToken(payload.txid, payload.outputIndex)
  }

  async outputEvicted(txid: string, outputIndex: number): Promise<void> {
    await this.deps.storage.deleteToken(txid, outputIndex)
  }

  async lookup(question: LookupQuestion): Promise<LookupFormula> {
    const query = requireLookupQuery(question, 'ls_dstas', [
      'tokenId',
      'ownerHash160',
      'txid',
      'outputIndex',
      'frozen',
      'limit',
      'skip'
    ])
    const tokenId = requireHex(readString(query, 'tokenId', { maxBytes: 40 }), 'tokenId', 20)
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
    const frozen = query.frozen === undefined ? undefined : readBoolean(query, 'frozen')
    const limit = readInteger(query, 'limit', 100, 1, 100)
    const skip = readInteger(query, 'skip', 0, 0, 100000)
    if (tokenId !== undefined) {
      return await this.deps.storage.findByTokenId(tokenId, frozen, limit, skip)
    }
    if (ownerHash160 !== undefined) {
      return await this.deps.storage.findByOwner(ownerHash160, frozen, limit, skip)
    }
    if (txid !== undefined && outputIndex !== undefined) {
      return await this.deps.storage.findByOutpoint(txid, outputIndex)
    }
    throw new Error('Unsupported query')
  }

  async getDocumentation(): Promise<string> {
    return docs
  }

  async getMetaData(): Promise<{ name: string; shortDescription: string }> {
    return {
      name: 'ls_dstas',
      shortDescription: 'DSTAS token index by tokenId/owner/outpoint.'
    }
  }
}

export function createDstasLookupService() {
  return (db: Db): DstasLookupService =>
    new DstasLookupService({
      storage: new DstasStorageManager(db)
    })
}
