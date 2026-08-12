import { Collection, Db } from 'mongodb'
import { CollectionIndexes } from '../shared/collectionIndexes.js'
import { TokenDemoRecord, TokenDemoDetails, UTXOReference } from './types.js'

export class TokenDemoStorage {
  private readonly records: Collection<TokenDemoRecord>

  private readonly indexes = new CollectionIndexes('TokenDemoStorage', () => [
    { label: 'OutpointIndex', collection: this.records, keys: { txid: 1, outputIndex: 1 }, options: { name: 'OutpointIndex' } },
    { label: 'TokenIdTextIndex', collection: this.records, keys: { tokenId: 'hashed' }, options: { name: 'TokenIdTextIndex' } }
  ])

  constructor (private readonly db: Db) {
    this.records = db.collection<TokenDemoRecord>('TokenDemoRecords')
  }

  private async ensureIndexes (): Promise<void> {
    return await this.indexes.ensure()
  }

  async storeRecord (txid: string, outputIndex: number, details: TokenDemoDetails): Promise<void> {
    await this.ensureIndexes()
    await this.records.updateOne(
      { txid, outputIndex },
      { $set: { ...details }, $setOnInsert: { txid, outputIndex, createdAt: new Date() } },
      { upsert: true }
    )
  }

  async deleteRecord (txid: string, outputIndex: number): Promise<void> {
    await this.ensureIndexes()
    await this.records.deleteOne({ txid, outputIndex })
  }

  async findByOutpoint (outpoint: string): Promise<UTXOReference[]> {
    await this.ensureIndexes()
    const [txid, outputIndex] = outpoint.split('.')
    return await this.records
      .find({ txid, outputIndex: Number(outputIndex) }, { projection: { txid: 1, outputIndex: 1 } })
      .toArray()
      .then(results => results.map(r => ({ txid: r.txid, outputIndex: r.outputIndex })))
  }

  async findByTokenId (tokenId: string, limit = 50, skip = 0, sortOrder: 'asc' | 'desc' = 'desc'): Promise<UTXOReference[]> {
    await this.ensureIndexes()
    if (!tokenId) return []
    const direction = sortOrder === 'asc' ? 1 : -1
    return await this.records
      .find({ tokenId }, { projection: { txid: 1, outputIndex: 1, createdAt: 1 } })
      .sort({ createdAt: direction })
      .skip(skip)
      .limit(limit)
      .toArray()
      .then(results => results.map(r => ({ txid: r.txid, outputIndex: r.outputIndex })))
  }

  async findAll (limit = 50, skip = 0, sortOrder: 'asc' | 'desc' = 'desc'): Promise<UTXOReference[]> {
    await this.ensureIndexes()
    const direction = sortOrder === 'asc' ? 1 : -1
    return await this.records
      .find({}, { projection: { txid: 1, outputIndex: 1, createdAt: 1 } })
      .sort({ createdAt: direction })
      .skip(skip)
      .limit(limit)
      .toArray()
      .then(results => results.map(r => ({ txid: r.txid, outputIndex: r.outputIndex })))
  }
}
