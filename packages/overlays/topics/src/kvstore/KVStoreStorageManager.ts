import { Collection, Db } from 'mongodb'
import { CollectionIndexes } from '../shared/collectionIndexes.js'
import { KVStoreRecord } from './types.js'
import { PubKeyHex, WalletProtocol } from '@bsv/sdk'

export class KVStoreStorageManager {
  private readonly records: Collection<KVStoreRecord>

  private readonly indexes = new CollectionIndexes('KVStoreStorageManager', () => [
    { label: 'key_1', collection: this.records, keys: { key: 1 } },
    { label: 'protocolID_1', collection: this.records, keys: { protocolID: 1 } },
    { label: 'controller_1', collection: this.records, keys: { controller: 1 } },
    { label: 'txid_1_outputIndex_1', collection: this.records, keys: { txid: 1, outputIndex: 1 }, options: { unique: true } },
    { label: 'tags_1', collection: this.records, keys: { tags: 1 } }
  ])

  constructor (private readonly db: Db) {
    this.records = db.collection<KVStoreRecord>('kvstoreRecords')
  }

  private async ensureIndexes (): Promise<void> {
    return await this.indexes.ensure()
  }

  async storeRecord (
    txid: string,
    outputIndex: number,
    key: string,
    protocolID: string,
    controller: PubKeyHex,
    tags?: string[]
  ): Promise<void> {
    await this.ensureIndexes()
    const record: KVStoreRecord = {
      txid,
      outputIndex,
      key,
      protocolID,
      controller,
      tags: tags && tags.length > 0 ? tags : undefined,
      createdAt: new Date()
    }
    await this.records.updateOne({ txid, outputIndex }, { $set: record }, { upsert: true })
  }

  async deleteRecord (txid: string, outputIndex: number): Promise<void> {
    await this.ensureIndexes()
    await this.records.deleteOne({ txid, outputIndex })
  }

  async findWithFilters (
    filters: {
      key?: string
      protocolID?: WalletProtocol
      controller?: string
      tags?: string[]
    },
    tagQueryMode: 'all' | 'any' = 'all',
    limit: number = 50,
    skip: number = 0,
    sortOrder: 'asc' | 'desc' = 'desc'
  ): Promise<KVStoreRecord[]> {
    await this.ensureIndexes()
    const query: any = {}

    if (filters.key) query.key = filters.key
    if (filters.protocolID) query.protocolID = JSON.stringify(filters.protocolID)
    if (filters.controller) query.controller = filters.controller

    if (filters.tags && filters.tags.length > 0) {
      if (tagQueryMode === 'any') {
        query.tags = { $in: filters.tags }
      } else {
        query.tags = { $all: filters.tags }
      }
    }

    return await this.findRecordWithQuery(query, limit, skip, sortOrder)
  }

  async findAllRecords (limit: number = 50, skip: number = 0, sortOrder: 'asc' | 'desc' = 'desc'): Promise<KVStoreRecord[]> {
    await this.ensureIndexes()
    return await this.findRecordWithQuery({}, limit, skip, sortOrder)
  }

  private async findRecordWithQuery (
    query: object,
    limit: number = 50,
    skip: number = 0,
    sortOrder: 'asc' | 'desc' = 'desc'
  ): Promise<KVStoreRecord[]> {
    const sortDirection = sortOrder === 'desc' ? -1 : 1
    const results = await this.records
      .find(query)
      .sort({ createdAt: sortDirection })
      .skip(skip)
      .limit(limit)
      .toArray()
    return results as KVStoreRecord[]
  }
}
