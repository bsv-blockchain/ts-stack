// The registry's persisted state (spec §5.4, §6.6): collection `mandalaRegistry`, one row per
// identity, plus one meta document `{_id: 'registryTokenId'}` that names the registry token (the
// first deploy the lookup service claims). The collection is a cache of the registry chain; the
// membership gate reads it through `registryMembership`.
import type { Collection, Db } from 'mongodb'
import { CollectionIndexes } from '../shared/collectionIndexes.js'
import type { MembershipProvider } from '../mandala/types.js'

export type RegistryStatus = 'admitted' | 'revoked'

/** The outpoint of the registry action a row was folded from. */
export interface RegistryRef {
  txid: string
  outputIndex: number
}

export interface RegistryRow extends RegistryRef {
  identityKey: string
  status: RegistryStatus
  admitSeq: number
}

interface StoredRow extends RegistryRow {
  createdAt: Date
}

const META_ID = 'registryTokenId'

interface RegistryMeta {
  _id: typeof META_ID
  tokenId: string
  createdAt: Date
}

interface Counter {
  _id: string
  seq: number
}

// Only identity rows carry an identityKey; the meta document must never count as a member.
const IDENTITY_ROWS = { identityKey: { $exists: true } }

export class RegistryStorage {
  private readonly rows: Collection<StoredRow>
  private readonly meta: Collection<RegistryMeta>
  private readonly counters: Collection<Counter>

  private readonly indexes = new CollectionIndexes('RegistryStorage', () => [
    {
      label: 'mandalaRegistry identityKey_1',
      collection: this.rows,
      keys: { identityKey: 1 },
      options: { unique: true }
    },
    { label: 'mandalaRegistry status_1', collection: this.rows, keys: { status: 1 } }
  ])

  constructor(db: Db) {
    this.rows = db.collection<StoredRow>('mandalaRegistry')
    this.meta = db.collection<RegistryMeta>('mandalaRegistry')
    this.counters = db.collection<Counter>('mandalaCounters')
  }

  /** The token id (`<txid>_0`) of the claimed registry, or null before the first deploy. */
  async registryTokenId(): Promise<string | null> {
    const meta = await this.meta.findOne({ _id: META_ID })
    return meta?.tokenId ?? null
  }

  /** First writer wins: true only to the call that created the claim. */
  async claimRegistryTokenId(tokenId: string): Promise<boolean> {
    const result = await this.meta.updateOne(
      { _id: META_ID },
      { $setOnInsert: { tokenId, createdAt: new Date() } },
      { upsert: true }
    )
    return result.upsertedCount === 1
  }

  /**
   * Folds one registry action into the identity's row. A row that already carries this very
   * outpoint is left as it is, so a replayed notification keeps its `admitSeq`.
   */
  async apply(identityKey: string, status: RegistryStatus, ref: RegistryRef): Promise<void> {
    await this.indexes.ensure()
    const current = await this.rows.findOne(
      { identityKey },
      { projection: { txid: 1, outputIndex: 1 } }
    )
    if (current?.txid === ref.txid && current.outputIndex === ref.outputIndex) return
    const admitSeq = await this.nextSeq()
    await this.rows.updateOne(
      { identityKey },
      {
        $set: { status, txid: ref.txid, outputIndex: ref.outputIndex, admitSeq },
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true }
    )
  }

  /** Whether the registry has any identity row: the membership gate is off until it does. */
  async isActive(): Promise<boolean> {
    await this.indexes.ensure()
    return (await this.rows.findOne(IDENTITY_ROWS, { projection: { _id: 1 } })) !== null
  }

  async isAdmitted(identityKey: string): Promise<boolean> {
    await this.indexes.ensure()
    const row = await this.rows.findOne(
      { identityKey, status: 'admitted' },
      { projection: { _id: 1 } }
    )
    return row !== null
  }

  /** Every identity row, newest action first. */
  async list(): Promise<RegistryRow[]> {
    await this.indexes.ensure()
    return await this.rows
      .find<RegistryRow>(IDENTITY_ROWS, {
        projection: { _id: 0, identityKey: 1, status: 1, txid: 1, outputIndex: 1, admitSeq: 1 }
      })
      .sort({ admitSeq: -1 })
      .toArray()
  }

  // Monotonic and persisted, so rows folded after a restart still sort above older ones.
  private async nextSeq(): Promise<number> {
    const counter = await this.counters.findOneAndUpdate(
      { _id: 'registryAdmitSeq' },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: 'after' }
    )
    return counter?.seq ?? 1
  }
}

/** The slice of the registry the Mandala membership gate (layer D) reads. */
export function registryMembership(storage: RegistryStorage): MembershipProvider {
  return {
    isActive: async () => await storage.isActive(),
    isAdmitted: async identityKey => await storage.isAdmitted(identityKey)
  }
}
