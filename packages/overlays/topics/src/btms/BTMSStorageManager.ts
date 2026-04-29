import { Collection, Db } from 'mongodb'
import { BTMSRecord } from './types.js'
import { PubKeyHex } from '@bsv/sdk'

/**
 * Storage manager for the BTMS lookup overlay using MongoDB.
 */
export class BTMSStorageManager {
  private readonly records: Collection<BTMSRecord>

  /**
   * @param db A connected MongoDB database handle.
   */
  constructor (private readonly db: Db) {
    this.records = db.collection<BTMSRecord>('btmsRecords')

    // Create index on assetId for efficient lookups
    this.records
      .createIndex({ assetId: 1 })
      .catch(console.error)

    // Create index on ownerKey for efficient lookups
    this.records
      .createIndex({ ownerKey: 1 })
      .catch(console.error)

    // Create compound index for txid and outputIndex (unique identifier)
    this.records
      .createIndex({ txid: 1, outputIndex: 1 }, { unique: true })
      .catch(console.error)
  }

  /**
   * Insert a new BTMS token record.
   */
  async storeRecord (
    txid: string,
    outputIndex: number,
    assetId: string,
    amount: number,
    ownerKey: PubKeyHex,
    metadata?: string
  ): Promise<void> {
    const record: BTMSRecord = {
      txid,
      outputIndex,
      assetId,
      amount,
      ownerKey,
      metadata,
      createdAt: new Date()
    }
    await this.records.insertOne(record)
  }

  /**
   * Remove a BTMS record identified by its UTXO.
   */
  async deleteRecord (txid: string, outputIndex: number): Promise<void> {
    await this.records.deleteOne({ txid, outputIndex })
  }

  /**
   * Find records with dynamic filter combinations.
   */
  async findWithFilters (
    filters: {
      assetId?: string
      ownerKey?: PubKeyHex
    },
    limit: number = 50,
    skip: number = 0,
    sortOrder: 'asc' | 'desc' = 'desc'
  ): Promise<BTMSRecord[]> {
    const query: Record<string, unknown> = {}

    if (filters.assetId) {
      query.assetId = filters.assetId
    }

    if (filters.ownerKey) {
      query.ownerKey = filters.ownerKey
    }

    return await this.findRecordWithQuery(query, limit, skip, sortOrder)
  }

  /**
   * Fetch all BTMS records without filtering, with pagination and sorting.
   */
  async findAllRecords (
    limit: number = 50,
    skip: number = 0,
    sortOrder: 'asc' | 'desc' = 'desc'
  ): Promise<BTMSRecord[]> {
    return await this.findRecordWithQuery({}, limit, skip, sortOrder)
  }

  /**
   * Find a specific record by txid and outputIndex.
   */
  async findByTxidOutputIndex (txid: string, outputIndex: number): Promise<BTMSRecord | null> {
    return await this.records.findOne({ txid, outputIndex })
  }

  /**
   * Helper function for querying from the database
   */
  private async findRecordWithQuery (
    query: object,
    limit: number = 50,
    skip: number = 0,
    sortOrder: 'asc' | 'desc' = 'desc'
  ): Promise<BTMSRecord[]> {
    const sortDirection = sortOrder === 'desc' ? -1 : 1

    const results = await this.records
      .find(query)
      .sort({ createdAt: sortDirection })
      .skip(skip)
      .limit(limit)
      .toArray()

    return results as BTMSRecord[]
  }
}
