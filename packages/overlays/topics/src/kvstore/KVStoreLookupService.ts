import { KVStoreStorageManager } from './KVStoreStorageManager.js'
import { AdmissionMode, LookupFormula, LookupQuestion, LookupService, OutputAdmittedByTopic, OutputSpent, SpendNotificationMode } from '@bsv/overlay'
import { PushDrop, Transaction, Utils } from '@bsv/sdk'
import { Db } from 'mongodb'
import { kvProtocol, KVStoreLookupResult, KVStoreQuery } from './types.js'

class KVStoreLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'

  private static readonly TOPIC = 'tm_kvstore'
  private static readonly SERVICE_ID = 'ls_kvstore'

  constructor(public storageManager: KVStoreStorageManager) { }

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid payload mode')

    const { txid, outputIndex, topic, lockingScript } = payload
    if (topic !== KVStoreLookupService.TOPIC) return

    try {
      const decoded = PushDrop.decode(lockingScript)

      const expectedFieldCount = Object.keys(kvProtocol).length
      const hasTagsField = decoded.fields.length === expectedFieldCount
      const isOldFormat = decoded.fields.length === expectedFieldCount - 1

      if (!isOldFormat && !hasTagsField) {
        throw new Error(`KVStore token must have ${expectedFieldCount - 1} or ${expectedFieldCount} fields, got ${decoded.fields.length}`)
      }

      const keyBuffer = decoded.fields[kvProtocol.key]
      if (!keyBuffer || keyBuffer.length === 0) throw new Error('KVStore tokens must have a non-empty key')

      const valueBuffer = decoded.fields[kvProtocol.value]
      if (!valueBuffer || valueBuffer.length === 0) throw new Error('KVStore tokens must have a non-empty value')

      let tags: string[] | undefined
      if (hasTagsField && decoded.fields[kvProtocol.tags]) {
        try {
          tags = JSON.parse(Utils.toUTF8(decoded.fields[kvProtocol.tags]))
        } catch (_e) {
          // Tags field is not valid JSON; treat as absent rather than failing admission
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
    this.validateQuerySelectors(query)

    const results = await this.storageManager.findWithFilters(
      {
        key: query.key,
        protocolID: query.protocolID,
        controller: query.controller,
        tags: query.tags
      },
      query.tagQueryMode ?? 'all',
      query.limit,
      query.skip,
      query.sortOrder
    )

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

  private validateQuerySelectors(query: KVStoreQuery): void {
    const hasSelector =
      (typeof query.key === 'string' && query.key.length > 0) ||
      (typeof query.controller === 'string' && query.controller.length > 0) ||
      (Array.isArray(query.protocolID) && query.protocolID.length === 2) ||
      (Array.isArray(query.tags) && query.tags.length > 0)

    if (!hasSelector) {
      throw new Error('Must specify at least one selector: key, controller, protocolID, or tags')
    }
  }

  private async historySelector(beef: number[], outputIndex: number, key?: string, protocolID?: string): Promise<boolean> {
    try {
      const tx = Transaction.fromBEEF(beef)
      const result = PushDrop.decode(tx.outputs[outputIndex].lockingScript)

      if (result.fields.length !== Object.keys(kvProtocol).length) return false
      if (!result.fields[kvProtocol.key] || !result.fields[kvProtocol.value] || !result.fields[kvProtocol.protocolID]) return false

      const outputKey = Utils.toUTF8(result.fields[kvProtocol.key])
      const outputProtocolID = Utils.toUTF8(result.fields[kvProtocol.protocolID])

      if (key !== undefined && outputKey !== key) return false
      if (protocolID !== undefined && outputProtocolID !== protocolID) return false

      return true
    } catch (_e) {
      // Malformed BEEF or script — output is not a valid KVStore token; exclude from history
      return false
    }
  }

  async getDocumentation(): Promise<string> {
    return 'KVStore Lookup Service: find KVStore key-value pairs stored on-chain with efficient lookups.'
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

function create(db: Db): KVStoreLookupService { return new KVStoreLookupService(new KVStoreStorageManager(db)) }
export default create
