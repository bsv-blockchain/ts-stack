import { Collection, Db } from 'mongodb'
import { LookupFormula } from '@bsv/overlay'
import { KVStoreRecord } from './types.js'

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
    protectedKey: string
  ): Promise<void> {
    await this.records.insertOne({
      txid,
      outputIndex,
      protectedKey,
      createdAt: new Date()
    })
  }

  /**
   * Remove a KVStore record identified by its UTXO.
   */
  async deleteRecord(txid: string, outputIndex: number): Promise<void> {
    await this.records.deleteOne({ txid, outputIndex })
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
    sortOrder: 'asc' | 'desc' = 'desc'
  ): Promise<LookupFormula> {
    return this.findRecordWithQuery(
      { protectedKey },
      limit,
      skip,
      sortOrder
    )
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
    
    // Find matching results from the DB with pagination and sorting
    const results = await this.records
      .find(query)
      .sort({ createdAt: sortDirection })
      .skip(skip)
      .limit(limit)
      .project({ txid: 1, outputIndex: 1 })
      .toArray()
    
    return results.map((record: any) => {
      return {
        txid: record.txid,
        outputIndex: record.outputIndex
      }
    })
  }
}
