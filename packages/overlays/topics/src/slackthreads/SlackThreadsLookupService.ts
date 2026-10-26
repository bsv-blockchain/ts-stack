import { toHex } from '@bsv/sdk/primitives/utils'
import {
  LookupService,
  LookupQuestion,
  LookupFormula,
  AdmissionMode,
  SpendNotificationMode,
  OutputAdmittedByTopic,
  OutputSpent
} from '@bsv/overlay'
import { SlackThreadsStorage } from './SlackThreadsStorage.js'
import { Db } from 'mongodb'
import {
  readDate,
  readInteger,
  readSortOrder,
  readString,
  requireHex,
  requireLookupQuery,
  requireTxid
} from '../shared/queryValidation.js'

export interface SlackThreadQuery {
  threadHash?: string
  txid?: string
  limit?: number
  skip?: number
  startDate?: Date
  endDate?: Date
  sortOrder?: 'asc' | 'desc'
}

export class SlackThreadLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'

  constructor(public storage: SlackThreadsStorage) {}

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid mode')
    const { topic, lockingScript, txid, outputIndex } = payload
    if (topic !== 'tm_slackthread') return

    try {
      const threadHash = lockingScript.chunks[1].data
      if (threadHash === undefined || threadHash.length !== 32)
        throw new Error('Invalid SlackThread token: thread hash must be exactly 32 bytes')
      const threadHashString = toHex(threadHash)
      await this.storage.storeRecord(txid, outputIndex, threadHashString)
    } catch (err) {
      console.error(`SlackThreadLookupService: failed to index ${txid}.${outputIndex}`, err)
    }
  }

  async outputSpent(payload: OutputSpent): Promise<void> {
    if (payload.mode !== 'none') throw new Error('Invalid mode')
    const { topic, txid, outputIndex } = payload
    if (topic !== 'tm_slackthread') return
    await this.storage.deleteRecord(txid, outputIndex)
  }

  async outputEvicted(txid: string, outputIndex: number): Promise<void> {
    await this.storage.deleteRecord(txid, outputIndex)
  }

  async lookup(question: LookupQuestion): Promise<LookupFormula> {
    const query = requireLookupQuery(question, 'ls_slackthread', [
      'threadHash',
      'txid',
      'limit',
      'skip',
      'startDate',
      'endDate',
      'sortOrder'
    ])
    const threadHash = requireHex(
      readString(query, 'threadHash', { maxBytes: 64 }),
      'threadHash',
      32
    )
    const txid = requireTxid(readString(query, 'txid', { maxBytes: 64 }))
    const limit = readInteger(query, 'limit', 50, 1, 100)
    const skip = readInteger(query, 'skip', 0, 0, 100000)
    const from = readDate(query, 'startDate')
    const to = readDate(query, 'endDate')
    const sortOrder = readSortOrder(query)
    if (from !== undefined && to !== undefined && from > to) {
      throw new Error('Invalid lookup query: startDate must not be after endDate')
    }

    if (threadHash) return await this.storage.findByThreadHash(threadHash, limit, skip, sortOrder)
    if (txid) return await this.storage.findByTxid(txid, limit, skip, sortOrder)
    return await this.storage.findAll(limit, skip, from, to, sortOrder)
  }

  async getDocumentation(): Promise<string> {
    return 'SlackThread Lookup Service: find threads on-chain.'
  }

  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'SlackThread Lookup Service',
      shortDescription: 'Find threads on-chain.'
    }
  }
}

function create(db: Db): SlackThreadLookupService {
  return new SlackThreadLookupService(new SlackThreadsStorage(db))
}
export default create
