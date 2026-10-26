import {
  LookupService,
  LookupQuestion,
  LookupFormula,
  AdmissionMode,
  SpendNotificationMode,
  OutputAdmittedByTopic,
  OutputSpent
} from '@bsv/overlay'
import { AnyStorage } from './AnyStorage.js'
import { Db } from 'mongodb'
import {
  readDate,
  readInteger,
  readSortOrder,
  readString,
  requireLookupQuery,
  requireTxid
} from '../shared/queryValidation.js'

export class AnyLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'txid'

  constructor(public storage: AnyStorage) {}

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid mode')
    const { txid, outputIndex } = payload
    if (payload.topic !== 'tm_anytx') return

    try {
      await this.storage.storeRecord(txid, outputIndex)
    } catch (err) {
      console.error(`AnyLookupService: failed to index ${txid}.${outputIndex}`, err)
    }
  }

  async outputSpent(payload: OutputSpent): Promise<void> {
    if (payload.mode !== 'txid') throw new Error('Invalid mode')
    const { topic, txid, outputIndex, spendingTxid } = payload
    if (topic !== 'tm_anytx') return
    await this.storage.spendRecord(txid, outputIndex, spendingTxid)
  }

  async outputEvicted(txid: string, outputIndex: number): Promise<void> {
    await this.storage.deleteRecord(txid, outputIndex)
  }

  async lookup(question: LookupQuestion): Promise<LookupFormula> {
    const query = requireLookupQuery(question, 'ls_anytx', [
      'txid',
      'limit',
      'skip',
      'startDate',
      'endDate',
      'sortOrder'
    ])
    const txid = requireTxid(readString(query, 'txid', { maxBytes: 64 }))
    const limit = readInteger(query, 'limit', 50, 1, 100)
    const skip = readInteger(query, 'skip', 0, 0, 100000)
    const from = readDate(query, 'startDate')
    const to = readDate(query, 'endDate')
    const sortOrder = readSortOrder(query)
    if (from !== undefined && to !== undefined && from > to) {
      throw new Error('Invalid lookup query: startDate must not be after endDate')
    }

    if (txid) {
      const result = await this.storage.findByTxid(txid)
      return result === null ? [] : [result]
    }

    return await this.storage.findAll(limit, skip, from, to, sortOrder)
  }

  async getDocumentation(): Promise<string> {
    return 'Any Lookup Service: lookup your outputs.'
  }

  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'Any Lookup Service',
      shortDescription: 'Lookup your outputs.'
    }
  }
}

// Factory
function create(db: Db): AnyLookupService {
  return new AnyLookupService(new AnyStorage(db))
}
export default create
