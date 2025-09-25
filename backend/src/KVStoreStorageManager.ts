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

    // Create index on protectedKey for efficient lookups
    this.records
      .createIndex({ protectedKey: 1 })
      .catch(console.error)

    // Create index on namespace for efficient lookups
    this.records
      .createIndex({ namespace: 1 })
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
    protectedKey: string,
    namespace: string,
    controller: PubKeyHex
  ): Promise<void> {
    await this.records.insertOne({
      txid,
      outputIndex,
      protectedKey,
      namespace,
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
   * @param {string} protectedKey - Base64 encoded protected key to search for
   * @param {number} limit - Maximum number of records to return
   * @param {number} skip - Number of records to skip (for pagination)
   * @param {string} sortOrder - Sort direction ('asc' or 'desc')
   * @returns {Promise<LookupFormula>} Matching UTXO references
   */
  async findByProtectedKey(
    protectedKey: string,
    limit: number = 50,
    skip: number = 0,
    sortOrder: 'asc' | 'desc' = 'desc',
    includeSpent: boolean = false
  ): Promise<LookupFormula> {
    const query = includeSpent
      ? { protectedKey }
      : { protectedKey, spent: { $ne: true } }

    return this.findRecordWithQuery(
      query,
      limit,
      skip,
      sortOrder
    )
  }

  /**
   * Find records by namespace with pagination and sorting.
   * @param {string} namespace - Namespace to search for
   * @param {number} limit - Maximum number of records to return
   * @param {number} skip - Number of records to skip (for pagination)
   * @param {string} sortOrder - Sort direction ('asc' or 'desc')
   * @returns {Promise<LookupFormula>} Matching UTXO references
   */
  async findByNamespace(
    namespace: string,
    limit: number = 50,
    skip: number = 0,
    sortOrder: 'asc' | 'desc' = 'desc',
    includeSpent: boolean = false
  ): Promise<LookupFormula> {
    const query = includeSpent
      ? { namespace }
      : { namespace, spent: { $ne: true } }

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
   * @param {object} filters - Object containing any combination of protectedKey, namespace, controller
   * @param {number} limit - Maximum number of records to return
   * @param {number} skip - Number of records to skip (for pagination)
   * @param {string} sortOrder - Sort direction ('asc' or 'desc')
   * @param {boolean} includeSpent - Whether to include spent records
   * @returns {Promise<LookupFormula>} Matching UTXO references
   */
  async findWithFilters(
    filters: {
      protectedKey?: string
      namespace?: string
      controller?: string
    },
    limit: number = 50,
    skip: number = 0,
    sortOrder: 'asc' | 'desc' = 'desc',
    includeSpent: boolean = false
  ): Promise<LookupFormula> {
    // Build dynamic query object
    const query: any = {}

    if (filters.protectedKey) {
      query.protectedKey = filters.protectedKey
    }

    if (filters.namespace) {
      query.namespace = filters.namespace
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
