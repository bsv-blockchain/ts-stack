import { Collection, Db } from 'mongodb'
import { StasTokenRecord, UTXOReference } from './types.js'

/**
 * Mongo-backed index of admitted classic-STAS token UTXOs. Indexes by
 * outpoint, assetId, and owner. Unlike the Mandala storage manager there is no
 * key-linkage retention and no per-identity balance collection — classic STAS
 * carries no identity linkage on-chain.
 */
export class StasStorageManager {
  private readonly tokens: Collection<StasTokenRecord>
  private indexInit?: Promise<void>

  constructor (private readonly db: Db) {
    this.tokens = db.collection<StasTokenRecord>('stasTokens')
  }

  private async ensureIndexes (): Promise<void> {
    this.indexInit ??= (async () => {
      await Promise.all([
        this.tokens.createIndex({ txid: 1, outputIndex: 1 }, { unique: true }),
        this.tokens.createIndex({ assetId: 1 }),
        this.tokens.createIndex({ ownerHash160: 1 })
      ])
    })()
    return await this.indexInit
  }

  async storeToken (record: StasTokenRecord): Promise<void> {
    await this.ensureIndexes()
    await this.tokens.insertOne(record)
  }

  async deleteToken (txid: string, outputIndex: number): Promise<void> {
    await this.ensureIndexes()
    await this.tokens.deleteOne({ txid, outputIndex })
  }

  async findByAssetId (assetId: string): Promise<UTXOReference[]> {
    await this.ensureIndexes()
    return await this.tokens.find({ assetId })
      .project<UTXOReference>({ txid: 1, outputIndex: 1, _id: 0 }).toArray()
  }

  async findByOwner (ownerHash160: string): Promise<UTXOReference[]> {
    await this.ensureIndexes()
    return await this.tokens.find({ ownerHash160 })
      .project<UTXOReference>({ txid: 1, outputIndex: 1, _id: 0 }).toArray()
  }

  async findByOutpoint (txid: string, outputIndex: number): Promise<UTXOReference[]> {
    await this.ensureIndexes()
    return await this.tokens.find({ txid, outputIndex })
      .project<UTXOReference>({ txid: 1, outputIndex: 1, _id: 0 }).toArray()
  }

  async getTokenRow (txid: string, outputIndex: number): Promise<StasTokenRecord | null> {
    await this.ensureIndexes()
    return await this.tokens.findOne({ txid, outputIndex })
  }
}
