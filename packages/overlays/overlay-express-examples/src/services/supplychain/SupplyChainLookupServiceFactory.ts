import docs from './SupplyChainLookupServiceDocs.md.js'
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

/**
 * Implements a lookup service for the SupplyChain protocol.
 * Each admitted BRC‑48 Pay‑to‑Push‑Drop output stores **exactly one** UTF‑8 field – the thread hash.
 * This service indexes those thread hashes so they can be queried later.
 */
export class SupplyChainLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'txid'

  constructor(public storage: SupplyChainStorage) { }

  /**
   * Invoked when a new output is added to the overlay.
   * @param payload 
   */
  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid mode')
    const { topic, lockingScript, txid, outputIndex, offChainValues } = payload
    if (topic !== 'tm_supplychain') return
    // Make sure offChainValues exists
    if (!offChainValues) throw new Error('Missing off-chain values')

    // Change offChainValues from number[] back to utf8 object (originally a json string)
    const offChainValuesString = Utils.toUTF8(offChainValues)
    const offChainValuesObject = JSON.parse(offChainValuesString)
    if (!offChainValuesObject.chainId) throw new Error('Missing chainId')
    console.log("SupplyChain LookupService offChainValuesObject:", offChainValuesObject)

    try {
      // Persist for future lookup
      await this.storage.storeRecord(txid, outputIndex, offChainValuesObject)
    } catch (err) {
      console.error(`SupplyChainLookupService: failed to index ${txid}.${outputIndex}`, err)
    }
  }

  /**
   * Invoked when a UTXO is spent
   * @param payload - The output admitted by the topic manager
   */
  async outputSpent(payload: OutputSpent): Promise<void> {
    if (payload.mode !== 'txid') throw new Error('Invalid mode')
    const { topic, txid, outputIndex, spendingTxid } = payload
    if (topic !== 'tm_supplychain') return
    await this.storage.spendRecord(txid, outputIndex, spendingTxid)
  }

  /**
   * LEGAL EVICTION: Permanently remove the referenced UTXO from all indices maintained by the Lookup Service
   * @param txid - The transaction ID of the output to evict
   * @param outputIndex - The index of the output to evict
   */
  async outputEvicted(txid: string, outputIndex: number): Promise<void> {
    await this.storage.deleteRecord(txid, outputIndex)
  }

  /**
   * Answers a lookup query
   * @param question - The lookup question to be answered
   * @returns A promise that resolves to a lookup answer or formula
   */
  async lookup(question: LookupQuestion): Promise<LookupFormula> {
    if (!question) throw new Error('A valid query must be provided!')
    if (question.service !== 'ls_supplychain') throw new Error('Lookup service not supported!')

    const {
      txid,
      chainId,
      limit = 50,
      skip = 0,
      startDate,
      endDate,
      sortOrder
    } = question.query as SupplyChainQuery

    // Basic validation
    if (limit < 0) throw new Error('Limit must be a non‑negative number')
    if (skip < 0) throw new Error('Skip must be a non‑negative number')

    const from = startDate ? new Date(startDate) : undefined
    const to = endDate ? new Date(endDate) : undefined
    if (from && isNaN(from.getTime())) throw new Error('Invalid startDate provided!')
    if (to && isNaN(to.getTime())) throw new Error('Invalid endDate provided!')

    if (txid) {
      return this.storage.findByTxid(txid, limit, skip, sortOrder)
    }

    if (chainId) {
      return this.storage.findByChainId(chainId, limit, skip)
    }

    return this.storage.findAll(limit, skip, from, to, sortOrder)
  }

  /** Overlay docs. */
  async getDocumentation(): Promise<string> {
    return docs
  }

  /** Metadata for overlay hosts. */
  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'SupplyChain Lookup Service',
      shortDescription: 'Find files on‑chain.'
    }
  }
}

// Factory
export default (db: Db): SupplyChainLookupService => new SupplyChainLookupService(new SupplyChainStorage(db))
