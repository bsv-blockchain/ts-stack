import { Collection, Db } from 'mongodb'
import { KVStoreRecord } from './types.js'
import { PubKeyHex, WalletProtocol } from '@bsv/sdk'

/**
 * Storage manager for the KVStore lookup overlay using MongoDB.
 */
export class KVStoreStorageManager {
  private readonly records: Collection<KVStoreRecord>

  /**
   * @param db  A connected MongoDB database handle.
   */
  constructor(private readonly db: Db) {
    this.records = db.collection<KVStoreRecord>('kvstoreRecords')

    // Create index on key for efficient lookups
    this.records
      .createIndex({ key: 1 })
      .catch(console.error)

    // Create index on protocolID for efficient lookups
    this.records
      .createIndex({ protocolID: 1 })
      .catch(console.error)

    // Create index on controller for efficient lookups
    this.records
      .createIndex({ controller: 1 })
      .catch(console.error)

    // Create compound index for txid and outputIndex
    this.records
      .createIndex({ txid: 1, outputIndex: 1 }, { unique: true })
      .catch(console.error)

    // Create index on tags for efficient lookups
    this.records
      .createIndex({ tags: 1 })
      .catch(console.error)
  }

  /**
   * Insert a new KVStore record.
   */
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

  /**
   * Remove a KVStore record identified by its UTXO.
   */
  async deleteRecord(txid: string, outputIndex: number): Promise<void> {
    await this.records.deleteOne({ txid, outputIndex })
  }

  /**
   * Find records with dynamic filter combinations.
   * @param {object} filters - Object containing any combination of key, protocolID, controller, tags
   * @param {number} limit - Maximum number of records to return
   * @param {number} skip - Number of records to skip (for pagination)
   * @param {string} sortOrder - Sort direction ('asc' or 'desc')
   * @returns {Promise<KVStoreRecord[]>} Matching records
   */
  async findWithFilters(
    filters: {
      key?: string
      protocolID?: WalletProtocol
      controller?: string
      tags?: string[]
    },
    limit: number = 50,
    skip: number = 0,
    sortOrder: 'asc' | 'desc' = 'desc'
  ): Promise<KVStoreRecord[]> {
    // Build dynamic query object
    const query: any = {}

    if (filters.key) {
      query.key = filters.key
    }

    if (filters.protocolID) {
      query.protocolID = JSON.stringify(filters.protocolID)
    }

    if (filters.controller) {
      query.controller = filters.controller
    }

    // Support tag-based querying
    if (filters.tags && filters.tags.length > 0) {
      // Use MongoDB $all operator to match records that contain ALL specified tags
      query.tags = { $all: filters.tags }
    }

    return this.findRecordWithQuery(query, limit, skip, sortOrder)
  }

  /**
   * Fetch all KVStore records without filtering, with pagination and sorting.
   * @param {number} limit - Maximum number of records to return
   * @param {number} skip - Number of records to skip (for pagination)
   * @param {string} sortOrder - Sort direction ('asc' or 'desc')
   * @returns {Promise<KVStoreRecord[]>} All KVStore records
   */
  async findAllRecords(
    limit: number = 50,
    skip: number = 0,
    sortOrder: 'asc' | 'desc' = 'desc'
  ): Promise<KVStoreRecord[]> {
    return this.findRecordWithQuery({}, limit, skip, sortOrder)
  }

  /**
   * Helper function for querying from the database
   * @param {object} query - MongoDB query object
   * @param {number} limit - Maximum number of records to return
   * @param {number} skip - Number of records to skip (for pagination)
   * @param {string} sortOrder - Sort direction ('asc' or 'desc')
   * @returns {Promise<KVStoreRecord[]>} returns matching records
   */
  private async findRecordWithQuery(
    query: object,
    limit: number = 50,
    skip: number = 0,
    sortOrder: 'asc' | 'desc' = 'desc'
  ): Promise<KVStoreRecord[]> {
    // Apply sort on createdAt for chronological ordering
    const sortDirection = sortOrder === 'desc' ? -1 : 1

    // Find matching results from the DB with pagination and sorting
    const results = await this.records
      .find(query)
      .sort({ createdAt: sortDirection })
      .skip(skip)
      .limit(limit)
      .toArray()

    return results as KVStoreRecord[]
  }
}
