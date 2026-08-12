import { Collection, Db } from 'mongodb'
import { CollectionIndexes } from '../shared/collectionIndexes.js'
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

  private readonly indexes = new CollectionIndexes('MandalaStorageManager', () => [
    { label: 'mandalaTokens txid_1_outputIndex_1', collection: this.tokens, keys: { txid: 1, outputIndex: 1 }, options: { unique: true } },
    { label: 'mandalaTokens assetId_1', collection: this.tokens, keys: { assetId: 1 } },
    { label: 'mandalaTokens identityKey_1', collection: this.tokens, keys: { identityKey: 1 } },
    // Deliberately NO TTL index on linkage — retention is >= 5 years.
    { label: 'mandalaLinkageRecords txid_1_outputIndex_1', collection: this.linkage, keys: { txid: 1, outputIndex: 1 } },
    { label: 'mandalaLinkageRecords identityKey_1', collection: this.linkage, keys: { identityKey: 1 } },
    { label: 'mandalaBalances identityKey_1', collection: this.balances, keys: { identityKey: 1 }, options: { unique: true } },
    { label: 'mandalaMetadata txid_1_outputIndex_1', collection: this.metadata, keys: { txid: 1, outputIndex: 1 }, options: { unique: true } },
    { label: 'mandalaMetadata assetId_1', collection: this.metadata, keys: { assetId: 1 } },
    { label: 'mandalaAssetStates assetId_1', collection: this.assetStates, keys: { assetId: 1 }, options: { unique: true } },
    { label: 'mandalaAdminHistory assetId_1_height_1_offset_1_admitSeq_1', collection: this.adminHistory, keys: { assetId: 1, height: 1, offset: 1, admitSeq: 1 } }
  ])

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
    return await this.indexes.ensure()
  }

  /** Upsert on the outpoint: the same admitted output can arrive twice (GASP sync,
   * resubmission), and duplicate rows are what breaks the unique index build. */
  async storeToken (record: MandalaTokenRecord): Promise<void> {
    await this.ensureIndexes()
    await this.tokens.updateOne(
      { txid: record.txid, outputIndex: record.outputIndex },
      { $set: record },
      { upsert: true }
    )
  }

  async storeLinkage (record: MandalaLinkageRecord): Promise<void> {
    await this.ensureIndexes()
    await this.linkage.updateOne(
      { txid: record.txid, outputIndex: record.outputIndex },
      { $set: record },
      { upsert: true }
    )
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
    const state = await this.getAssetState(assetId)
    const evicted = new Set(state.evictedOutpoints)
    const rows = await this.tokens.find({ assetId })
      .project<UTXOReference>({ txid: 1, outputIndex: 1, _id: 0 }).toArray()
    return rows.filter(r => !evicted.has(`${r.txid}.${r.outputIndex}`))
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
