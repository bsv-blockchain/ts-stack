import docs from './AnyLookupDocs.md.js'
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
import { AnyQuery } from './types.js'

/**
 * Implements a lookup service for the Hello‑World protocol.
 * Each admitted BRC‑48 Pay‑to‑Push‑Drop output stores **exactly one** UTF‑8 field – the message.
 * This service indexes those messages so they can be queried later.
 */
export class AnyLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'txid'

  constructor(public storage: AnyStorage) { }

  /**
   * Invoked when a new output is added to the overlay.
   * @param payload 
   */
  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid mode')
    const { topic, txid, outputIndex } = payload
    if (payload.topic !== 'tm_anytx') return

    try {
      await this.storage.storeRecord(txid, outputIndex)
    } catch (err) {
      console.error(`AnyLookupService: failed to index ${txid}.${outputIndex}`, err)
    }
  }

  /**
   * Invoked when a UTXO is spent
   * @param payload - The output admitted by the topic manager
   */
  async outputSpent(payload: OutputSpent): Promise<void> {
    if (payload.mode !== 'txid') throw new Error('Invalid mode')
    const { topic, txid, outputIndex, spendingTxid} = payload
    if (topic !== 'tm_anytx') return 
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
    if (question.service !== 'ls_anytx') throw new Error('Lookup service not supported!')

    const {
      txid,
      limit = 50,
      skip = 0,
      startDate,
      endDate,
      sortOrder
    } = question.query as AnyQuery

    // Basic validation
    if (limit < 0) throw new Error('Limit must be a non‑negative number')
    if (skip < 0) throw new Error('Skip must be a non‑negative number')

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
      name: 'Any Lookup Service',
      shortDescription: 'Lookup your outputs.'
    }
  }
}

// Factory
export default (db: Db): AnyLookupService => new AnyLookupService(new AnyStorage(db))
