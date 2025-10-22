import { KVStoreStorageManager } from './KVStoreStorageManager.js'
import { AdmissionMode, LookupFormula, LookupQuestion, LookupService, OutputAdmittedByTopic, OutputSpent, SpendNotificationMode } from '@bsv/overlay'
import { PushDrop, Transaction, Utils } from '@bsv/sdk'
import docs from './docs/KVStoreLookupDocs.md.js'
import { Db } from 'mongodb'
import { kvProtocol, KVStoreLookupResult, KVStoreQuery, KVStoreRecord } from './types.js'

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

      // Support backwards compatibility: old format without tags, new format with tags
      const expectedFieldCount = Object.keys(kvProtocol).length
      const hasTagsField = decoded.fields.length === expectedFieldCount
      const isOldFormat = decoded.fields.length === expectedFieldCount - 1
      
      if (!isOldFormat && !hasTagsField) {
        throw new Error(`KVStore token must have ${expectedFieldCount - 1} fields (old format) or ${expectedFieldCount} fields (with tags), got ${decoded.fields.length} fields`)
      }

      const keyBuffer = decoded.fields[kvProtocol.key]
      if (!keyBuffer || keyBuffer.length === 0) {
        throw new Error('KVStore tokens must have a non-empty key')
      }
      const valueBuffer = decoded.fields[kvProtocol.value]
      if (!valueBuffer || valueBuffer.length === 0) {
        throw new Error('KVStore tokens must have a non-empty value')
      }

      // Extract tags if present (backwards compatible)
      let tags: string[] | undefined
      if (hasTagsField && decoded.fields[kvProtocol.tags]) {
        try {
          const tagsBuffer = decoded.fields[kvProtocol.tags]
          tags = JSON.parse(Utils.toUTF8(tagsBuffer))
        } catch (e) {
          console.warn('Failed to parse tags from KVStore token:', e)
          tags = undefined
        }
      }

      await this.storageManager.storeRecord(
        txid,
        outputIndex,
        Utils.toUTF8(keyBuffer),
        Utils.toUTF8(decoded.fields[kvProtocol.protocolID]),
        Utils.toHex(decoded.fields[kvProtocol.controller]),
        tags
      )
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
    const hasFilters = query.key || query.protocolID || query.controller || (query.tags && query.tags.length > 0)

    let results: KVStoreRecord[]

    if (hasFilters) {
      // Use dynamic filtering for any combination of filters
      results = await this.storageManager.findWithFilters(
        {
          key: query.key,
          protocolID: query.protocolID,
          controller: query.controller,
          tags: query.tags
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

    const lookupResults: KVStoreLookupResult[] = []

    for (const i in results) {
      lookupResults.push({
        txid: results[i].txid,
        outputIndex: results[i].outputIndex,
        history: query.history ? async (beef: number[], outputIndex: number, currentDepth: number) => {
          return await this.historySelector(beef, outputIndex, results[i].key, results[i].protocolID)
        } : undefined
      })
    }

    return lookupResults
  }

  /**
   * History selector for determining which outputs to include in chain tracking
   * @param {number[]} beef - Transaction BEEF data
   * @param {number} outputIndex - Output index in the transaction
   * @param {string} [key] - Optional KVStore key for context
   * @param {string} [protocolID] - Optional protocolID for context
   */
  private async historySelector(beef: number[], outputIndex: number, key?: string, protocolID?: string): Promise<boolean> {
    try {
      const tx = Transaction.fromBEEF(beef)
      const result = PushDrop.decode(tx.outputs[outputIndex].lockingScript)

      // Validate protocol structure
      if (result.fields.length !== Object.keys(kvProtocol).length) {
        return false
      }

      // Validate required fields exist
      if (!result.fields[kvProtocol.key] || !result.fields[kvProtocol.value] || !result.fields[kvProtocol.protocolID]) {
        return false
      }

      // Extract the output's key and protocolID
      const outputKey = Utils.toUTF8(result.fields[kvProtocol.key])
      const outputProtocolID = Utils.toUTF8(result.fields[kvProtocol.protocolID])

      // If we have context (key/protocolID), only include outputs that match exactly
      if (key !== undefined && outputKey !== key) {
        return false
      }

      if (protocolID !== undefined && outputProtocolID !== protocolID) {
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
