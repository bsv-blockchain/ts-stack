import docs from './SlackThreadsLookupServiceDocs.md.js'
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

/**
 * Implements a lookup service for the SlackThread protocol.
 * Each admitted BRC‑48 Pay‑to‑Push‑Drop output stores **exactly one** UTF‑8 field – the thread hash.
 * This service indexes those thread hashes so they can be queried later.
 */
export class SlackThreadLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'

  constructor(public storage: SlackThreadsStorage) { }

  /**
   * Invoked when a new output is added to the overlay.
   * @param payload 
   */
  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid mode')
    const { topic, lockingScript, txid, outputIndex } = payload
    if (topic !== 'tm_slackthread') return

    try {
      const threadHash = lockingScript.chunks[1].data
      if (threadHash.length !== 32) throw new Error('Invalid SlackThread token: thread hash must be exactly 32 bytes')
      const threadHashString = Utils.toHex(threadHash)

      // Persist for future lookup
      await this.storage.storeRecord(txid, outputIndex, threadHashString)
    } catch (err) {
      console.error(`SlackThreadLookupService: failed to index ${txid}.${outputIndex}`, err)
    }
  }

  /**
   * Invoked when a UTXO is spent
   * @param payload - The output admitted by the topic manager
   */
  async outputSpent(payload: OutputSpent): Promise<void> {
    if (payload.mode !== 'none') throw new Error('Invalid mode')
    const { topic, txid, outputIndex } = payload
    if (topic !== 'tm_slackthread') return
    await this.storage.deleteRecord(txid, outputIndex)
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
    if (question.service !== 'ls_slackthread') throw new Error('Lookup service not supported!')

    const {
      threadHash,
      txid,
      limit = 50,
      skip = 0,
      startDate,
      endDate,
      sortOrder
    } = question.query as SlackThreadQuery

    // Basic validation
    if (limit < 0) throw new Error('Limit must be a non‑negative number')
    if (skip < 0) throw new Error('Skip must be a non‑negative number')

    const from = startDate ? new Date(startDate) : undefined
    const to = endDate ? new Date(endDate) : undefined
    if (from && isNaN(from.getTime())) throw new Error('Invalid startDate provided!')
    if (to && isNaN(to.getTime())) throw new Error('Invalid endDate provided!')

    if (threadHash) {
      return this.storage.findByThreadHash(threadHash, limit, skip, sortOrder)
    }

    if (txid) {
      return this.storage.findByTxid(txid, limit, skip, sortOrder)
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
      name: 'SlackThread Lookup Service',
      shortDescription: 'Find threads on‑chain.'
    }
  }
}

// Factory
export default (db: Db): SlackThreadLookupService => new SlackThreadLookupService(new SlackThreadsStorage(db))
