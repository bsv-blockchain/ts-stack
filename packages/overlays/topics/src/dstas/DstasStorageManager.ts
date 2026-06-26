import { Collection, Db } from 'mongodb'
import { DstasTokenRecord, UTXOReference } from './types.js'

/**
 * Mongo-backed index of admitted DSTAS token UTXOs, by outpoint, tokenId, and
 * owner. This is the only public index for DSTAS — classic STAS has Bitails and
 * BSV-21 has the 1Sat overlay, but DSTAS has no third-party indexer, so this
 * overlay is the discovery surface.
 */
export class DstasStorageManager {
  private readonly tokens: Collection<DstasTokenRecord>
  private indexInit?: Promise<void>

  constructor (private readonly db: Db) {
    this.tokens = db.collection<DstasTokenRecord>('dstasTokens')
  }

  private async ensureIndexes (): Promise<void> {
    this.indexInit ??= (async () => {
      await Promise.all([
        this.tokens.createIndex({ txid: 1, outputIndex: 1 }, { unique: true }),
        this.tokens.createIndex({ tokenId: 1 }),
        this.tokens.createIndex({ ownerHash160: 1 })
      ])
    })()
    return await this.indexInit
  }

  /** Project a UTXO-reference cursor for a mongo filter (DRY for the finders). */
  private async query (filter: Record<string, unknown>): Promise<UTXOReference[]> {
    await this.ensureIndexes()
    return await this.tokens.find(filter)
      .project<UTXOReference>({ txid: 1, outputIndex: 1, _id: 0 }).toArray()
  }

  async storeToken (record: DstasTokenRecord): Promise<void> {
    await this.ensureIndexes()
    await this.tokens.insertOne(record)
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
