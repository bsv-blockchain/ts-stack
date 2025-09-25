import { KVStoreStorageManager } from './KVStoreStorageManager.js'
import { AdmissionMode, LookupFormula, LookupQuestion, LookupService, OutputAdmittedByTopic, OutputSpent, SpendNotificationMode } from '@bsv/overlay'
import { PushDrop, Transaction, Utils } from '@bsv/sdk'
import docs from './docs/KVStoreLookupDocs.md.js'
import { Db } from 'mongodb'
import { kvProtocol, KVStoreQuery } from './types.js'

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

      if (decoded.fields.length !== Object.keys(kvProtocol).length) {
        throw new Error(`KVStore token must have exactly ${Object.keys(kvProtocol).length} PushDrop fields (protectedKey and value) + signature, got ${decoded.fields.length} fields`)
      }

      const protectedKeyBuffer = decoded.fields[kvProtocol.protectedKey]
      if (protectedKeyBuffer.length !== 32) {
        throw new Error(`KVStore tokens have 32-byte protected keys, but this token has ${protectedKeyBuffer.length} bytes`)
      }

      await this.storageManager.storeRecord(
        txid,
        outputIndex,
        Utils.toBase64(protectedKeyBuffer),
        Utils.toUTF8(decoded.fields[kvProtocol.namespace]),
        Utils.toHex(decoded.fields[kvProtocol.controller]))
    } catch (error) {
      console.error(error)
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

    // Check if we have any filters to apply
    const hasFilters = query.protectedKey || query.namespace || query.controller

    let results: any[]

    if (hasFilters) {
      // Use dynamic filtering for any combination of filters
      results = await this.storageManager.findWithFilters(
        {
          protectedKey: query.protectedKey,
          namespace: query.namespace,
          controller: query.controller
        },
        query.limit,
        query.skip,
        query.sortOrder
      )
    } else {
      // No filters - return all records
      results = await this.storageManager.findAllRecords(
        query.limit,
        query.skip,
        query.sortOrder
      )
    }

    for (const i in results) {
      results[i].history = async (beef: number[], outputIndex: number, currentDepth: number) => {
        return await this.historySelector(beef, outputIndex, currentDepth)
      }
    }

    return results
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
