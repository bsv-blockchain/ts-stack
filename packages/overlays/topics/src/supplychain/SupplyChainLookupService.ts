import {
  LookupService,
  LookupQuestion,
  LookupFormula,
  AdmissionMode,
  SpendNotificationMode,
  OutputAdmittedByTopic,
  OutputSpent
} from '@bsv/overlay'
import { Utils } from '@bsv/sdk'
import { SupplyChainStorage } from './SupplyChainStorage.js'
import { Db } from 'mongodb'

export interface SupplyChainQuery {
  txid?: string
  chainId?: string
  limit?: number
  skip?: number
  startDate?: Date
  endDate?: Date
  sortOrder?: 'asc' | 'desc'
}

export class SupplyChainLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'txid'

  constructor(public storage: SupplyChainStorage) { }

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid mode')
    const { topic, txid, outputIndex, offChainValues } = payload
    if (topic !== 'tm_supplychain') return
    if (!offChainValues) throw new Error('Missing off-chain values')

    const offChainValuesString = Utils.toUTF8(offChainValues)
    const offChainValuesObject = JSON.parse(offChainValuesString)
    if (!offChainValuesObject.chainId) throw new Error('Missing chainId')

    try {
      await this.storage.storeRecord(txid, outputIndex, offChainValuesObject)
    } catch (err) {
      console.error(`SupplyChainLookupService: failed to index ${txid}.${outputIndex}`, err)
    }
  }

  async outputSpent(payload: OutputSpent): Promise<void> {
    if (payload.mode !== 'txid') throw new Error('Invalid mode')
    const { topic, txid, outputIndex, spendingTxid } = payload
    if (topic !== 'tm_supplychain') return
    await this.storage.spendRecord(txid, outputIndex, spendingTxid)
  }

  async outputEvicted(txid: string, outputIndex: number): Promise<void> {
    await this.storage.deleteRecord(txid, outputIndex)
  }

  async lookup(question: LookupQuestion): Promise<LookupFormula> {
    if (!question) throw new Error('A valid query must be provided!')
    if (question.service !== 'ls_supplychain') throw new Error('Lookup service not supported!')

    const { txid, chainId, limit = 50, skip = 0, startDate, endDate, sortOrder } = question.query as SupplyChainQuery

    if (limit < 0) throw new Error('Limit must be a non-negative number')
    if (skip < 0) throw new Error('Skip must be a non-negative number')

    const from = startDate ? new Date(startDate) : undefined
    const to = endDate ? new Date(endDate) : undefined
    if (from && Number.isNaN(from.getTime())) throw new Error('Invalid startDate provided!')
    if (to && Number.isNaN(to.getTime())) throw new Error('Invalid endDate provided!')

    if (txid) return this.storage.findByTxid(txid, limit, skip, sortOrder)
    if (chainId) return this.storage.findByChainId(chainId, limit, skip)
    return this.storage.findAll(limit, skip, from, to, sortOrder)
  }

  async getDocumentation(): Promise<string> {
    return 'SupplyChain Lookup Service: find files on-chain.'
  }

  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'SupplyChain Lookup Service',
      shortDescription: 'Find files on-chain.'
    }
  }
}

function create(db: Db): SupplyChainLookupService { return new SupplyChainLookupService(new SupplyChainStorage(db)) }
export default create
