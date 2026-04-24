import { AppsStorageManager } from './AppsStorageManager.js'
import { AdmissionMode, LookupFormula, LookupQuestion, LookupService, OutputAdmittedByTopic, OutputSpent, SpendNotificationMode } from '@bsv/overlay'
import { PushDrop, Utils } from '@bsv/sdk'
import { Db } from 'mongodb'
import { AppCatalogQuery, PublishedAppMetadata } from './types.js'

class AppsLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'

  private static readonly TOPIC = 'tm_apps'
  private static readonly SERVICE_ID = 'ls_apps'

  constructor(public storageManager: AppsStorageManager) { }

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid payload')
    const { txid, outputIndex, topic, lockingScript } = payload
    if (topic !== AppsLookupService.TOPIC) return

    const decoded = PushDrop.decode(lockingScript)
    if (decoded.fields.length !== 2) throw new Error('App token must have exactly one metadata field + signature')

    const metadataJSON = Utils.toUTF8(decoded.fields[0])
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
    if (question.query === undefined || question.query === null) throw new Error('A valid query must be provided!')
    if (question.service !== AppsLookupService.SERVICE_ID) throw new Error('Lookup service not supported!')

    const query = (question.query as AppCatalogQuery)

    if (query.domain) return await this.storageManager.findByDomain(query.domain, query.limit, query.skip, query.sortOrder)
    if (query.publisher) return await this.storageManager.findByPublisher(query.publisher, query.limit, query.skip, query.sortOrder)
    if (query.tags?.length) return await this.storageManager.findByTags(query.tags, query.limit, query.skip, query.sortOrder)
    if (query.category) return await this.storageManager.findByCategory(query.category, query.limit, query.skip, query.sortOrder)
    if (query.name) return await this.storageManager.findByNameFuzzy(query.name, query.limit, query.skip, query.sortOrder)
    if (query.outpoint) return await this.storageManager.findByOutpoint(query.outpoint)

    return await this.storageManager.findAllApps(query.limit, query.skip, query.sortOrder)
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

export default (db: Db): AppsLookupService => new AppsLookupService(new AppsStorageManager(db))
