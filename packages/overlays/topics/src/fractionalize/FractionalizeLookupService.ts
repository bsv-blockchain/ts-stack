import {
  LookupService,
  LookupQuestion,
  LookupFormula,
  AdmissionMode,
  SpendNotificationMode,
  OutputAdmittedByTopic,
  OutputSpent
} from '@bsv/overlay'
import { FractionalizeStorage } from './FractionalizeStorage.js'
import { Db } from 'mongodb'
import {
  readDate,
  readInteger,
  readSortOrder,
  readString,
  requireLookupQuery,
  requireTxid
} from '../shared/queryValidation.js'

export class FractionalizeLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'txid'

  constructor(public storage: FractionalizeStorage) {}

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid mode')
    const { txid, outputIndex } = payload
    if (payload.topic !== 'tm_fractionalize') return
    try {
      await this.storage.storeRecord(txid, outputIndex)
    } catch (err) {
      console.error(`FractionalizeLookupService: failed to index ${txid}.${outputIndex}`, err)
    }
  }

  async outputSpent(payload: OutputSpent): Promise<void> {
    if (payload.mode !== 'txid') throw new Error('Invalid mode')
    const { topic, txid, outputIndex, spendingTxid } = payload
    if (topic !== 'tm_fractionalize') return
    await this.storage.spendRecord(txid, outputIndex, spendingTxid)
  }

  async outputEvicted(txid: string, outputIndex: number): Promise<void> {
    await this.storage.deleteRecord(txid, outputIndex)
  }

  async lookup(question: LookupQuestion): Promise<LookupFormula> {
    const query = requireLookupQuery(question, 'ls_fractionalize', [
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
    return 'Fractionalize Lookup Service: lookup your outputs.'
  }

  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'Fractionalize Lookup Service',
      shortDescription: 'Lookup your outputs.'
    }
  }
}

function create(db: Db): FractionalizeLookupService {
  return new FractionalizeLookupService(new FractionalizeStorage(db))
}
export default create
