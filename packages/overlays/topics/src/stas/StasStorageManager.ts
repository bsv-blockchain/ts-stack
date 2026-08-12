import { Collection, Db } from 'mongodb'
import { CollectionIndexes } from '../shared/collectionIndexes.js'
import { StasTokenRecord, UTXOReference } from './types.js'

/**
 * Mongo-backed index of admitted classic-STAS token UTXOs. Indexes by
 * outpoint, assetId, and owner. Unlike the Mandala storage manager there is no
 * key-linkage retention and no per-identity balance collection — classic STAS
 * carries no identity linkage on-chain.
 */
export class StasStorageManager {
  private readonly tokens: Collection<StasTokenRecord>

  private readonly indexes = new CollectionIndexes('StasStorageManager', () => [
    { label: 'txid_1_outputIndex_1', collection: this.tokens, keys: { txid: 1, outputIndex: 1 }, options: { unique: true } },
    { label: 'assetId_1', collection: this.tokens, keys: { assetId: 1 } },
    { label: 'ownerHash160_1', collection: this.tokens, keys: { ownerHash160: 1 } }
  ])

  constructor (private readonly db: Db) {
    this.tokens = db.collection<StasTokenRecord>('stasTokens')
  }

  private async ensureIndexes (): Promise<void> {
    return await this.indexes.ensure()
  }

  /** Project a UTXO-reference cursor for a mongo filter (DRY for the finders). */
  private async query (filter: Record<string, unknown>): Promise<UTXOReference[]> {
    await this.ensureIndexes()
    return await this.tokens.find(filter)
      .project<UTXOReference>({ txid: 1, outputIndex: 1, _id: 0 }).toArray()
  }

  /** Upsert on the outpoint: the same admitted output can arrive twice (GASP sync,
   * resubmission), and duplicate rows are what breaks the unique index build. */
  async storeToken (record: StasTokenRecord): Promise<void> {
    await this.ensureIndexes()
    await this.tokens.updateOne(
      { txid: record.txid, outputIndex: record.outputIndex },
      { $set: record },
      { upsert: true }
    )
  }

  async deleteToken (txid: string, outputIndex: number): Promise<void> {
    await this.ensureIndexes()
    await this.tokens.deleteOne({ txid, outputIndex })
  }

  async findByAssetId (assetId: string): Promise<UTXOReference[]> {
    return await this.query({ assetId })
  }

  async findByOwner (ownerHash160: string): Promise<UTXOReference[]> {
    return await this.query({ ownerHash160 })
  }

  async findByOutpoint (txid: string, outputIndex: number): Promise<UTXOReference[]> {
    return await this.query({ txid, outputIndex })
  }

  async getTokenRow (txid: string, outputIndex: number): Promise<StasTokenRecord | null> {
    await this.ensureIndexes()
    return await this.tokens.findOne({ txid, outputIndex })
  }
}
