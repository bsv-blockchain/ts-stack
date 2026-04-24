import { Collection, Db } from 'mongodb'
import { SHIPQuery, SHIPRecord, UTXOReference } from '../types.js'

/**
 * Implements a storage engine for SHIP protocol
 */
export class SHIPStorage {
  private readonly shipRecords: Collection<SHIPRecord>

  /**
   * Constructs a new SHIPStorage instance
   * @param {Db} db - connected mongo database instance
   */
  constructor (private readonly db: Db) {
    this.shipRecords = db.collection<SHIPRecord>('shipRecords')
  }

  /**
   * Ensures the necessary indexes are created for the collections.
   */
  async ensureIndexes (): Promise<void> {
    await this.shipRecords.createIndex({ domain: 1, topic: 1 })
  }

  /**
   * Checks if a duplicate SHIP record exists with the same field values
   * @param {string} identityKey identity key
   * @param {string} domain domain name
   * @param {string} topic topic name
   * @returns {Promise<boolean>} true if a duplicate exists
   */
  async hasDuplicateRecord (identityKey: string, domain: string, topic: string): Promise<boolean> {
    const existingRecord = await this.shipRecords.findOne({
      identityKey,
      domain,
      topic
    })
    return existingRecord !== null
  }

  /**
   * Stores a SHIP record
   * @param {string} txid transaction id
   * @param {number} outputIndex index of the UTXO
   * @param {string} identityKey identity key
   * @param {string} domain domain name
   * @param {string} topic topic name
   */
  async storeSHIPRecord (txid: string, outputIndex: number, identityKey: string, domain: string, topic: string): Promise<void> {
    await this.shipRecords.insertOne({
      txid,
      outputIndex,
      identityKey,
      domain,
      topic,
      createdAt: new Date()
    })
  }

  /**
   * Deletes a SHIP record
   * @param {string} txid transaction id
   * @param {number} outputIndex index of the UTXO
   */
  async deleteSHIPRecord (txid: string, outputIndex: number): Promise<void> {
    await this.shipRecords.deleteOne({ txid, outputIndex })
  }

  /**
   * Finds SHIP records based on a given query object.
   * @param {Object} query The query object which may contain properties for domain, topics, identityKey, limit, and skip.
   * @returns {Promise<UTXOReference[]>} Returns matching UTXO references.
   */
  async findRecord (query: SHIPQuery): Promise<UTXOReference[]> {
    const mongoQuery: any = {}

    // Add domain to the query if provided
    if (typeof query.domain === 'string') {
      mongoQuery.domain = query.domain
    }

    // Add topics to the query if provided
    if (Array.isArray(query.topics)) {
      mongoQuery.topic = { $in: query.topics }
    }

    // Add identityKey to the query if provided
    if (typeof query.identityKey === 'string') {
      mongoQuery.identityKey = query.identityKey
    }

    // Build the query with pagination
    let cursor = this.shipRecords
      .find(mongoQuery)
      .project<UTXOReference>({ txid: 1, outputIndex: 1, createdAt: 1 })

    cursor.sort({ createdAt: query.sortOrder ?? -1 })

    // Apply pagination if provided
    if (typeof query.skip === 'number' && query.skip > 0) {
      cursor = cursor.skip(query.skip)
    }

    if (typeof query.limit === 'number' && query.limit > 0) {
      cursor = cursor.limit(query.limit)
    }

    return await cursor
      .toArray()
      .then((results) =>
        results.map((record) => ({
          txid: record.txid,
          outputIndex: record.outputIndex
        }))
      )
  }

  /**
   * Returns all results tracked by the overlay
   * @param {number} limit Optional limit for pagination
   * @param {number} skip Optional skip for pagination
   * @param {string} sortOrder Optional sort order
   * @returns {Promise<UTXOReference[]>} returns matching UTXO references
   */
  async findAll (limit?: number, skip?: number, sortOrder?: 'asc' | 'desc'): Promise<UTXOReference[]> {
    let cursor = this.shipRecords.find({})
      .project<UTXOReference>({ txid: 1, outputIndex: 1, createdAt: 1 })

    // Apply pagination if provided
    cursor.sort({ createdAt: sortOrder ?? -1 })

    if (typeof skip === 'number' && skip > 0) {
      cursor = cursor.skip(skip)
    }

    if (typeof limit === 'number' && limit > 0) {
      cursor = cursor.limit(limit)
    }

    return await cursor
      .toArray()
      .then(results => results.map(shipRecords => ({
        txid: shipRecords.txid,
        outputIndex: shipRecords.outputIndex
      })))
  }
}
