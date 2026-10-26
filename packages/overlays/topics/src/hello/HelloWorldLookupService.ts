import { toUTF8 } from '@bsv/sdk/primitives/utils'
import {
  LookupService,
  LookupQuestion,
  LookupFormula,
  AdmissionMode,
  SpendNotificationMode,
  OutputAdmittedByTopic,
  OutputSpent
} from '@bsv/overlay'
import { HelloWorldStorage } from './HelloWorldStorage.js'
import { PushDrop } from '@bsv/sdk'
import { Db } from 'mongodb'
import {
  readDate,
  readInteger,
  readSortOrder,
  readString,
  requireLookupQuery
} from '../shared/queryValidation.js'

export interface HelloWorldQuery {
  message?: string
  limit?: number
  skip?: number
  startDate?: Date
  endDate?: Date
  sortOrder?: 'asc' | 'desc'
}

export class HelloWorldLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'

  constructor(public storage: HelloWorldStorage) {}

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    try {
      if (payload.mode !== 'locking-script') throw new Error('Invalid mode')
      const { lockingScript, txid, outputIndex } = payload
      if (payload.topic !== 'tm_helloworld') return

      const result = PushDrop.decode(lockingScript)
      if (!result.fields || result.fields.length < 1)
        throw new Error('Invalid HelloWorld token: wrong field count')

      const message = toUTF8(result.fields[0])
      if (message.length < 2) throw new Error('Invalid HelloWorld token: message too short')

      await this.storage.storeRecord(txid, outputIndex, message)
    } catch (err) {
      const { txid, outputIndex } = payload as { txid: string; outputIndex: number }
      console.error(`HelloWorldLookupService: failed to index ${txid}.${outputIndex}`, err)
    }
  }

  async outputSpent(payload: OutputSpent): Promise<void> {
    if (payload.mode !== 'none') throw new Error('Invalid mode')
    const { topic, txid, outputIndex } = payload
    if (topic === 'tm_helloworld') await this.storage.deleteRecord(txid, outputIndex)
  }

  async outputEvicted(txid: string, outputIndex: number): Promise<void> {
    await this.storage.deleteRecord(txid, outputIndex)
  }

  async lookup(question: LookupQuestion): Promise<LookupFormula> {
    const query = requireLookupQuery(question, 'ls_helloworld', [
      'message',
      'limit',
      'skip',
      'startDate',
      'endDate',
      'sortOrder'
    ])
    const message = readString(query, 'message', { maxBytes: 1000 })
    const limit = readInteger(query, 'limit', 50, 1, 100)
    const skip = readInteger(query, 'skip', 0, 0, 100000)
    const from = readDate(query, 'startDate')
    const to = readDate(query, 'endDate')
    const sortOrder = readSortOrder(query)
    if (from !== undefined && to !== undefined && from > to) {
      throw new Error('Invalid lookup query: startDate must not be after endDate')
    }

    if (message) return await this.storage.findByMessage(message, limit, skip, sortOrder)
    return await this.storage.findAll(limit, skip, from, to, sortOrder)
  }

  async getDocumentation(): Promise<string> {
    return 'HelloWorld Lookup Service: find messages on-chain.'
  }

  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'HelloWorld Lookup Service',
      shortDescription: 'Find messages on-chain.'
    }
  }
}

function create(db: Db): HelloWorldLookupService {
  return new HelloWorldLookupService(new HelloWorldStorage(db))
}
export default create
