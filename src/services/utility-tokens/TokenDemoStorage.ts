import { Collection, Db } from 'mongodb'
import { TokenDemoRecord, TokenDemoDetails, UTXOReference } from './types.js'

// Implements a Lookup StorageEngine for TokenDemo
export class TokenDemoStorage {
  private readonly records: Collection<TokenDemoRecord>

  /**
   * Constructs a new TokenDemoStorage instance
   * @param {Db} db - A connected MongoDB database instance
   */
  constructor(private readonly db: Db) {
    this.records = db.collection<TokenDemoRecord>('TokenDemoRecords')
    this.createIndices() // Initialize the searchable index
  }

  /* Ensures a text index exists for the `message` field, enabling efficient searches.
   * The index is named `MessageTextIndex`.
   */
  private async createIndices(): Promise<void> {
    await this.records.createIndex({ txid: 1, outputIndex: 1 }, { name: 'OutpointIndex' })
    await this.records.createIndex({ tokenId: 'hashed' }, { name: 'TokenIdTextIndex' })
  }

  /**
   * Stores a new TokenDemo record in the database.
   * @param {string} txid - The transaction ID associated with this record
   * @param {number} outputIndex - The UTXO output index
   * @param {string} message - The message to be stored
   * @returns {Promise<void>} - Resolves when the record has been successfully stored
   */
  async storeRecord(txid: string, outputIndex: number, details: TokenDemoDetails): Promise<void> {
    await this.records.insertOne({
      txid,
      outputIndex,
      ...details,
      createdAt: new Date()
    })
  }

  /**
   * Deletes a TokenDemo record that matches the given transaction ID and output index.
   * @param {string} txid - The transaction ID of the record to delete
   * @param {number} outputIndex - The UTXO output index of the record to delete
   * @returns {Promise<void>} - Resolves when the record has been successfully deleted
   */
  async deleteRecord(txid: string, outputIndex: number): Promise<void> {
    await this.records.deleteOne({ txid, outputIndex })
  }

  /**
   * Finds a TokenDemo record that matches the given transaction ID and output index.
   * 
   * @param outpoint 
   * @param limit 
   * @param skip 
   * @param sortOrder 
   * @returns 
   */
  async findByOutpoint(
    outpoint: string
  ): Promise<UTXOReference[]> {
    const [txid, outputIndex] = outpoint.split('.')
    return this.records.find(
        { txid, outputIndex: Number(outputIndex) }, 
        { projection: { txid: 1, outputIndex: 1 } }
      )
      .toArray()
      .then(results =>
        results.map(r => ({
          txid: r.txid,
          outputIndex: r.outputIndex
        }))
      )
  }

  /**
   * Finds TokenDemo records containing the specified message (case-insensitive).
   * Uses the collection’s full-text index for efficient matching.
   *
   * @param message       Partial or full message to search for
   * @param limit         Max number of results to return (default = 50)
   * @param skip          Number of results to skip for pagination (default = 0)
   * @param sortOrder     'asc' | 'desc' – sort by createdAt (default = 'desc')
   */
  async findByTokenId(
    tokenId: string,
    limit: number = 50,
    skip: number = 0,
    sortOrder: 'asc' | 'desc' = 'desc'
  ): Promise<UTXOReference[]> {
    if (!tokenId) return []

    // Map text value → numeric MongoDB sort direction
    const direction = sortOrder === 'asc' ? 1 : -1

    return this.records
      .find(
        { tokenId },
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
   * Retrieves all TokenDemo records, optionally filtered by date range and sorted by creation time.
   * @returns {Promise<UTXOReference[]>} - Resolves with an array of UTXO references
   */
  async findAll(
    limit: number = 50,
    skip: number = 0,
    sortOrder: 'asc' | 'desc' = 'desc'
  ): Promise<UTXOReference[]> {
    // Map text value → numeric MongoDB sort direction
    const direction = sortOrder === 'asc' ? 1 : -1

    return this.records
      .find(
        {},
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

  // Additional custom query functions can be added here. ---------------------------------------------
}
