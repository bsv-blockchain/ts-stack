// Persisted collections of the Mandala lookup database (BRC-162 design spec 6.6). Field names
// and types are frozen there; the Go port reads and writes the same shapes.
import { Collection, Db, Filter } from 'mongodb'
import { CollectionIndexes } from '../shared/collectionIndexes.js'
import {
  AdminHistoryEntry,
  MandalaAuthorityRecord,
  MandalaLinkageRecord,
  MandalaMetadataRecord,
  MandalaOwnerRecord,
  MandalaTokenRecord
} from './types.js'
import { AssetAdminState, defaultAssetState } from './AssetStateReducer.js'

interface BalanceRecord {
  identityKey: string
  balance: number
}

const OUTPOINT = /^([0-9a-fA-F]{64})\.(0|[1-9]\d{0,9})$/

/** `<txid>.<vout>` as a Mongo key pair, or nothing for an entry that cannot match a row. */
const outpointKey = (outpoint: string): Array<{ txid: string; outputIndex: number }> => {
  const match = OUTPOINT.exec(outpoint)
  return match === null ? [] : [{ txid: match[1].toLowerCase(), outputIndex: Number(match[2]) }]
}

export class MandalaStorageManager implements MandalaStateStore {
  private readonly owners: Collection<MandalaOwnerRecord>
  private readonly tokens: Collection<MandalaTokenRecord>
  private readonly authorities: Collection<MandalaAuthorityRecord>
  private readonly linkage: Collection<MandalaLinkageRecord>
  private readonly balances: Collection<BalanceRecord>
  private readonly metadata: Collection<MandalaMetadataRecord>
  private readonly assetStates: Collection<AssetAdminState>
  private readonly adminHistory: Collection<AdminHistoryEntry>
  private readonly counters: Collection<{ _id: string; seq: number }>

  private readonly indexes = new CollectionIndexes('MandalaStorageManager', () => [
    {
      label: 'mandalaOwners txid_1_outputIndex_1_topic_1',
      collection: this.owners,
      keys: { txid: 1, outputIndex: 1, topic: 1 },
      options: { unique: true }
    },
    {
      label: 'mandalaTokens txid_1_outputIndex_1',
      collection: this.tokens,
      keys: { txid: 1, outputIndex: 1 },
      options: { unique: true }
    },
    { label: 'mandalaTokens tokenId_1', collection: this.tokens, keys: { tokenId: 1 } },
    { label: 'mandalaTokens identityKey_1', collection: this.tokens, keys: { identityKey: 1 } },
    {
      label: 'mandalaAuthorities txid_1_outputIndex_1',
      collection: this.authorities,
      keys: { txid: 1, outputIndex: 1 },
      options: { unique: true }
    },
    {
      label: 'mandalaAuthorities topic_1_tokenId_1',
      collection: this.authorities,
      keys: { topic: 1, tokenId: 1 }
    },
    // Deliberately NO TTL index on linkage — retention is >= 5 years.
    {
      label: 'mandalaLinkageRecords txid_1_outputIndex_1',
      collection: this.linkage,
      keys: { txid: 1, outputIndex: 1 }
    },
    {
      label: 'mandalaLinkageRecords identityKey_1',
      collection: this.linkage,
      keys: { identityKey: 1 }
    },
    {
      label: 'mandalaBalances identityKey_1',
      collection: this.balances,
      keys: { identityKey: 1 },
      options: { unique: true }
    },
    {
      label: 'mandalaMetadata tokenId_1',
      collection: this.metadata,
      keys: { tokenId: 1 },
      options: { unique: true }
    },
    {
      label: 'mandalaAssetStates tokenId_1',
      collection: this.assetStates,
      keys: { tokenId: 1 },
      options: { unique: true }
    },
    {
      label: 'mandalaAdminHistory tokenId_1_height_1_offset_1_admitSeq_1',
      collection: this.adminHistory,
      keys: { tokenId: 1, height: 1, offset: 1, admitSeq: 1 }
    },
    {
      label: 'mandalaAdminHistory tokenId_1_txid_1_outputIndex_1',
      collection: this.adminHistory,
      keys: { tokenId: 1, txid: 1, outputIndex: 1 }
    },
    { label: 'mandalaAdminHistory txid_1', collection: this.adminHistory, keys: { txid: 1 } }
  ])

