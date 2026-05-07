import {
  LookupService,
  LookupQuestion,
  LookupFormula,
  AdmissionMode,
  SpendNotificationMode,
  OutputAdmittedByTopic,
  OutputSpent
} from '@bsv/overlay'
import { TokenDemoStorage } from './TokenDemoStorage.js'
import { PushDrop, Utils } from '@bsv/sdk'
import { Db } from 'mongodb'
import { TokenDemoDetails, TokenDemoQuery } from './types.js'

export class TokenDemoLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'

  constructor(public storage: TokenDemoStorage) { }

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    try {
      if (payload.mode !== 'locking-script') throw new Error('Invalid mode')
      const { topic, lockingScript, txid, outputIndex } = payload
      if (topic !== 'tm_tokendemo') return

      const token = PushDrop.decode(lockingScript)
      const r = new Utils.Reader(token.fields[1])
      const amount = String(r.readUInt64LEBn())
      const customFields = JSON.parse(Utils.toUTF8(token.fields[2]))
      const tkid = Utils.toUTF8(token.fields[0])
      const tokenId = tkid === '___mint___' ? txid + '.' + String(outputIndex) : tkid
      const details: TokenDemoDetails = { tokenId, amount, customFields }

      await this.storage.storeRecord(txid, outputIndex, details)
    } catch (err) {
      const { txid, outputIndex } = payload as { txid: string; outputIndex: number }
      console.error(`TokenDemoLookupService: failed to index ${txid}.${outputIndex}`, err)
    }
  }

  async outputSpent(payload: OutputSpent): Promise<void> {
    if (payload.mode !== 'none') throw new Error('Invalid mode')
    const { topic, txid, outputIndex } = payload
    if (topic === 'tm_tokendemo') await this.storage.deleteRecord(txid, outputIndex)
  }

  async outputEvicted(txid: string, outputIndex: number): Promise<void> {
    await this.storage.deleteRecord(txid, outputIndex)
  }

  async lookup(question: LookupQuestion): Promise<LookupFormula> {
    if (!question) throw new Error('A valid query must be provided!')
    if (question.service !== 'ls_tokendemo') throw new Error('Lookup service not supported!')

    const { tokenId, outpoint, limit = 50, skip = 0, sortOrder } = question.query as TokenDemoQuery

    if (limit < 0) throw new Error('Limit must be a non-negative number')
    if (skip < 0) throw new Error('Skip must be a non-negative number')

    if (outpoint) return this.storage.findByOutpoint(outpoint)
    if (tokenId) return this.storage.findByTokenId(tokenId, limit, skip, sortOrder)
    return this.storage.findAll(limit, skip, sortOrder)
  }

  async getDocumentation(): Promise<string> {
    return 'TokenDemo Lookup Service: find messages on-chain.'
  }

  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'TokenDemo Lookup Service',
      shortDescription: 'Find messages on-chain.'
    }
  }
}

function create(db: Db): TokenDemoLookupService { return new TokenDemoLookupService(new TokenDemoStorage(db)) }
export default create
