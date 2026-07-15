import { Collection, Db, ObjectId } from 'mongodb'
import { SLAPQuery, SLAPRecord, UTXOReference } from '../types.js'

interface DuplicateSLAPGroup {
  _id: Pick<SLAPRecord, 'identityKey' | 'domain' | 'service'>
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
 * Implements a storage engine for SLAP protocol
 */
export class SLAPStorage {
  private readonly slapRecords: Collection<SLAPRecord>
  private indexesReady?: Promise<void>

  /**
   * Constructs a new SLAPStorage instance
   * @param {Db} db - connected mongo database instance
   */
  constructor (private readonly db: Db) {
    this.slapRecords = db.collection<SLAPRecord>('slapRecords')
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
    await this.slapRecords.createIndex({ domain: 1, service: 1 })
  }

  private async ensureUniqueProviderCapabilityIndex (): Promise<void> {
    for (let attempt = 0; attempt < UNIQUE_INDEX_SETUP_ATTEMPTS; attempt++) {
      if (await this.hasUniqueProviderCapabilityIndex()) return

      await this.deduplicateRecords()
      try {
        await this.slapRecords.createIndex(
          { identityKey: 1, domain: 1, service: 1 },
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
      const indexes = await this.slapRecords.indexes()
      return indexes.some(index =>
        index.unique === true &&
        index.key.identityKey === 1 &&
        index.key.domain === 1 &&
        index.key.service === 1 &&
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
   * outpoint for each provider/domain/service tuple.
   */
  private async deduplicateRecords (): Promise<void> {
    const duplicateGroups = this.slapRecords.aggregate<DuplicateSLAPGroup>([
      {
        $group: {
          _id: {
            identityKey: '$identityKey',
            domain: '$domain',
            service: '$service'
          },
          count: { $sum: 1 }
        }
      },
      { $match: { count: { $gt: 1 } } }
    ], { allowDiskUse: true })

    for await (const group of duplicateGroups) {
      const records = this.slapRecords
        .find({
          identityKey: group._id.identityKey,
          domain: group._id.domain,
          service: group._id.service
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
          await this.slapRecords.deleteMany({ _id: { $in: duplicateIds } })
          duplicateIds = []
        }
      }

      if (duplicateIds.length > 0) {
        await this.slapRecords.deleteMany({ _id: { $in: duplicateIds } })
      }
    }
  }

  /**
   * Checks if a SLAP record exists for the same provider and service.
   * @param {string} identityKey identity key
   * @param {string} domain domain name
   * @param {string} service service name
   * @returns {Promise<boolean>} true if a matching record exists
   */
  async hasDuplicateRecord (identityKey: string, domain: string, service: string): Promise<boolean> {
    await this.ensureIndexes()
    return await this.slapRecords.findOne({ identityKey, domain, service }) !== null
  }

  /**
   * Stores a SLAP record
   * @param {string} txid transaction id
   * @param {number} outputIndex index of the UTXO
   * @param {string} identityKey identity key
   * @param {string} domain domain name
   * @param {string} service service name
   */
  async storeSLAPRecord (txid: string, outputIndex: number, identityKey: string, domain: string, service: string): Promise<void> {
    await this.ensureIndexes()
    const filter = { identityKey, domain, service }
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
        await this.slapRecords.updateOne(filter, update, { upsert: true })
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
   * Deletes a SLAP record
   * @param {string} txid transaction id
   * @param {number} outputIndex index of the UTXO
   */
  async deleteSLAPRecord (txid: string, outputIndex: number): Promise<void> {
    await this.ensureIndexes()
    await this.slapRecords.deleteOne({ txid, outputIndex })
  }

  /**
   * Finds SLAP records based on a given query object.
   * @param {Object} query The query object which may contain properties for domain, service, and/or identityKey.
   * @returns {Promise<UTXOReference[]>} returns matching UTXO references
   */
  async findRecord (query: SLAPQuery): Promise<UTXOReference[]> {
    await this.ensureIndexes()
    const mongoQuery: any = {}

    // Add domain to the query if provided
    if (typeof query.domain === 'string') {
      mongoQuery.domain = query.domain
    }

    // Add service to the query if provided
    if (typeof query.service === 'string') {
      mongoQuery.service = query.service
    }

    // Add identityKey to the query if provided
    if (typeof query.identityKey === 'string') {
      mongoQuery.identityKey = query.identityKey
    }

    // Build the query with pagination
    let cursor = this.slapRecords
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
      .then(results => results.map(record => ({
        txid: record.txid,
        outputIndex: record.outputIndex
      })))
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
    let cursor = this.slapRecords.find({})
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
      .then(results => results.map(slapRecords => ({
        txid: slapRecords.txid,
        outputIndex: slapRecords.outputIndex
      })))
  }
}
