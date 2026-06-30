import { Collection, Db } from 'mongodb'
import {
  MandalaTokenRecord, MandalaLinkageRecord, UTXOReference, AssetAdminState, AdminHistoryEntry
} from './types.js'
import { defaultAssetState } from './AssetStateReducer.js'

interface BalanceRecord { identityKey: string, balance: number }
interface MetadataRecord { txid: string, outputIndex: number, assetId: string }

export class MandalaStorageManager {
  private readonly tokens: Collection<MandalaTokenRecord>
  private readonly linkage: Collection<MandalaLinkageRecord>
  private readonly balances: Collection<BalanceRecord>
  private readonly metadata: Collection<MetadataRecord>
  private readonly assetStates: Collection<AssetAdminState>
  private readonly adminHistory: Collection<AdminHistoryEntry>
  private readonly counters: Collection<{ _id: string, seq: number }>
  private indexInit?: Promise<void>

  constructor (private readonly db: Db) {
    this.tokens = db.collection<MandalaTokenRecord>('mandalaTokens')
    this.linkage = db.collection<MandalaLinkageRecord>('mandalaLinkageRecords')
    this.balances = db.collection<BalanceRecord>('mandalaBalances')
    this.metadata = db.collection<MetadataRecord>('mandalaMetadata')
    this.assetStates = db.collection<AssetAdminState>('mandalaAssetStates')
    this.adminHistory = db.collection<AdminHistoryEntry>('mandalaAdminHistory')
    this.counters = db.collection<{ _id: string, seq: number }>('mandalaCounters')
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
        this.metadata.createIndex({ assetId: 1 }),
        this.assetStates.createIndex({ assetId: 1 }, { unique: true }),
        this.adminHistory.createIndex({ assetId: 1, height: 1, offset: 1, admitSeq: 1 })
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

  async getAssetState (assetId: string): Promise<AssetAdminState> {
    await this.ensureIndexes()
    const doc = await this.assetStates.findOne({ assetId }, { projection: { _id: 0 } })
    return doc ?? defaultAssetState(assetId)
  }

  async putAssetState (state: AssetAdminState): Promise<void> {
    await this.ensureIndexes()
    await this.assetStates.updateOne({ assetId: state.assetId }, { $set: state }, { upsert: true })
  }

  async appendAdminHistory (entry: AdminHistoryEntry): Promise<void> {
    await this.ensureIndexes()
    await this.adminHistory.insertOne(entry)
  }

  async findAdminHistoryByAssetId (assetId: string): Promise<AdminHistoryEntry[]> {
    await this.ensureIndexes()
    return await this.adminHistory.find({ assetId }, { projection: { _id: 0 } })
      .sort({ height: 1, offset: 1, admitSeq: 1 }).toArray()
  }

  async nextAdmitSeq (): Promise<number> {
    await this.ensureIndexes()
    const r = await this.counters.findOneAndUpdate(
      { _id: 'admitSeq' }, { $inc: { seq: 1 } },
      { upsert: true, returnDocument: 'after' }
    )
    return (r as { seq: number } | null)?.seq ?? 1
  }

  async findStateByAssetId (assetId: string): Promise<AssetAdminState[]> {
    const s = await this.getAssetState(assetId)
    return [s]
  }
}
