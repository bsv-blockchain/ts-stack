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
import { SupplyChainStorage } from './SupplyChainStorage.js'
import { Db } from 'mongodb'
import {
  readDate,
  readInteger,
  readSortOrder,
  readString,
  requireLookupQuery,
  requireTxid
} from '../shared/queryValidation.js'

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

  constructor(public storage: SupplyChainStorage) {}

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid mode')
    const { topic, txid, outputIndex, offChainValues } = payload
    if (topic !== 'tm_supplychain') return
    if (!offChainValues) throw new Error('Missing off-chain values')

    const offChainValuesString = toUTF8(offChainValues)
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
    const query = requireLookupQuery(question, 'ls_supplychain', [
      'txid',
      'chainId',
      'limit',
      'skip',
      'startDate',
      'endDate',
      'sortOrder'
    ])
    const txid = requireTxid(readString(query, 'txid', { maxBytes: 64 }))
    const chainId = readString(query, 'chainId', { maxBytes: 256 })
    const limit = readInteger(query, 'limit', 50, 1, 100)
    const skip = readInteger(query, 'skip', 0, 0, 100000)
    const from = readDate(query, 'startDate')
    const to = readDate(query, 'endDate')
    const sortOrder = readSortOrder(query)
    if (from !== undefined && to !== undefined && from > to) {
      throw new Error('Invalid lookup query: startDate must not be after endDate')
    }

    if (txid) return await this.storage.findByTxid(txid, limit, skip, sortOrder)
    if (chainId) return await this.storage.findByChainId(chainId, limit, skip)
    return await this.storage.findAll(limit, skip, from, to, sortOrder)
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

function create(db: Db): SupplyChainLookupService {
  return new SupplyChainLookupService(new SupplyChainStorage(db))
}
export default create
