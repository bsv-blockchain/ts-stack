import { Collection, Db } from 'mongodb'
import { KVStoreRecord } from './types.js'
import { PubKeyHex, WalletProtocol } from '@bsv/sdk'

export class KVStoreStorageManager {
  private readonly records: Collection<KVStoreRecord>

  constructor(private readonly db: Db) {
    this.records = db.collection<KVStoreRecord>('kvstoreRecords')
    this.records.createIndex({ key: 1 }).catch(console.error)
    this.records.createIndex({ protocolID: 1 }).catch(console.error)
    this.records.createIndex({ controller: 1 }).catch(console.error)
    this.records.createIndex({ txid: 1, outputIndex: 1 }, { unique: true }).catch(console.error)
    this.records.createIndex({ tags: 1 }).catch(console.error)
  }

  async storeRecord(
    txid: string,
    outputIndex: number,
    key: string,
    protocolID: string,
    controller: PubKeyHex,
    tags?: string[]
  ): Promise<void> {
    const record: KVStoreRecord = {
      txid,
      outputIndex,
      key,
      protocolID,
      controller,
      tags: tags && tags.length > 0 ? tags : undefined,
      createdAt: new Date()
    }
    await this.records.insertOne(record)
  }

  async deleteRecord(txid: string, outputIndex: number): Promise<void> {
    await this.records.deleteOne({ txid, outputIndex })
  }

  async findWithFilters(
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

    return this.findRecordWithQuery(query, limit, skip, sortOrder)
  }

  async findAllRecords(limit: number = 50, skip: number = 0, sortOrder: 'asc' | 'desc' = 'desc'): Promise<KVStoreRecord[]> {
    return this.findRecordWithQuery({}, limit, skip, sortOrder)
  }

  private async findRecordWithQuery(
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
