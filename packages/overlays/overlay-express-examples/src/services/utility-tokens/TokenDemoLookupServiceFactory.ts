import docs from './TokenDemoLookupDocs.md'
import {
  LookupService,
  LookupQuestion,
  LookupFormula,
  AdmissionMode,
  SpendNotificationMode,
  OutputAdmittedByTopic,
  OutputSpent
} from '@bsv/overlay'
import { TokenDemoStorage } from './TokenDemoStorage.js'
import { PushDrop, Utils } from '@bsv/sdk'
import { Db } from 'mongodb'
import { TokenDemoDetails, TokenDemoQuery } from './types.js'

/**
 * Implements a lookup service for the Hello‑World protocol.
 * Each admitted BRC‑48 Pay‑to‑Push‑Drop output stores **exactly one** UTF‑8 field – the message.
 * This service indexes those messages so they can be queried later.
 */
export class TokenDemoLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'

  constructor(public storage: TokenDemoStorage) { }

  /**
   * Invoked when a new output is added to the overlay.
   * @param payload 
   */
  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    try {
      if (payload.mode !== 'locking-script') throw new Error('Invalid mode')
      const { topic, lockingScript, txid, outputIndex } = payload
      if (topic !== 'tm_tokendemo') return

      // Decode the PushDrop token
      const token = PushDrop.decode(lockingScript)
      const r = new Utils.Reader(token.fields[1])
      const amount = String(r.readUInt64LEBn())
      const customFields = JSON.parse(Utils.toUTF8(token.fields[2]))
      const tkid = Utils.toUTF8(token.fields[0])
      const tokenId = tkid === '___mint___' ? txid + '.' + String(outputIndex) : tkid
      const details: TokenDemoDetails = {
        tokenId,
        amount,
        customFields
      }

      // Persist for future lookup
      await this.storage.storeRecord(txid, outputIndex, details)
    } catch (err) {
      const { txid, outputIndex } = payload as { txid: string; outputIndex: number }
      console.error(`TokenDemoLookupService: failed to index ${txid}.${outputIndex}`, err)
    }
  }

  /**
   * Invoked when a UTXO is spent
   * @param payload - The output admitted by the topic manager
   */
  async outputSpent(payload: OutputSpent): Promise<void> {
    if (payload.mode !== 'none') throw new Error('Invalid mode')
    const { topic, txid, outputIndex } = payload
    if (topic === 'tm_tokendemo') {
      await this.storage.deleteRecord(txid, outputIndex)
    }
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
    if (question.service !== 'ls_tokendemo') throw new Error('Lookup service not supported!')

    const {
      tokenId,
      outpoint,
      limit = 50,
      skip = 0,
      startDate,
      endDate,
      sortOrder
    } = question.query as TokenDemoQuery

    // Basic validation
    if (limit < 0) throw new Error('Limit must be a non‑negative number')
    if (skip < 0) throw new Error('Skip must be a non‑negative number')

    const from = startDate ? new Date(startDate) : undefined
    const to = endDate ? new Date(endDate) : undefined
    if (from && isNaN(from.getTime())) throw new Error('Invalid startDate provided!')
    if (to && isNaN(to.getTime())) throw new Error('Invalid endDate provided!')

    if (outpoint) 
      return this.storage.findByOutpoint(outpoint)

    if (tokenId)
      return this.storage.findByTokenId(tokenId, limit, skip, sortOrder)

    return this.storage.findAll(limit, skip, sortOrder)
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
      name: 'TokenDemo Lookup Service',
      shortDescription: 'Find messages on‑chain.'
    }
  }
}

// Factory
export default (db: Db): TokenDemoLookupService => new TokenDemoLookupService(new TokenDemoStorage(db))
