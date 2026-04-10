import { Collection, Db } from 'mongodb'
import { DesktopIntegrityRecord, UTXOReference } from './types.js'

// Implements a Lookup StorageEngine for DesktopIntegrity
export class DesktopIntegrityStorage {
  private readonly records: Collection<DesktopIntegrityRecord>

  /**
   * Constructs a new DesktopIntegrityStorage instance
   * @param {Db} db - A connected MongoDB database instance
   */
  constructor(private readonly db: Db) {
    this.records = db.collection<DesktopIntegrityRecord>('desktopIntegrityRecords')
    this.createSearchableIndex() // Initialize the searchable index
  }

  /* Ensures a text index exists for the `fileHash` field, enabling efficient searches.
   * The index is named `fileHashIndex`.
   */
  private async createSearchableIndex(): Promise<void> {
    await this.records.createIndex({ fileHash: 1 }, { name: 'fileHashIndex' })
  }

  /**
   * Stores a new DesktopIntegrity record in the database.
   * @param {string} txid - The transaction ID associated with this record
   * @param {number} outputIndex - The UTXO output index
   * @param {string} fileHash - The file hash to be stored
   * @param {number[]} offChainValues - The off-chain values to be stored
   * @returns {Promise<void>} - Resolves when the record has been successfully stored
   */
  async storeRecord(txid: string, outputIndex: number, fileHash: string, offChainValues: number[]): Promise<void> {
    await this.records.insertOne({
      txid,
      outputIndex,
      fileHash,
      offChainValues: Buffer.from(offChainValues),
      createdAt: new Date()
    })
  }

  /**
   * Deletes a DesktopIntegrity record that matches the given transaction ID and output index.
   * @param {string} txid - The transaction ID of the record to delete
   * @param {number} outputIndex - The UTXO output index of the record to delete
   * @returns {Promise<void>} - Resolves when the record has been successfully deleted
   */
  async deleteRecord(txid: string, outputIndex: number): Promise<void> {
    await this.records.deleteOne({ txid, outputIndex })
  }

  /**
   * Finds DesktopIntegrity records containing the specified file hash (case-insensitive).
   *
   * @param fileHash       Partial or full file hash to search for
   * @param limit         Max number of results to return (default = 50)
   * @param skip          Number of results to skip for pagination (default = 0)
   * @param sortOrder     'asc' | 'desc' – sort by createdAt (default = 'desc')
   */
  async findByFileHash(
    fileHash: string,
    limit: number = 50,
    skip: number = 0,
    sortOrder: 'asc' | 'desc' = 'desc'
  ): Promise<UTXOReference[]> {
    if (!fileHash) return []

    // Map text value → numeric MongoDB sort direction
    const direction = sortOrder === 'asc' ? 1 : -1

    const results = await this.records
      .find(
        { fileHash },
        { projection: { txid: 1, outputIndex: 1, offChainValues: 1, createdAt: 1 } }
      )
      .sort({ createdAt: direction })
      .skip(skip)
      .limit(limit)
      .project<{ txid: string; outputIndex: number; offChainValues: { buffer: Buffer } | null }>({ txid: 1, outputIndex: 1, offChainValues: 1 })
      .toArray()
    return results.map(r => ({ txid: r.txid, outputIndex: r.outputIndex, context: r.offChainValues ? Array.from(r.offChainValues.buffer) : undefined }))
  }

  /**
   * Finds DesktopIntegrity records containing the specified transaction ID (case-insensitive).
   *
   * @param txid            Partial or full transaction ID to search for
   * @param limit         Max number of results to return (default = 50)
   * @param skip          Number of results to skip for pagination (default = 0)
   * @param sortOrder     'asc' | 'desc' – sort by createdAt (default = 'desc')
   */
  async findByTxid(
    txid: string,
    limit: number = 50,
    skip: number = 0,
    sortOrder: 'asc' | 'desc' = 'desc'
  ): Promise<UTXOReference[]> {
    if (!txid) return []

    // Map text value → numeric MongoDB sort direction
    const direction = sortOrder === 'asc' ? 1 : -1

    const results = await this.records
      .find(
        { txid },
        { projection: { txid: 1, outputIndex: 1, offChainValues: 1, createdAt: 1 } }
      )
      .sort({ createdAt: direction })
      .skip(skip)
      .limit(limit)
      .project<{ txid: string; outputIndex: number; offChainValues: { buffer: Buffer } | null }>({ txid: 1, outputIndex: 1, offChainValues: 1 })
      .toArray()
    return results.map(r => ({ txid: r.txid, outputIndex: r.outputIndex, context: r.offChainValues ? Array.from(r.offChainValues.buffer) : undefined }))
  }

  /**
   * Retrieves all DesktopIntegrity records, optionally filtered by date range and sorted by creation time.
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

    const results = await this.records.find(query)
      .sort({ createdAt: sortDirection })
      .skip(skip)
      .limit(limit)
      .project<{ txid: string; outputIndex: number; offChainValues: { buffer: Buffer } | null }>({ txid: 1, outputIndex: 1, offChainValues: 1 })
      .toArray()
    return results.map(r => ({ txid: r.txid, outputIndex: r.outputIndex, context: r.offChainValues ? Array.from(r.offChainValues.buffer) : undefined }))
  }

  // Additional custom query functions can be added here. ---------------------------------------------
}
