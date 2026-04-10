import docs from './DesktopIntegrityLookupServiceDocs.md.js'
import {
  LookupService,
  LookupQuestion,
  LookupFormula,
  AdmissionMode,
  SpendNotificationMode,
  OutputAdmittedByTopic,
  OutputSpent
} from '@bsv/overlay'
import { DesktopIntegrityStorage } from './DesktopIntegrityStorage.js'
import { Utils } from '@bsv/sdk'
import { Db } from 'mongodb'

export interface DesktopIntegrityQuery {
  fileHash?: string
  txid?: string
  limit?: number
  skip?: number
  startDate?: Date
  endDate?: Date
  sortOrder?: 'asc' | 'desc'
}

/**
 * Implements a lookup service for the DesktopIntegrity protocol.
 * Each admitted BRC‑48 Pay‑to‑Push‑Drop output stores **exactly one** UTF‑8 field – the thread hash.
 * This service indexes those thread hashes so they can be queried later.
 */
export class DesktopIntegrityLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'

  constructor(public storage: DesktopIntegrityStorage) { }

  /**
   * Invoked when a new output is added to the overlay.
   * @param payload 
   */
  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid mode')
    const { topic, lockingScript, txid, outputIndex, offChainValues } = payload
    if (topic !== 'tm_desktopintegrity') return

    try {
      const fileHash = lockingScript.chunks[1].data
      if (fileHash[0] !== 32 || fileHash.length !== 33) throw new Error('Invalid DesktopIntegrity token: file hash must be exactly 32 bytes')
      const fileHashString = Utils.toHex(fileHash.slice(1))

      // Persist for future lookup
      await this.storage.storeRecord(txid, outputIndex, fileHashString, offChainValues)
    } catch (err) {
      console.error(`DesktopIntegrityLookupService: failed to index ${txid}.${outputIndex}`, err)
    }
  }

  /**
   * Invoked when a UTXO is spent
   * @param payload - The output admitted by the topic manager
   */
  async outputSpent(payload: OutputSpent): Promise<void> {
    if (payload.mode !== 'none') throw new Error('Invalid mode')
    const { topic, txid, outputIndex } = payload
    if (topic !== 'tm_desktopintegrity') return
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
    if (question.service !== 'ls_desktopintegrity') throw new Error('Lookup service not supported!')

    const {
      fileHash,
      txid,
      limit = 50,
      skip = 0,
      startDate,
      endDate,
      sortOrder
    } = question.query as DesktopIntegrityQuery

    // Basic validation
    if (limit < 0) throw new Error('Limit must be a non‑negative number')
    if (skip < 0) throw new Error('Skip must be a non‑negative number')

    const from = startDate ? new Date(startDate) : undefined
    const to = endDate ? new Date(endDate) : undefined
    if (from && isNaN(from.getTime())) throw new Error('Invalid startDate provided!')
    if (to && isNaN(to.getTime())) throw new Error('Invalid endDate provided!')

    if (fileHash) {
      return this.storage.findByFileHash(fileHash, limit, skip, sortOrder)
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
      name: 'DesktopIntegrity Lookup Service',
      shortDescription: 'Find files on‑chain.'
    }
  }
}

// Factory
export default (db: Db): DesktopIntegrityLookupService => new DesktopIntegrityLookupService(new DesktopIntegrityStorage(db))
