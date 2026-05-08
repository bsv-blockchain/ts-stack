import { Collection, Db } from 'mongodb'
import { LookupFormula } from '@bsv/overlay'
import { AppCatalogRecord, PublishedAppMetadata } from './types.js'

export class AppsStorageManager {
  private readonly records: Collection<AppCatalogRecord>
  private indexInit?: Promise<void>

  constructor(private readonly db: Db) {
    this.records = db.collection<AppCatalogRecord>('appsCatalogRecords')
  }

  private ensureIndexes(): Promise<void> {
    if (this.indexInit === undefined) {
      this.indexInit = (async () => {
        await this.records.createIndex({
          'metadata.name': 'text',
          'metadata.description': 'text',
          'metadata.tags': 'text',
          'metadata.domain': 'text'
        })
      })()
    }
    return this.indexInit
  }

  async storeRecord(txid: string, outputIndex: number, metadata: PublishedAppMetadata): Promise<void> {
    await this.ensureIndexes()
    await this.records.insertOne({ txid, outputIndex, metadata, createdAt: new Date() })
  }

  async deleteRecord(txid: string, outputIndex: number): Promise<void> {
    await this.ensureIndexes()
    await this.records.deleteOne({ txid, outputIndex })
  }

  async findByDomain(domain: string, limit = 50, skip = 0, sortOrder: 'asc' | 'desc' = 'desc'): Promise<LookupFormula> {
    await this.ensureIndexes()
    return this.findRecordWithQuery({ 'metadata.domain': domain }, limit, skip, sortOrder)
  }

  async findByPublisher(publisher: string, limit = 50, skip = 0, sortOrder: 'asc' | 'desc' = 'desc'): Promise<LookupFormula> {
    await this.ensureIndexes()
    return this.findRecordWithQuery({ 'metadata.publisher': publisher }, limit, skip, sortOrder)
  }

  async findByOutpoint(outpoint: string): Promise<LookupFormula> {
    await this.ensureIndexes()
    const [txid, indexStr] = outpoint.split('.')
    const outputIndex = Number(indexStr)
    if (!txid || Number.isNaN(outputIndex)) throw new Error('Invalid outpoint format')
    return this.findRecordWithQuery({ txid, outputIndex }, 1, 0, 'desc')
  }

  async findByNameFuzzy(partialName: string, limit = 50, skip = 0, sortOrder: 'asc' | 'desc' = 'desc'): Promise<LookupFormula> {
    await this.ensureIndexes()
    const escaped = partialName.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
    const regex = new RegExp(escaped, 'i')
    return this.findRecordWithQuery({ 'metadata.name': { $regex: regex } }, limit, skip, sortOrder)
  }

  async findByTags(tags: string[], limit = 50, skip = 0, sortOrder: 'asc' | 'desc' = 'desc'): Promise<LookupFormula> {
    await this.ensureIndexes()
    return this.findRecordWithQuery({ 'metadata.tags': { $in: tags } }, limit, skip, sortOrder)
  }

  async findByCategory(category: string, limit = 50, skip = 0, sortOrder: 'asc' | 'desc' = 'desc'): Promise<LookupFormula> {
    await this.ensureIndexes()
    return this.findRecordWithQuery({ 'metadata.category': category }, limit, skip, sortOrder)
  }

  async findAllApps(limit = 50, skip = 0, sortOrder: 'asc' | 'desc' = 'desc'): Promise<LookupFormula> {
    await this.ensureIndexes()
    return this.findRecordWithQuery({}, limit, skip, sortOrder)
  }

  private async findRecordWithQuery(query: object, limit = 50, skip = 0, sortOrder: 'asc' | 'desc' = 'desc'): Promise<LookupFormula> {
    const sortDirection = sortOrder === 'desc' ? -1 : 1
    const results = await this.records.find(query)
      .sort({ 'metadata.release_date': sortDirection })
      .skip(skip)
      .limit(limit)
      .project({ txid: 1, outputIndex: 1 })
      .toArray()
    return results.map((record: any) => ({ txid: record.txid, outputIndex: record.outputIndex }))
  }
}
