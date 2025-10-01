import { Collection, Db } from 'mongodb'
import { LookupFormula } from '@bsv/overlay'
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
  }

  /**
   * Insert a new KVStore record.
   */
  async storeRecord(
    txid: string,
    outputIndex: number,
    key: string,
    protocolID: string,
    controller: PubKeyHex
  ): Promise<void> {
    await this.records.insertOne({
      txid,
      outputIndex,
      key,
      protocolID,
      controller,
      createdAt: new Date(),
      spent: false
    })
  }

  /**
   * Remove a KVStore record identified by its UTXO.
   */
  async deleteRecord(txid: string, outputIndex: number): Promise<void> {
    await this.records.deleteOne({ txid, outputIndex })
  }

  /**
   * Mark a KVStore record as spent (preserve for history).
   */
  async markRecordAsSpent(txid: string, outputIndex: number): Promise<void> {
    await this.records.updateOne(
      { txid, outputIndex },
      { $set: { spent: true, spentAt: new Date() } }
    )
  }

  /**
   * Find records by protected key with pagination and sorting.
   * @param {string} key - Base64 encoded protected key to search for
   * @param {number} limit - Maximum number of records to return
   * @param {number} skip - Number of records to skip (for pagination)
   * @param {string} sortOrder - Sort direction ('asc' or 'desc')
   * @returns {Promise<LookupFormula>} Matching UTXO references
   */
  async findByKey(
    key: string,
    limit: number = 50,
    skip: number = 0,
    sortOrder: 'asc' | 'desc' = 'desc',
    includeSpent: boolean = false
  ): Promise<LookupFormula> {
    const query = includeSpent
      ? { key }
      : { key, spent: { $ne: true } }

    return this.findRecordWithQuery(
      query,
      limit,
      skip,
      sortOrder
    )
  }

  /**
   * Find records by protocolID with pagination and sorting.
   * @param {string} protocolID - protocolID to search for
   * @param {number} limit - Maximum number of records to return
   * @param {number} skip - Number of records to skip (for pagination)
   * @param {string} sortOrder - Sort direction ('asc' or 'desc')
   * @returns {Promise<LookupFormula>} Matching UTXO references
   */
  async findByProtocolID(
    protocolID: string,
    limit: number = 50,
    skip: number = 0,
    sortOrder: 'asc' | 'desc' = 'desc',
    includeSpent: boolean = false
  ): Promise<LookupFormula> {
    const query = includeSpent
      ? { protocolID }
      : { protocolID, spent: { $ne: true } }

    return this.findRecordWithQuery(
      query,
      limit,
      skip,
      sortOrder
    )
  }

  /**
   * Find records by controller with pagination and sorting.
   * @param {string} controller - Controller public key to search for
   * @param {number} limit - Maximum number of records to return
   * @param {number} skip - Number of records to skip (for pagination)
   * @param {string} sortOrder - Sort direction ('asc' or 'desc')
   * @returns {Promise<LookupFormula>} Matching UTXO references
   */
  async findByController(
    controller: string,
    limit: number = 50,
    skip: number = 0,
    sortOrder: 'asc' | 'desc' = 'desc',
    includeSpent: boolean = false
  ): Promise<LookupFormula> {
    const query = includeSpent
      ? { controller }
      : { controller, spent: { $ne: true } }

    return this.findRecordWithQuery(
      query,
      limit,
      skip,
      sortOrder
    )
  }

  /**
   * Find records with dynamic filter combinations.
   * @param {object} filters - Object containing any combination of key, protocolID, controller
   * @param {number} limit - Maximum number of records to return
   * @param {number} skip - Number of records to skip (for pagination)
   * @param {string} sortOrder - Sort direction ('asc' or 'desc')
   * @param {boolean} includeSpent - Whether to include spent records
   * @returns {Promise<LookupFormula>} Matching UTXO references
   */
  async findWithFilters(
    filters: {
      key?: string
      protocolID?: string
      controller?: string
    },
    limit: number = 50,
    skip: number = 0,
    sortOrder: 'asc' | 'desc' = 'desc',
    includeSpent: boolean = false
  ): Promise<LookupFormula> {
    // Build dynamic query object
    const query: any = {}

    if (filters.key) {
      query.key = filters.key
    }

    if (filters.protocolID) {
      query.protocolID = filters.protocolID
    }

    if (filters.controller) {
      query.controller = filters.controller
    }

    // Add spent filter unless explicitly including spent records
    if (!includeSpent) {
      query.spent = { $ne: true }
    }

    return this.findRecordWithQuery(query, limit, skip, sortOrder)
  }

  /**
   * Fetch all KVStore records without filtering, with pagination and sorting.
   * @param {number} limit - Maximum number of records to return
   * @param {number} skip - Number of records to skip (for pagination)
   * @param {string} sortOrder - Sort direction ('asc' or 'desc')
   * @returns {Promise<LookupFormula>} All KVStore UTXO references
   */
  async findAllRecords(
    limit: number = 50,
    skip: number = 0,
    sortOrder: 'asc' | 'desc' = 'desc'
  ): Promise<LookupFormula> {
    return this.findRecordWithQuery({}, limit, skip, sortOrder)
  }

  /**
   * Helper function for querying from the database
   * @param {object} query - MongoDB query object
   * @param {number} limit - Maximum number of records to return
   * @param {number} skip - Number of records to skip (for pagination)
   * @param {string} sortOrder - Sort direction ('asc' or 'desc')
   * @returns {Promise<LookupFormula>} returns matching UTXO references
   */
  private async findRecordWithQuery(
    query: object,
    limit: number = 50,
    skip: number = 0,
    sortOrder: 'asc' | 'desc' = 'desc'
  ): Promise<LookupFormula> {
    // Apply sort on createdAt for chronological ordering
    const sortDirection = sortOrder === 'desc' ? -1 : 1

    console.log('querying', query)
    // Find matching results from the DB with pagination and sorting
    const results = await this.records
      .find(query)
      .sort({ createdAt: sortDirection })
      .skip(skip)
      .limit(limit)
      .project({ txid: 1, outputIndex: 1 })
      .toArray()

    console.log('results', results)
    return results.map((record: any) => {
      return {
        txid: record.txid,
        outputIndex: record.outputIndex
      }
    })
  }
}
