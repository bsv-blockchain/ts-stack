import { toUTF8 } from '@bsv/sdk/primitives/utils'
import { AppsStorageManager } from './AppsStorageManager.js'
import {
  AdmissionMode,
  LookupFormula,
  LookupQuestion,
  LookupService,
  OutputAdmittedByTopic,
  OutputSpent,
  SpendNotificationMode
} from '@bsv/overlay'
import { PushDrop } from '@bsv/sdk'
import { Db } from 'mongodb'
import { PublishedAppMetadata } from './types.js'
import {
  readInteger,
  readSortOrder,
  readString,
  readStringArray,
  requireLookupQuery,
  requireOutpoint,
  requirePublicKey
} from '../shared/queryValidation.js'

class AppsLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'

  private static readonly TOPIC = 'tm_apps'
  private static readonly SERVICE_ID = 'ls_apps'

  constructor(public storageManager: AppsStorageManager) {}

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid payload')
    const { txid, outputIndex, topic, lockingScript } = payload
    if (topic !== AppsLookupService.TOPIC) return

    const decoded = PushDrop.decode(lockingScript)
    if (decoded.fields.length !== 2)
      throw new Error('App token must have exactly one metadata field + signature')

    const metadataJSON = toUTF8(decoded.fields[0])
    let metadata: PublishedAppMetadata
    try {
      metadata = JSON.parse(metadataJSON)
    } catch {
      throw new Error('Metadata field is not valid JSON')
    }
    if (metadata == null) throw new Error('App token must contain valid metadata')

    await this.storageManager.storeRecord(txid, outputIndex, metadata)
  }

  async outputSpent(payload: OutputSpent): Promise<void> {
    if (payload.mode !== 'none') throw new Error('Invalid payload')
    const { topic, txid, outputIndex } = payload
    if (topic !== AppsLookupService.TOPIC) return
    await this.storageManager.deleteRecord(txid, outputIndex)
  }

  async outputEvicted(txid: string, outputIndex: number): Promise<void> {
    await this.storageManager.deleteRecord(txid, outputIndex)
  }

  async lookup(question: LookupQuestion): Promise<LookupFormula> {
    const query = requireLookupQuery(question, AppsLookupService.SERVICE_ID, [
      'domain',
      'publisher',
      'name',
      'outpoint',
      'tags',
      'category',
      'limit',
      'skip',
      'sortOrder'
    ])
    const domain = readString(query, 'domain', { maxBytes: 253 })
    const publisher = requirePublicKey(
      readString(query, 'publisher', { maxBytes: 66 }),
      'publisher'
    )
    const name = readString(query, 'name', { maxBytes: 200 })
    const outpointParts = requireOutpoint(readString(query, 'outpoint', { maxBytes: 75 }))
    const outpoint =
      outpointParts === undefined ? undefined : `${outpointParts.txid}.${outpointParts.outputIndex}`
    const tags = readStringArray(query, 'tags', { maxItems: 32, maxItemBytes: 100 })
    const category = readString(query, 'category', { maxBytes: 100 })
    const limit = readInteger(query, 'limit', 50, 1, 100)
    const skip = readInteger(query, 'skip', 0, 0, 100000)
    const sortOrder = readSortOrder(query)

    if (domain !== undefined)
      return await this.storageManager.findByDomain(domain, limit, skip, sortOrder)
    if (publisher !== undefined)
      return await this.storageManager.findByPublisher(publisher, limit, skip, sortOrder)
    if (tags !== undefined)
      return await this.storageManager.findByTags(tags, limit, skip, sortOrder)
    if (category !== undefined)
      return await this.storageManager.findByCategory(category, limit, skip, sortOrder)
    if (name !== undefined)
      return await this.storageManager.findByNameFuzzy(name, limit, skip, sortOrder)
    if (outpoint !== undefined) return await this.storageManager.findByOutpoint(outpoint)

    return await this.storageManager.findAllApps(limit, skip, sortOrder)
  }

  async getDocumentation(): Promise<string> {
    return 'Apps Lookup Service: find published Metanet Apps.'
  }

  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'Apps Lookup Service',
      shortDescription: 'Find published Metanet Apps with ease.'
    }
  }
}

function createAppsLookupService(db: Db): AppsLookupService {
  return new AppsLookupService(new AppsStorageManager(db))
}
export default createAppsLookupService
