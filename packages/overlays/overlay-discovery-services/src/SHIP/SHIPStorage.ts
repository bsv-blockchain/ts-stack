import { Collection, Db, ObjectId } from 'mongodb'
import { SHIPQuery, SHIPRecord, UTXOReference } from '../types.js'

interface DuplicateSHIPGroup {
  _id: Pick<SHIPRecord, 'identityKey' | 'domain' | 'topic'>
  count: number
}

const UNIQUE_INDEX_SETUP_ATTEMPTS = 3

function isDuplicateKeyError (error: unknown): boolean {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 11000
}

function isNamespaceNotFoundError (error: unknown): boolean {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 26
}

/**
 * Implements a storage engine for SHIP protocol
 */
export class SHIPStorage {
  private readonly shipRecords: Collection<SHIPRecord>
  private indexesReady?: Promise<void>

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
    let setup = this.indexesReady
    if (setup === undefined) {
      setup = this.setupIndexes()
      this.indexesReady = setup
    }

    try {
      await setup
    } catch (error) {
      // Do not permanently cache a transient migration or index-build failure.
      if (this.indexesReady === setup) {
        this.indexesReady = undefined
      }
      throw error
    }
  }

  private async setupIndexes (): Promise<void> {
    await this.ensureUniqueProviderCapabilityIndex()
    await this.shipRecords.createIndex({ domain: 1, topic: 1 })
  }

  private async ensureUniqueProviderCapabilityIndex (): Promise<void> {
    for (let attempt = 0; attempt < UNIQUE_INDEX_SETUP_ATTEMPTS; attempt++) {
      if (await this.hasUniqueProviderCapabilityIndex()) return

      await this.deduplicateRecords()
      try {
        await this.shipRecords.createIndex(
          { identityKey: 1, domain: 1, topic: 1 },
          { unique: true }
        )
        return
      } catch (error) {
        // Unguarded writers from an older rolling-deployment instance can
        // introduce another duplicate between cleanup and index commit.
        if (!isDuplicateKeyError(error) || attempt === UNIQUE_INDEX_SETUP_ATTEMPTS - 1) {
          throw error
        }
      }
    }
  }

  private async hasUniqueProviderCapabilityIndex (): Promise<boolean> {
    try {
      const indexes = await this.shipRecords.indexes()
      return indexes.some(index =>
        index.unique === true &&
        index.key.identityKey === 1 &&
        index.key.domain === 1 &&
        index.key.topic === 1 &&
        Object.keys(index.key).length === 3
      )
    } catch (error) {
      // A collection is created by the first index build or write.
      if (isNamespaceNotFoundError(error)) return false
      throw error
    }
  }

  /**
   * Removes legacy duplicates while retaining the most recently advertised
   * outpoint for each provider/domain/topic tuple.
   */
  private async deduplicateRecords (): Promise<void> {
    const duplicateGroups = this.shipRecords.aggregate<DuplicateSHIPGroup>([
      {
        $group: {
          _id: {
            identityKey: '$identityKey',
            domain: '$domain',
            topic: '$topic'
          },
          count: { $sum: 1 }
        }
      },
      { $match: { count: { $gt: 1 } } }
    ], { allowDiskUse: true })

    for await (const group of duplicateGroups) {
      const records = this.shipRecords
        .find({
          identityKey: group._id.identityKey,
          domain: group._id.domain,
          topic: group._id.topic
        })
        .sort({ createdAt: -1, _id: -1 })
        .project<{ _id: ObjectId }>({ _id: 1 })

      let keepNewest = true
      let duplicateIds: ObjectId[] = []
      for await (const record of records) {
        if (keepNewest) {
          keepNewest = false
          continue
        }

        duplicateIds.push(record._id)
        if (duplicateIds.length >= 1000) {
          await this.shipRecords.deleteMany({ _id: { $in: duplicateIds } })
          duplicateIds = []
        }
      }

      if (duplicateIds.length > 0) {
        await this.shipRecords.deleteMany({ _id: { $in: duplicateIds } })
      }
    }
  }

  /**
   * Checks if a SHIP record exists for the same provider and topic.
   * @param {string} identityKey identity key
   * @param {string} domain domain name
   * @param {string} topic topic name
   * @returns {Promise<boolean>} true if a matching record exists
   */
  async hasDuplicateRecord (identityKey: string, domain: string, topic: string): Promise<boolean> {
    await this.ensureIndexes()
    return await this.shipRecords.findOne({ identityKey, domain, topic }) !== null
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
    await this.ensureIndexes()
    const filter = { identityKey, domain, topic }
    const update = {
      $set: {
        txid,
        outputIndex,
        ...filter,
        createdAt: new Date()
      }
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.shipRecords.updateOne(filter, update, { upsert: true })
        return
      } catch (error) {
        // A concurrent upsert inserted the logical record first. Retrying now
        // matches that row and updates it with this advertisement.
        if (!isDuplicateKeyError(error) || attempt === 1) {
          throw error
        }
      }
    }
  }

  /**
   * Deletes a SHIP record
   * @param {string} txid transaction id
   * @param {number} outputIndex index of the UTXO
   */
  async deleteSHIPRecord (txid: string, outputIndex: number): Promise<void> {
    await this.ensureIndexes()
    await this.shipRecords.deleteOne({ txid, outputIndex })
  }

  /**
   * Finds SHIP records based on a given query object.
   * @param {Object} query The query object which may contain properties for domain, topics, identityKey, limit, and skip.
   * @returns {Promise<UTXOReference[]>} Returns matching UTXO references.
   */
  async findRecord (query: SHIPQuery): Promise<UTXOReference[]> {
    await this.ensureIndexes()
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
    await this.ensureIndexes()
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
