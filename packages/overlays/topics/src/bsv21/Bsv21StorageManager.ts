import { Collection, Db } from 'mongodb'
import { CollectionIndexes } from '../shared/collectionIndexes.js'
import { Bsv21TokenRecord, UTXOReference } from './types.js'

/**
 * Mongo-backed index of admitted BSV-21 token UTXOs, by outpoint, tokenId, and
 * owner. The raw bigint amount is retained (as a string) for explorer use.
 */
export class Bsv21StorageManager {
  private readonly tokens: Collection<Bsv21TokenRecord>

  private readonly indexes = new CollectionIndexes('Bsv21StorageManager', () => [
    { label: 'txid_1_outputIndex_1', collection: this.tokens, keys: { txid: 1, outputIndex: 1 }, options: { unique: true } },
    { label: 'tokenId_1', collection: this.tokens, keys: { tokenId: 1 } },
    { label: 'ownerHash160_1', collection: this.tokens, keys: { ownerHash160: 1 } }
  ])

  constructor (private readonly db: Db) {
    this.tokens = db.collection<Bsv21TokenRecord>('bsv21Tokens')
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
  async storeToken (record: Bsv21TokenRecord): Promise<void> {
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

  async findByTokenId (tokenId: string): Promise<UTXOReference[]> {
    return await this.query({ tokenId })
  }

  async findByOwner (ownerHash160: string): Promise<UTXOReference[]> {
    return await this.query({ ownerHash160 })
  }

  async findByOutpoint (txid: string, outputIndex: number): Promise<UTXOReference[]> {
    return await this.query({ txid, outputIndex })
  }
}