  constructor(db: Db) {
    this.owners = db.collection<MandalaOwnerRecord>('mandalaOwners')
    this.tokens = db.collection<MandalaTokenRecord>('mandalaTokens')
    this.authorities = db.collection<MandalaAuthorityRecord>('mandalaAuthorities')
    this.linkage = db.collection<MandalaLinkageRecord>('mandalaLinkageRecords')
    this.balances = db.collection<BalanceRecord>('mandalaBalances')
    this.metadata = db.collection<MandalaMetadataRecord>('mandalaMetadata')
    this.assetStates = db.collection<AssetAdminState>('mandalaAssetStates')
    this.adminHistory = db.collection<AdminHistoryEntry>('mandalaAdminHistory')
    this.counters = db.collection<{ _id: string; seq: number }>('mandalaCounters')
  }

  private async ensureIndexes(): Promise<void> {
    return await this.indexes.ensure()
  }

  // ---- owner journal (append-only source of truth, spec 4.2a) ----

  /**
   * Appends journal rows. A row whose `(txid, outputIndex, topic)` already exists is left as it
   * is (the first write wins), so replays and concurrent writers are harmless. Written as
   * insert-if-absent upserts rather than inserts: a duplicate is then never an error to tell
   * apart from a real failure, it still holds when an index build was skipped, and the caller's
   * rows are not given an `_id`. Any real failure throws.
   */
  async recordOwners(rows: readonly MandalaOwnerRecord[]): Promise<void> {
    if (rows.length === 0) return
    await this.ensureIndexes()
    await this.owners.bulkWrite(
      rows.map(row => ({
        updateOne: {
          filter: { txid: row.txid, outputIndex: row.outputIndex, topic: row.topic },
          update: { $setOnInsert: row },
          upsert: true
        }
      })),
      { ordered: false }
    )
  }

  async getOwnerJournal(
    txid: string,
    outputIndex: number,
    topic: string
  ): Promise<MandalaOwnerRecord | null> {
    await this.ensureIndexes()
    return await this.owners.findOne({ txid, outputIndex, topic }, { projection: { _id: 0 } })
  }

  // ---- value index ----

  async getTokenRow(txid: string, outputIndex: number): Promise<MandalaTokenRecord | null> {
    await this.ensureIndexes()
    return await this.tokens.findOne({ txid, outputIndex }, { projection: { _id: 0 } })
  }

  /**
   * Atomically stores a newly admitted token without replacing an existing outpoint. Returns true
   * only to the call that created the row, so a replay cannot credit the cached balance twice.
   */
  async storeTokenIfAbsent(row: MandalaTokenRecord): Promise<boolean> {
    await this.ensureIndexes()
    const result = await this.tokens.updateOne(
      { txid: row.txid, outputIndex: row.outputIndex },
      { $setOnInsert: row },
      { upsert: true }
    )
    return result.upsertedCount === 1
  }

  /** Atomically removes and returns one row, for idempotent spend and eviction accounting. */
  async takeToken(txid: string, outputIndex: number): Promise<MandalaTokenRecord | null> {
    await this.ensureIndexes()
    return await this.tokens.findOneAndDelete({ txid, outputIndex }, { projection: { _id: 0 } })
  }

  /** In outpoint order, so consecutive pages neither repeat nor skip a row. */
  async findTokensByTokenId(
    tokenId: string,
    limit: number,
    skip: number
  ): Promise<MandalaTokenRecord[]> {
    await this.ensureIndexes()
    return await this.tokens
      .find(await this.liveTokenFilter(tokenId), { projection: { _id: 0 } })
      .sort({ txid: 1, outputIndex: 1 })
      .skip(skip)
      .limit(limit)
      .toArray()
  }

  /**
   * Sum of the token's unspent rows. An outpoint in the token's `evictedOutpoints` still has a row
   * (a reissued frozen coin stays on chain) but is no longer money, so it is not counted twice.
   * Summed as bigint: a double sum of 2^53-sized rows would silently lose the low bits.
   */
  async circulatingSupply(tokenId: string): Promise<bigint> {
    await this.ensureIndexes()
    const rows = this.tokens.find(await this.liveTokenFilter(tokenId), {
      projection: { _id: 0, amount: 1 }
    })
    let total = 0n
    for await (const row of rows) total += BigInt(row.amount)
    return total
  }

