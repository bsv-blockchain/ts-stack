import { Reader, toUTF8 } from '@bsv/sdk/primitives/utils'
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
import { PushDrop } from '@bsv/sdk'
import { Db } from 'mongodb'
import { TokenDemoDetails } from './types.js'
import {
  readInteger,
  readSortOrder,
  readString,
  requireLookupQuery,
  requireOutpoint
} from '../shared/queryValidation.js'

export class TokenDemoLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'

  constructor(public storage: TokenDemoStorage) {}

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    try {
      if (payload.mode !== 'locking-script') throw new Error('Invalid mode')
      const { topic, lockingScript, txid, outputIndex } = payload
      if (topic !== 'tm_tokendemo') return

      const token = PushDrop.decode(lockingScript)
      const r = new Reader(token.fields[1])
      const amount = String(r.readUInt64LEBn())
      const customFields = JSON.parse(toUTF8(token.fields[2]))
      const tkid = toUTF8(token.fields[0])
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
    const query = requireLookupQuery(question, 'ls_tokendemo', [
      'tokenId',
      'outpoint',
      'limit',
      'skip',
      'sortOrder'
    ])
    const tokenId = readString(query, 'tokenId', { maxBytes: 256 })
    const outpointParts = requireOutpoint(readString(query, 'outpoint', { maxBytes: 75 }))
    const outpoint =
      outpointParts === undefined ? undefined : `${outpointParts.txid}.${outpointParts.outputIndex}`
    const limit = readInteger(query, 'limit', 50, 1, 100)
    const skip = readInteger(query, 'skip', 0, 0, 100000)
    const sortOrder = readSortOrder(query)

    if (outpoint) return await this.storage.findByOutpoint(outpoint)
    if (tokenId) return await this.storage.findByTokenId(tokenId, limit, skip, sortOrder)
    return await this.storage.findAll(limit, skip, sortOrder)
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

function create(db: Db): TokenDemoLookupService {
  return new TokenDemoLookupService(new TokenDemoStorage(db))
}
export default create
