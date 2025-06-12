import { Collection, Db } from 'mongodb'
import { LookupFormula } from '@bsv/overlay'
import { AppCatalogRecord, PublishedAppMetadata } from './types.js'

/**
 * Storage manager for the on-chain Apps catalogue overlay.
 */
export class AppsStorageManager {
  private readonly records: Collection<AppCatalogRecord>

  /**
   * @param db  A connected MongoDB database handle.
   */
  constructor(private readonly db: Db) {
    this.records = db.collection<AppCatalogRecord>('appsCatalogRecords')

    // Simple full-text index so callers can perform ad-hoc searches.
    this.records
      .createIndex({
        'metadata.name': 'text',
        'metadata.description': 'text',
        'metadata.tags': 'text',
        'metadata.domain': 'text'
      })
      .catch(console.error)
  }

  /**
   * Insert a new app-token record.
   */
  async storeRecord(
    txid: string,
    outputIndex: number,
    metadata: PublishedAppMetadata
  ): Promise<void> {
    await this.records.insertOne({
      txid,
      outputIndex,
      metadata,
      createdAt: new Date()
    })
  }

  /**
   * Remove an app-token record identified by its UTXO.
   */
  async deleteRecord(txid: string, outputIndex: number): Promise<void> {
    await this.records.deleteOne({ txid, outputIndex })
  }

  /**
   * Fetch every record published for a specific domain.
   */
  async findByDomain(domain: string): Promise<LookupFormula> {
    return this.findRecordWithQuery({ 'metadata.domain': domain })
  }

  /**
   * Fetch every record by publisher (identity key).
   */
  async findByPublisher(publisher: string): Promise<LookupFormula> {
    return this.findRecordWithQuery({ 'metadata.publisher': publisher })
  }

  /**
   * Look up the single record behind an outpoint ("txid.outputIndex").
   * Throws if the outpoint string is malformed.
   */
  async findByOutpoint(outpoint: string): Promise<LookupFormula> {
    const [txid, indexStr] = outpoint.split('.')
    const outputIndex = Number(indexStr)

    if (!txid || Number.isNaN(outputIndex)) {
      throw new Error('Invalid outpoint format – expected "txid.outputIndex"')
    }

    return this.findRecordWithQuery({ txid, outputIndex })
  }

  /**
  * Fuzzy-match apps by (partial) name.
  * By default uses a case-insensitive RegExp; adjust `limit` as needed.
  *
  * If you have MongoDB Atlas Search, prefer the commented aggregation
  * below for better fuzzy scoring/ordering.
  */
  async findByNameFuzzy(
    partialName: string,
    limit = 20
  ): Promise<LookupFormula> {
    // Escape regex metacharacters so user input is safe
    const escaped = partialName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(escaped, 'i')

    return this.records
      .find({ 'metadata.name': { $regex: regex } })
      .limit(limit)
      .toArray()

    /* ---------- Note: Consider supporting Atlas Search version ----------
    return this.records
      .aggregate<AppCatalogRecord>([
        {
          $search: {
            index: 'default',                 // Atlas Search index
            text: {
              query: partialName,
              path: 'metadata.name',
              fuzzy: { maxEdits: 2 }
            }
          }
        },
        { $limit: limit }
      ])
      .toArray()
    ------------------------------------------- */
  }

  /**
   * Helper function for querying from the database
   * @param {object} query
   * @returns {Promise<LookupFormula>} returns matching UTXO references
   */
  private async findRecordWithQuery(query: object): Promise<LookupFormula> {
    // Find matching results from the DB
    const results = await this.records.find(query).project({ txid: 1, outputIndex: 1 }).toArray()
    return results.map((record: any) => {
      return {
        txid: record.txid,
        outputIndex: record.outputIndex
      }
    })
  }
}
