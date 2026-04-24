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
import { FractionalizeQuery } from './types.js'

export class FractionalizeLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'txid'

  constructor(public storage: FractionalizeStorage) { }

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
    if (!question) throw new Error('A valid query must be provided!')
    if (question.service !== 'ls_fractionalize') throw new Error('Lookup service not supported!')

    const { txid, limit = 50, skip = 0, startDate, endDate, sortOrder } = question.query as FractionalizeQuery

    if (limit < 0) throw new Error('Limit must be a non-negative number')
    if (skip < 0) throw new Error('Skip must be a non-negative number')

    const from = startDate ? new Date(startDate) : undefined
    const to = endDate ? new Date(endDate) : undefined
    if (from && isNaN(from.getTime())) throw new Error('Invalid startDate provided!')
    if (to && isNaN(to.getTime())) throw new Error('Invalid endDate provided!')

    if (txid) {
      const result = await this.storage.findByTxid(txid)
      return [result]
    }

    return await this.storage.findAll(limit, skip, from, to, sortOrder || 'desc')
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

export default (db: Db): FractionalizeLookupService => new FractionalizeLookupService(new FractionalizeStorage(db))
