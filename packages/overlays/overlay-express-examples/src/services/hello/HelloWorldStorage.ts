import { Collection, Db } from 'mongodb'
import { HelloWorldRecord, UTXOReference } from './types.js'

// Implements a Lookup StorageEngine for HelloWorld
export class HelloWorldStorage {
  private readonly records: Collection<HelloWorldRecord>

  /**
   * Constructs a new HelloWorldStorage instance
   * @param {Db} db - A connected MongoDB database instance
   */
  constructor(private readonly db: Db) {
    this.records = db.collection<HelloWorldRecord>('helloWorldRecords')
    this.createSearchableIndex() // Initialize the searchable index
  }

  /* Ensures a text index exists for the `message` field, enabling efficient searches.
   * The index is named `MessageTextIndex`.
   */
  private async createSearchableIndex(): Promise<void> {
    await this.records.createIndex({ message: 'text' }, { name: 'MessageTextIndex' })
  }

  /**
   * Stores a new HelloWorld record in the database.
   * @param {string} txid - The transaction ID associated with this record
   * @param {number} outputIndex - The UTXO output index
   * @param {string} message - The message to be stored
   * @returns {Promise<void>} - Resolves when the record has been successfully stored
   */
  async storeRecord(txid: string, outputIndex: number, message: string): Promise<void> {
    await this.records.insertOne({
      txid,
      outputIndex,
      message,
      createdAt: new Date()
    })
  }

  /**
   * Deletes a HelloWorld record that matches the given transaction ID and output index.
   * @param {string} txid - The transaction ID of the record to delete
   * @param {number} outputIndex - The UTXO output index of the record to delete
   * @returns {Promise<void>} - Resolves when the record has been successfully deleted
   */
  async deleteRecord(txid: string, outputIndex: number): Promise<void> {
    await this.records.deleteOne({ txid, outputIndex })
  }

  /**
   * Finds HelloWorld records containing the specified message (case-insensitive).
   * Uses the collection’s full-text index for efficient matching.
   *
   * @param message       Partial or full message to search for
   * @param limit         Max number of results to return (default = 50)
   * @param skip          Number of results to skip for pagination (default = 0)
   * @param sortOrder     'asc' | 'desc' – sort by createdAt (default = 'desc')
   */
  async findByMessage(
    message: string,
    limit: number = 50,
    skip: number = 0,
    sortOrder: 'asc' | 'desc' = 'desc'
  ): Promise<UTXOReference[]> {
    if (!message) return []

    // Map text value → numeric MongoDB sort direction
    const direction = sortOrder === 'asc' ? 1 : -1

    return this.records
      .find(
        { $text: { $search: message } },
        { projection: { txid: 1, outputIndex: 1, createdAt: 1 } }
      )
      .sort({ createdAt: direction })
      .skip(skip)
      .limit(limit)
      .toArray()
      .then(results =>
        results.map(r => ({
          txid: r.txid,
          outputIndex: r.outputIndex
        }))
      )
  }

  /**
   * Retrieves all HelloWorld records, optionally filtered by date range and sorted by creation time.
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

    return await this.records.find(query)
      .sort({ createdAt: sortDirection })
      .skip(skip)
      .limit(limit)
      .project<UTXOReference>({ txid: 1, outputIndex: 1 })
      .toArray()
  }

  // Additional custom query functions can be added here. ---------------------------------------------
}
