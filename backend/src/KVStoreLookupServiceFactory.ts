import { KVStoreStorageManager } from './KVStoreStorageManager.js'
import { AdmissionMode, LookupFormula, LookupQuestion, LookupService, OutputAdmittedByTopic, OutputSpent, SpendNotificationMode } from '@bsv/overlay'
import { PushDrop, Transaction, Utils } from '@bsv/sdk'
import docs from './docs/KVStoreLookupDocs.md.js'
import { Db } from 'mongodb'
import { KVStoreQuery } from './types.js'

/**
 * Implements a lookup service for KVStore tokens
 * @public
 */
class KVStoreLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'

  private static readonly TOPIC = 'tm_kvstore'
  private static readonly SERVICE_ID = 'ls_kvstore'

  constructor(public storageManager: KVStoreStorageManager) { }

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') {
      throw new Error('Invalid payload mode')
    }

    const { txid, outputIndex, topic, lockingScript } = payload
    if (topic !== KVStoreLookupService.TOPIC) {
      return
    }

    try {
      const decoded = PushDrop.decode(lockingScript)

      if (decoded.fields.length !== 3) {
        throw new Error(`KVStore token must have exactly two PushDrop fields (protectedKey and value) + signature, got ${decoded.fields.length} fields`)
      }

      const protectedKeyBuffer = decoded.fields[0]
      if (protectedKeyBuffer.length !== 32) {
        throw new Error(`KVStore tokens have 32-byte protected keys, but this token has ${protectedKeyBuffer.length} bytes`)
      }

      const protectedKey = Utils.toBase64(protectedKeyBuffer)
      await this.storageManager.storeRecord(txid, outputIndex, protectedKey)
    } catch (error) {
      throw error
    }
  }

  async outputSpent(payload: OutputSpent): Promise<void> {
    if (payload.mode !== 'none') throw new Error('Invalid payload mode')
    const { topic, txid, outputIndex } = payload
    if (topic !== KVStoreLookupService.TOPIC) return

    await this.storageManager.deleteRecord(txid, outputIndex)
  }

  async outputEvicted(txid: string, outputIndex: number): Promise<void> {
    await this.storageManager.deleteRecord(txid, outputIndex)
  }

  async lookup(question: LookupQuestion): Promise<LookupFormula> {
    if (question.query === undefined || question.query === null) {
      throw new Error('A valid query must be provided')
    }
    if (question.service !== KVStoreLookupService.SERVICE_ID) {
      throw new Error('Lookup service not supported')
    }

    const query = (question.query as KVStoreQuery)

    if (query.protectedKey) {
      return await this.storageManager.findByProtectedKey(
        query.protectedKey,
        query.limit,
        query.skip,
        query.sortOrder
      )
    }

    const allResults = await this.storageManager.findAllRecords(
      query.limit,
      query.skip,
      query.sortOrder
    )

    for (const i in allResults) {
      allResults[i].history = async (beef, outputIndex, currentDepth) => {
        return await this.historySelector(beef, outputIndex, currentDepth)
      }
    }

    return allResults
  }

  /**
   * History selector for determining which outputs to include in chain tracking
   */
  private async historySelector(beef: number[], outputIndex: number, currentDepth: number): Promise<boolean> {
    try {
      const tx = Transaction.fromBEEF(beef)
      const result = PushDrop.decode(tx.outputs[outputIndex].lockingScript)

      if (result.fields.length !== 3) {
        return false
      }

      if (result.fields[0].length !== 32) {
        return false
      }

      return true
    } catch (error) {
      return false
    }
  }

  async getDocumentation(): Promise<string> {
    return docs
  }

  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'KVStore Lookup Service',
      shortDescription: 'Find KVStore key-value pairs stored on-chain with efficient lookups by protected key.'
    }
  }
}

// Factory function
export default (db: Db): KVStoreLookupService => {
  return new KVStoreLookupService(new KVStoreStorageManager(db))
}
