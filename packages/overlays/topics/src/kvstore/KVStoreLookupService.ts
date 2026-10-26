import { KVStoreStorageManager } from './KVStoreStorageManager.js'
import {
  AdmissionMode,
  LookupFormula,
  LookupQuestion,
  LookupService,
  OutputAdmittedByTopic,
  OutputSpent,
  SpendNotificationMode
} from '@bsv/overlay'
import { decodeAndVerifyKVStoreToken, Transaction } from '@bsv/sdk'
import { Db } from 'mongodb'
import { KVStoreLookupResult } from './types.js'
import {
  readBoolean,
  readInteger,
  readSortOrder,
  readString,
  readStringArray,
  readWalletProtocol,
  requireLookupQuery,
  requirePublicKey
} from '../shared/queryValidation.js'

export class KVStoreLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'

  private static readonly TOPIC = 'tm_kvstore'
  private static readonly SERVICE_ID = 'ls_kvstore'

  constructor(public storageManager: KVStoreStorageManager) {}

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid payload mode')

    const { txid, outputIndex, topic, lockingScript } = payload
    if (topic !== KVStoreLookupService.TOPIC) return

    try {
      const decoded = await decodeAndVerifyKVStoreToken(lockingScript)

      await this.storageManager.storeRecord(
        txid,
        outputIndex,
        decoded.key,
        decoded.protocolIDText,
        decoded.controller,
        decoded.tags
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
    const query = requireLookupQuery(question, KVStoreLookupService.SERVICE_ID, [
      'key',
      'controller',
      'protocolID',
      'tags',
      'tagQueryMode',
      'limit',
      'skip',
      'sortOrder',
      'history'
    ])
    const key = readString(query, 'key', { maxBytes: 1000 })
    const controller = requirePublicKey(
      readString(query, 'controller', { maxBytes: 66 }),
      'controller'
    )
    const protocolID = readWalletProtocol(query, 'protocolID')
    const tags = readStringArray(query, 'tags', { maxItems: 32, maxItemBytes: 256 })
    const tagQueryMode = query.tagQueryMode ?? 'all'
    if (tagQueryMode !== 'all' && tagQueryMode !== 'any')
      throw new Error('Invalid lookup query: tagQueryMode must be all or any')
    const limit = readInteger(query, 'limit', 50, 1, 100)
    const skip = readInteger(query, 'skip', 0, 0, 100000)
    const sortOrder = readSortOrder(query)
    const history = readBoolean(query, 'history')

    if (
      key === undefined &&
      controller === undefined &&
      protocolID === undefined &&
      tags === undefined
    ) {
      throw new Error('Must specify at least one selector: key, controller, protocolID, or tags')
    }

    const results = await this.storageManager.findWithFilters(
      {
        key,
        protocolID,
        controller,
        tags
      },
      tagQueryMode,
      limit,
      skip,
      sortOrder
    )

    const lookupResults: KVStoreLookupResult[] = []

    for (const i in results) {
      lookupResults.push({
        txid: results[i].txid,
        outputIndex: results[i].outputIndex,
        history: history
          ? async (beef: number[], outputIndex: number, _currentDepth: number) => {
              return await this.historySelector(
                beef,
                outputIndex,
                results[i].key,
                results[i].protocolID
              )
            }
          : undefined
      })
    }

    return lookupResults
  }

  private async historySelector(
    beef: number[],
    outputIndex: number,
    key?: string,
    protocolID?: string
  ): Promise<boolean> {
    try {
      const tx = Transaction.fromBEEF(beef)
      const output = tx.outputs[outputIndex]
      if (output?.lockingScript == null) return false
      const result = await decodeAndVerifyKVStoreToken(output.lockingScript)

      if (key !== undefined && result.key !== key) return false
      if (protocolID !== undefined && result.protocolIDText !== protocolID) return false

      return true
    } catch {
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
      shortDescription:
        'Find KVStore key-value pairs stored on-chain with efficient lookups by protected key.'
    }
  }
}

function create(db: Db): KVStoreLookupService {
  return new KVStoreLookupService(new KVStoreStorageManager(db))
}
export default create