  /** The token's rows minus its evicted outpoints, as a server-side filter so paging stays exact. */
  private async liveTokenFilter(tokenId: string): Promise<Filter<MandalaTokenRecord>> {
    const state = await this.assetStates.findOne(
      { tokenId },
      { projection: { _id: 0, evictedOutpoints: 1 } }
    )
    const evicted = (state?.evictedOutpoints ?? []).flatMap(outpointKey)
    return evicted.length === 0 ? { tokenId } : { tokenId, $nor: evicted }
  }

  // ---- authority index ----

  async getAuthorityRow(txid: string, outputIndex: number): Promise<MandalaAuthorityRecord | null> {
    await this.ensureIndexes()
    return await this.authorities.findOne({ txid, outputIndex }, { projection: { _id: 0 } })
  }

  async storeAuthorityIfAbsent(row: MandalaAuthorityRecord): Promise<boolean> {
    await this.ensureIndexes()
    const result = await this.authorities.updateOne(
      { txid: row.txid, outputIndex: row.outputIndex },
      { $setOnInsert: row },
      { upsert: true }
    )
    return result.upsertedCount === 1
  }

  async takeAuthority(txid: string, outputIndex: number): Promise<MandalaAuthorityRecord | null> {
    await this.ensureIndexes()
    return await this.authorities.findOneAndDelete(
      { txid, outputIndex },
      { projection: { _id: 0 } }
    )
  }

  async listAuthorities(topic: string, tokenId: string): Promise<MandalaAuthorityRecord[]> {
    await this.ensureIndexes()
    return await this.authorities
      .find({ topic, tokenId }, { projection: { _id: 0 } })
      .sort({ txid: 1, outputIndex: 1 })
      .toArray()
  }

  // ---- spec 4.2a repair ----

  /**
   * Upserts the index row of a journalled output (value journals into `mandalaTokens`, deploy and
   * authority journals into `mandalaAuthorities`). A missing row is inserted; a row that disagrees
   * is corrected from the journal, keeping its own `createdAt`. The balance is credited only when
   * a value row is inserted, so repeating a repair, or racing another one, credits exactly once.
   * The balance of a corrected row is left alone, as in the eviction restore.
   */
  async repairOwnerRow(journal: MandalaOwnerRecord): Promise<{ inserted: boolean }> {
    await this.ensureIndexes()
    const inserted =
      journal.role === 'value'
        ? await this.repairTokenRow(journal)
        : await this.repairAuthorityRow(journal)
    return { inserted }
  }

  private async repairTokenRow(journal: MandalaOwnerRecord): Promise<boolean> {
    const before = await this.tokens.findOneAndUpdate(
      { txid: journal.txid, outputIndex: journal.outputIndex },
      {
        $set: {
          tokenId: journal.tokenId,
          amount: journal.amount,
          identityKey: journal.identityKey
        },
        $setOnInsert: { createdAt: journal.createdAt }
      },
      { upsert: true, returnDocument: 'before', projection: { _id: 1 } }
    )
    if (before !== null) return false
    await this.adjustBalance(journal.identityKey, journal.amount)
    return true
  }

  private async repairAuthorityRow(journal: MandalaOwnerRecord): Promise<boolean> {
    const before = await this.authorities.findOneAndUpdate(
      { txid: journal.txid, outputIndex: journal.outputIndex },
      {
        $set: { topic: journal.topic, tokenId: journal.tokenId, identityKey: journal.identityKey },
        $setOnInsert: { createdAt: journal.createdAt }
      },
      { upsert: true, returnDocument: 'before', projection: { _id: 1 } }
    )
    return before === null
  }

  // ---- balances, linkage, metadata ----

  async adjustBalance(identityKey: string, delta: number): Promise<void> {
    await this.ensureIndexes()
    await this.balances.updateOne({ identityKey }, { $inc: { balance: delta } }, { upsert: true })
  }

  async getBalance(identityKey: string): Promise<number> {
    await this.ensureIndexes()
    const rec = await this.balances.findOne({ identityKey })
    return rec?.balance ?? 0
  }

  async storeLinkage(rec: MandalaLinkageRecord): Promise<void> {
    await this.ensureIndexes()
    await this.linkage.updateOne(
      { txid: rec.txid, outputIndex: rec.outputIndex },
      { $set: rec },
      { upsert: true }
    )
  }

