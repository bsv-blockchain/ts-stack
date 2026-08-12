import { Collection, Db } from 'mongodb'
import { CollectionIndexes } from '../shared/collectionIndexes.js'
import { DstasTokenRecord, UTXOReference } from './types.js'

/**
 * Mongo-backed index of admitted DSTAS token UTXOs, by outpoint, tokenId, and
 * owner. This is the only public index for DSTAS — classic STAS has Bitails and
 * BSV-21 has the 1Sat overlay, but DSTAS has no third-party indexer, so this
 * overlay is the discovery surface.
 */
export class DstasStorageManager {
  private readonly tokens: Collection<DstasTokenRecord>

  private readonly indexes = new CollectionIndexes('DstasStorageManager', () => [
    { label: 'txid_1_outputIndex_1', collection: this.tokens, keys: { txid: 1, outputIndex: 1 }, options: { unique: true } },
    { label: 'tokenId_1', collection: this.tokens, keys: { tokenId: 1 } },
    { label: 'ownerHash160_1', collection: this.tokens, keys: { ownerHash160: 1 } }
  ])

  constructor (private readonly db: Db) {
    this.tokens = db.collection<DstasTokenRecord>('dstasTokens')
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
  async storeToken (record: DstasTokenRecord): Promise<void> {
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

  async findByTokenId (tokenId: string, frozen?: boolean): Promise<UTXOReference[]> {
    return await this.query({ tokenId, ...(frozen === undefined ? {} : { frozen }) })
  }

  async findByOwner (ownerHash160: string, frozen?: boolean): Promise<UTXOReference[]> {
    return await this.query({ ownerHash160, ...(frozen === undefined ? {} : { frozen }) })
  }

  async findByOutpoint (txid: string, outputIndex: number): Promise<UTXOReference[]> {
    return await this.query({ txid, outputIndex })
  }
}
