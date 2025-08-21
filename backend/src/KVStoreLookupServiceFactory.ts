import { KVStoreStorageManager } from './KVStoreStorageManager.js'
import { AdmissionMode, LookupFormula, LookupQuestion, LookupService, OutputAdmittedByTopic, OutputSpent, SpendNotificationMode } from '@bsv/overlay'
import { PushDrop, Utils } from '@bsv/sdk'
import docs from './docs/KVStoreLookupDocs.md.js'
import { Db } from 'mongodb'
import { KVStoreQuery, KVStoreTokenData } from './types.js'

/**
 * Implements a lookup service for KVStore tokens
 * @public
 */
class KVStoreLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'

  private static readonly TOPIC = 'kvstore'
  private static readonly SERVICE_ID = 'ls_kvstore'

  constructor(public storageManager: KVStoreStorageManager) { }

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid payload')
    const { txid, outputIndex, topic, lockingScript } = payload
    if (topic !== KVStoreLookupService.TOPIC) return
    
    console.log(`KVStore lookup service outputAdded called with ${txid}.${outputIndex}`)
    
    // Decode the KVStore fields from the Bitcoin outputScript
    const decoded = PushDrop.decode(lockingScript)
    
    // KVStore protocol validation
    // Field structure: [pubkey, OP_CHECKSIG, protectedKey, value, signature, OP_DROP, OP_2DROP]
    // We extract the protectedKey (field 2 in the original JS, but field 0 in our decoded result)
    if (decoded.fields.length !== 2) {
      throw new Error('KVStore token must have exactly two PushDrop fields (protectedKey and value)')
    }

    // Extract and validate the protected key (first field)
    const protectedKeyBuffer = decoded.fields[0]
    if (protectedKeyBuffer.length !== 32) {
      throw new Error(`KVStore tokens have 32-byte protected keys, but this token has ${protectedKeyBuffer.length} bytes`)
    }

    // Convert to base64 for storage
    const protectedKey = Utils.toBase64(protectedKeyBuffer)

    console.log(
      'KVStore lookup service is storing a record',
      txid,
      outputIndex,
      'protectedKey:',
      protectedKey.substring(0, 10) + '...'
    )

    // Store KVStore record
    await this.storageManager.storeRecord(txid, outputIndex, protectedKey)
  }

  async outputSpent(payload: OutputSpent): Promise<void> {
    if (payload.mode !== 'none') throw new Error('Invalid payload')
    const { topic, txid, outputIndex } = payload
    if (topic !== KVStoreLookupService.TOPIC) return
    
    console.log(`KVStore lookup service outputSpent called with ${txid}.${outputIndex}`)
    await this.storageManager.deleteRecord(txid, outputIndex)
  }

  async outputEvicted(txid: string, outputIndex: number): Promise<void> {
    console.log(`KVStore lookup service outputEvicted called with ${txid}.${outputIndex}`)
    await this.storageManager.deleteRecord(txid, outputIndex)
  }

  async lookup(question: LookupQuestion): Promise<LookupFormula> {
    if (question.query === undefined || question.query === null) {
      throw new Error('A valid query must be provided!')
    }
    if (question.service !== KVStoreLookupService.SERVICE_ID) {
      throw new Error('Lookup service not supported!')
    }

    const query = (question.query as KVStoreQuery)

    // Protected key lookup
    if (query.protectedKey) {
      const results = await this.storageManager.findByProtectedKey(
        query.protectedKey,
        query.limit,
        query.skip,
        query.sortOrder
      )

      // Add history functionality if requested
      if (query.history !== undefined) {
        return results.map(result => ({
          ...result,
          history: async (output: any, currentDepth: number) => {
            return await this.historySelector(output, currentDepth, query.history)
          }
        }))
      }

      return results
    }

    // No specific query parameters - return all records
    return await this.storageManager.findAllRecords(
      query.limit,
      query.skip,
      query.sortOrder
    )
  }

  /**
   * History selector for determining which outputs to include in chain tracking
   */
  private async historySelector(
    output: any, 
    currentDepth: number, 
    historyRequested?: boolean
  ): Promise<boolean> {
    try {
      // If history is explicitly disabled and we're beyond depth 0, exclude
      if (historyRequested === false && currentDepth > 0) return false

      // Decode the output script to validate it's a KVStore token
      const result = PushDrop.decode(output.outputScript)

      if (result.fields.length !== 2) {
        const e = new Error(`KVStore tokens have two PushDrop fields, but this token has ${result.fields.length} fields!`) as Error & { code: string }
        e.code = 'ERR_WRONG_NUMBER_OF_FIELDS'
        throw e
      }

      if (result.fields[0].length !== 32) {
        const e = new Error(`KVStore tokens have 32-byte protected keys in their first PushDrop field, but the key for this token has ${result.fields[0].length} bytes!`) as Error & { code: string }
        e.code = 'ERR_INVALID_KEY_LENGTH'
        throw e
      }

      // Custom validation logic can be added here
      // For example, filtering based on value content:
      // const value = Utils.toUTF8(result.fields[1])
      // if (value.startsWith('system:')) return false // Skip system entries

    } catch (error) {
      // Probably not a valid KVStore token, log and skip
      console.log('History selector error:', error)
      return false
    }
    
    return true
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