  async storeMetadata(m: MandalaMetadataRecord): Promise<void> {
    await this.ensureIndexes()
    await this.metadata.updateOne({ tokenId: m.tokenId }, { $set: m }, { upsert: true })
  }

  async findMetadata(tokenId: string): Promise<MandalaMetadataRecord | null> {
    await this.ensureIndexes()
    return await this.metadata.findOne({ tokenId }, { projection: { _id: 0 } })
  }

  async deleteMetadata(tokenId: string): Promise<void> {
    await this.ensureIndexes()
    await this.metadata.deleteOne({ tokenId })
  }

  // ---- asset state and admin history ----

  async getAssetState(tokenId: string): Promise<AssetAdminState> {
    await this.ensureIndexes()
    const doc = await this.assetStates.findOne({ tokenId }, { projection: { _id: 0 } })
    return doc ?? defaultAssetState(tokenId)
  }

  async putAssetState(s: AssetAdminState): Promise<void> {
    await this.ensureIndexes()
    await this.assetStates.updateOne({ tokenId: s.tokenId }, { $set: s }, { upsert: true })
  }

  /** Stores `s` only when the token has no state yet; true when it did. A replay never resets one. */
  async putAssetStateIfAbsent(s: AssetAdminState): Promise<boolean> {
    await this.ensureIndexes()
    const result = await this.assetStates.updateOne(
      { tokenId: s.tokenId },
      { $setOnInsert: s },
      { upsert: true }
    )
    return result.upsertedCount === 1
  }

  /**
   * Appends one history row per `(tokenId, txid, outputIndex)`: the first write wins and a replay
   * returns false, so a committed action is never recorded or folded twice. The key's index is not
   * unique (§6.6), so only two truly concurrent writes of the same row could both insert.
   */
  async appendAdminHistory(e: AdminHistoryEntry): Promise<boolean> {
    await this.ensureIndexes()
    const result = await this.adminHistory.updateOne(
      { tokenId: e.tokenId, txid: e.txid, outputIndex: e.outputIndex },
      { $setOnInsert: e },
      { upsert: true }
    )
    return result.upsertedCount === 1
  }

  /** In fold order: `(height, offset, admitSeq)` ascending. */
  async findAdminHistory(tokenId: string, limit?: number, skip = 0): Promise<AdminHistoryEntry[]> {
    await this.ensureIndexes()
    let cursor = this.adminHistory
      .find({ tokenId }, { projection: { _id: 0 } })
      .sort({ height: 1, offset: 1, admitSeq: 1 })
      .skip(skip)
    if (limit !== undefined) cursor = cursor.limit(limit)
    return await cursor.toArray()
  }

  /** Every token with admin history: the set the boot refold must rebuild (spec §6.6). */
  async tokenIdsWithHistory(): Promise<string[]> {
    await this.ensureIndexes()
    return await this.adminHistory.distinct('tokenId')
  }

  /** Every token a transaction has admin history for: the set an eviction must refold. */
  async tokensTouchedBy(txid: string): Promise<string[]> {
    await this.ensureIndexes()
    return await this.adminHistory.distinct('tokenId', { txid })
  }

  async deleteAdminHistoryByTxid(txid: string): Promise<void> {
    await this.ensureIndexes()
    await this.adminHistory.deleteMany({ txid })
  }

  async nextAdmitSeq(): Promise<number> {
    await this.ensureIndexes()
    const r = await this.counters.findOneAndUpdate(
      { _id: 'admitSeq' },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: 'after' }
    )
    return (r as { seq: number } | null)?.seq ?? 1
  }
}

/**
 * The read and repair surface the validation layers need (ownership, authority, controls),
 * including the undo of a repair that raced a spend (`takeToken`, `takeAuthority`,
 * `adjustBalance`).
 */
export type MandalaStateStore = Pick<
  MandalaStorageManager,
  | 'getAssetState'
  | 'getTokenRow'
  | 'getAuthorityRow'
  | 'getOwnerJournal'
  | 'recordOwners'
  | 'repairOwnerRow'
  | 'takeToken'
  | 'takeAuthority'
  | 'adjustBalance'
  | 'circulatingSupply'
>
