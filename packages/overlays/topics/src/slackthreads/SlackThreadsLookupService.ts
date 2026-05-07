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
import { Utils } from '@bsv/sdk'
import { Db } from 'mongodb'

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

  constructor(public storage: SlackThreadsStorage) { }

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid mode')
    const { topic, lockingScript, txid, outputIndex } = payload
    if (topic !== 'tm_slackthread') return

    try {
      const threadHash = lockingScript.chunks[1].data
      if (threadHash.length !== 32) throw new Error('Invalid SlackThread token: thread hash must be exactly 32 bytes')
      const threadHashString = Utils.toHex(threadHash)
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
    if (!question) throw new Error('A valid query must be provided!')
    if (question.service !== 'ls_slackthread') throw new Error('Lookup service not supported!')

    const { threadHash, txid, limit = 50, skip = 0, startDate, endDate, sortOrder } = question.query as SlackThreadQuery

    if (limit < 0) throw new Error('Limit must be a non-negative number')
    if (skip < 0) throw new Error('Skip must be a non-negative number')

    const from = startDate ? new Date(startDate) : undefined
    const to = endDate ? new Date(endDate) : undefined
    if (from && Number.isNaN(from.getTime())) throw new Error('Invalid startDate provided!')
    if (to && Number.isNaN(to.getTime())) throw new Error('Invalid endDate provided!')

    if (threadHash) return this.storage.findByThreadHash(threadHash, limit, skip, sortOrder)
    if (txid) return this.storage.findByTxid(txid, limit, skip, sortOrder)
    return this.storage.findAll(limit, skip, from, to, sortOrder)
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

function create(db: Db): SlackThreadLookupService { return new SlackThreadLookupService(new SlackThreadsStorage(db)) }
export default create
