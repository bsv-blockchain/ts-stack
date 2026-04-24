import { Collection, Db } from 'mongodb'
import { FractionalizeRecord, UTXOReference } from './types.js'

// Implements a Lookup StorageEngine for Fractionalize
export class FractionalizeStorage {
  private readonly records: Collection<FractionalizeRecord>

  /**
   * Constructs a new FractionalizeStorage instance
   * @param {Db} db - A connected MongoDB database instance
   */
  constructor(private readonly db: Db) {
    this.records = db.collection<FractionalizeRecord>('fractionalizeRecords')
    this.createSearchableIndex() // Initialize the searchable index
  }

  /* Ensures a text index exists for the `txid` field, enabling efficient searches.
   * The index is named `txidIndex`.
   */
  private async createSearchableIndex(): Promise<void> {
    await this.records.createIndex({ txid: 1 }, { name: 'txidIndex' })
  }

  /**
   * Stores a new Fractionalize record in the database.
   * @param {string} txid - The transaction ID associated with this record
   * @param {number} outputIndex - The UTXO output index
   * @returns {Promise<void>} - Resolves when the record has been successfully stored
   */
  async storeRecord(txid: string, outputIndex: number): Promise<void> {
    await this.records.insertOne({
      txid,
      outputIndex,
      createdAt: new Date()
    })
  }

  /**
   * Updates a Fractionalize record that matches the given transaction ID and output index.
   * 
   * @param txid 
   * @param outputIndex 
   * @param spendingTxid 
   */
  async spendRecord(txid: string, outputIndex: number, spendingTxid: string): Promise<void> {
    await this.records.updateOne({ txid, outputIndex }, { $set: { spendingTxid } })
  }
  

  /**
   * Deletes a Fractionalize record that matches the given transaction ID and output index.
   * @param {string} txid - The transaction ID of the record to delete
   * @param {number} outputIndex - The UTXO output index of the record to delete
   * @returns {Promise<void>} - Resolves when the record has been successfully deleted
   */
  async deleteRecord(txid: string, outputIndex: number): Promise<void> {
    await this.records.deleteOne({ txid, outputIndex })
  }

  /**
   * Finds Fractionalize records containing the specified txid (case-insensitive).
   * Uses the collection’s full-text index for efficient matching.
   *
   * @param txid       Partial or full txid to search for
   * @param limit         Max number of results to return (default = 50)
   * @param skip          Number of results to skip for pagination (default = 0)
   * @param sortOrder     'asc' | 'desc' – sort by createdAt (default = 'desc')
   */
  async findByTxid(txid: string): Promise<UTXOReference | null> {
    if (!txid) return null
    return this.records
      .findOne(
        { txid },
        { projection: { txid: 1, outputIndex: 1 } }
      )
  }

  /**
   * Retrieves all Fractionalize records, optionally filtered by date range and sorted by creation time.
   * @param {number} [limit=50] - The maximum number of results to return
   * @param {number} [skip=0] - The number of results to skip (for pagination)
   * @param {Date} [startDate] - The earliest creation date to include (inclusive)
   * @param {Date} [endDate] - The latest creation date to include (inclusive)
   * @param {'asc' | 'desc'} [sortOrder='desc'] - The sort order for the results (`asc` for oldest first, `desc` for newest first)
   * @returns {Promise<UTXOReference[]>} - Resolves with an array of UTXO references
   */
  async findAll(
    limit = 50,
    skip = 0,
    startDate?: Date,
    endDate?: Date,
    sortOrder: 'asc' | 'desc' = 'desc'
  ): Promise<UTXOReference[]> {
    const query: any = {}
    if (startDate || endDate) {
      query.createdAt = {}
      if (startDate) query.createdAt.$gte = startDate
      if (endDate) query.createdAt.$lte = endDate
    }

    const sortDirection = sortOrder === 'asc' ? 1 : -1

    return this.records.find(query)
      .sort({ createdAt: sortDirection })
      .skip(skip)
      .limit(limit)
      .project<UTXOReference>({ txid: 1, outputIndex: 1 })
      .toArray()
  }

  // Additional custom query functions can be added here. ---------------------------------------------
}
