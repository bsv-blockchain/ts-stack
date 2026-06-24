import { Collection, Db } from 'mongodb'
import { Bsv21TokenRecord, UTXOReference } from './types.js'

/**
 * Mongo-backed index of admitted BSV-21 token UTXOs, by outpoint, tokenId, and
 * owner. The raw bigint amount is retained (as a string) for explorer use.
 */
export class Bsv21StorageManager {
  private readonly tokens: Collection<Bsv21TokenRecord>
  private indexInit?: Promise<void>

  constructor (private readonly db: Db) {
    this.tokens = db.collection<Bsv21TokenRecord>('bsv21Tokens')
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

  async storeToken (record: Bsv21TokenRecord): Promise<void> {
    await this.ensureIndexes()
    await this.tokens.insertOne(record)
  }

  async deleteToken (txid: string, outputIndex: number): Promise<void> {
    await this.ensureIndexes()
    await this.tokens.deleteOne({ txid, outputIndex })
  }

  async findByTokenId (tokenId: string): Promise<UTXOReference[]> {
    await this.ensureIndexes()
    return await this.tokens.find({ tokenId })
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
}
