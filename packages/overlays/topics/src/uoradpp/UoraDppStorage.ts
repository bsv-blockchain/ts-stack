import { Collection, Db, Filter } from 'mongodb'
import { CollectionIndexes } from '../shared/collectionIndexes.js'
import { UoraDppQuery, UoraDppRecord } from './types.js'
import { UTXOReference } from '../any/types.js'

/** Answers stay bounded whatever a caller asks for. */
export const MAX_UORA_RESULTS = 500

const SELECTABLE = [
  'issuer',
  'issuerKey',
  'subject',
  'attestationId',
  'digest',
  'anchoredBy',
  'uoraType'
] as const

export class UoraDppStorage {
  private readonly records: Collection<UoraDppRecord>

  private readonly indexes = new CollectionIndexes('UoraDppStorage', () => [
    { label: 'issuerIndex', collection: this.records, keys: { issuer: 1, createdAt: 1 }, options: { name: 'issuerIndex' } },
    // `issuerKey` selects on its own, so it needs its own index. Without one
    // every lookup by identity key was a collection scan and a sort.
    { label: 'issuerKeyIndex', collection: this.records, keys: { issuerKey: 1, createdAt: 1 }, options: { name: 'issuerKeyIndex' } },
    { label: 'subjectIndex', collection: this.records, keys: { subject: 1, createdAt: 1 }, options: { name: 'subjectIndex' } },
    { label: 'attestationIdIndex', collection: this.records, keys: { attestationId: 1 }, options: { name: 'attestationIdIndex' } },
    { label: 'digestIndex', collection: this.records, keys: { digest: 1 }, options: { name: 'digestIndex' } },
    { label: 'anchoredByIndex', collection: this.records, keys: { anchoredBy: 1, createdAt: 1 }, options: { name: 'anchoredByIndex' } },
    { label: 'outpointIndex', collection: this.records, keys: { txid: 1, outputIndex: 1 }, options: { name: 'outpointIndex', unique: true } }
  ])

  constructor(private readonly db: Db) {
    this.records = db.collection<UoraDppRecord>('uoraDppAnchors')
  }

  private async ensureIndexes(): Promise<void> {
    return await this.indexes.ensure()
  }

  /**
   * Upsert rather than insert. An overlay may be handed the same transaction
   * twice, and an anchor is immutable, so the second arrival is the same fact
   * rather than a second one.
   */
  async storeRecord(record: Omit<UoraDppRecord, 'createdAt'>): Promise<void> {
    await this.ensureIndexes()
    await this.records.updateOne(
      { txid: record.txid, outputIndex: record.outputIndex },
      { $set: { ...record, createdAt: new Date() } },
      { upsert: true }
    )
  }

  async deleteRecord(txid: string, outputIndex: number): Promise<void> {
    await this.ensureIndexes()
    await this.records.deleteOne({ txid, outputIndex })
  }

  /**
   * Exact matches only, and at least one selector is required by the lookup
   * service before this is called.
   */
  async find(query: UoraDppQuery): Promise<UTXOReference[]> {
    await this.ensureIndexes()
    const filter: Record<string, string> = {}
    for (const key of SELECTABLE) {
      const value = query[key]
      if (typeof value === 'string' && value !== '') filter[key] = value
    }
    const limit = bounded(query.limit)
    const skip = query.skip !== undefined && query.skip > 0 ? Math.floor(query.skip) : 0
    return await this.records
      .find(filter as Filter<UoraDppRecord>)
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .project<UTXOReference>({ txid: 1, outputIndex: 1 })
      .toArray()
  }
}

function bounded(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return MAX_UORA_RESULTS
  return Math.min(Math.floor(limit), MAX_UORA_RESULTS)
}
