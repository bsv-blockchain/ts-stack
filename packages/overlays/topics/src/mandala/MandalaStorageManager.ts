import { Collection, Db } from 'mongodb'
import {
  MandalaTokenRecord, MandalaLinkageRecord, UTXOReference
} from './types.js'

interface BalanceRecord { identityKey: string, balance: number }
interface MetadataRecord { txid: string, outputIndex: number, assetId: string }

export class MandalaStorageManager {
  private readonly tokens: Collection<MandalaTokenRecord>
  private readonly linkage: Collection<MandalaLinkageRecord>
  private readonly balances: Collection<BalanceRecord>
  private readonly metadata: Collection<MetadataRecord>
  private indexInit?: Promise<void>

  constructor (private readonly db: Db) {
    this.tokens = db.collection<MandalaTokenRecord>('mandalaTokens')
    this.linkage = db.collection<MandalaLinkageRecord>('mandalaLinkageRecords')
    this.balances = db.collection<BalanceRecord>('mandalaBalances')
    this.metadata = db.collection<MetadataRecord>('mandalaMetadata')
  }

  private async ensureIndexes (): Promise<void> {
    this.indexInit ??= (async () => {
      await Promise.all([
        this.tokens.createIndex({ txid: 1, outputIndex: 1 }, { unique: true }),
        this.tokens.createIndex({ assetId: 1 }),
        this.tokens.createIndex({ identityKey: 1 }),
        // Deliberately NO TTL index on linkage — retention is >= 5 years.
        this.linkage.createIndex({ txid: 1, outputIndex: 1 }),
        this.linkage.createIndex({ identityKey: 1 }),
        this.balances.createIndex({ identityKey: 1 }, { unique: true }),
        this.metadata.createIndex({ txid: 1, outputIndex: 1 }, { unique: true }),
        this.metadata.createIndex({ assetId: 1 })
      ])
    })()
    return await this.indexInit
  }

  async storeToken (record: MandalaTokenRecord): Promise<void> {
    await this.ensureIndexes()
    await this.tokens.insertOne(record)
  }

  async storeLinkage (record: MandalaLinkageRecord): Promise<void> {
    await this.ensureIndexes()
    await this.linkage.insertOne(record)
  }

  async adjustBalance (identityKey: string, delta: number): Promise<void> {
    await this.ensureIndexes()
    await this.balances.updateOne(
      { identityKey },
      { $inc: { balance: delta } },
      { upsert: true }
    )
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

  async findByOutpoint (txid: string, outputIndex: number): Promise<UTXOReference[]> {
    await this.ensureIndexes()
    return await this.tokens.find({ txid, outputIndex })
      .project<UTXOReference>({ txid: 1, outputIndex: 1, _id: 0 }).toArray()
  }

  async getTokenRow (txid: string, outputIndex: number): Promise<MandalaTokenRecord | null> {
    await this.ensureIndexes()
    return await this.tokens.findOne({ txid, outputIndex })
  }

  async getBalance (identityKey: string): Promise<number> {
    await this.ensureIndexes()
    const rec = await this.balances.findOne({ identityKey })
    return rec?.balance ?? 0
  }

  async storeMetadata (record: { txid: string, outputIndex: number, assetId: string }): Promise<void> {
    await this.ensureIndexes()
    await this.metadata.updateOne(
      { txid: record.txid, outputIndex: record.outputIndex },
      { $set: record },
      { upsert: true }
    )
  }

  async findMetadataByAssetId (assetId: string): Promise<UTXOReference[]> {
    await this.ensureIndexes()
    return await this.metadata.find({ assetId })
      .project<UTXOReference>({ txid: 1, outputIndex: 1, _id: 0 }).toArray()
  }

  async deleteMetadata (txid: string, outputIndex: number): Promise<void> {
    await this.ensureIndexes()
    await this.metadata.deleteOne({ txid, outputIndex })
  }
}
