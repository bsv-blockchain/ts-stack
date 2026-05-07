import { Collection, Db } from 'mongodb'
import { TokenDemoRecord, TokenDemoDetails, UTXOReference } from './types.js'

export class TokenDemoStorage {
  private readonly records: Collection<TokenDemoRecord>

  readonly ready: Promise<void>

  constructor(private readonly db: Db) {
    this.records = db.collection<TokenDemoRecord>('TokenDemoRecords')
    this.ready = this.createIndices()
  }

  private async createIndices(): Promise<void> {
    await Promise.all([
      this.records.createIndex({ txid: 1, outputIndex: 1 }, { name: 'OutpointIndex' }),
      this.records.createIndex({ tokenId: 'hashed' }, { name: 'TokenIdTextIndex' })
    ])
  }

  async storeRecord(txid: string, outputIndex: number, details: TokenDemoDetails): Promise<void> {
    await this.records.insertOne({ txid, outputIndex, ...details, createdAt: new Date() })
  }

  async deleteRecord(txid: string, outputIndex: number): Promise<void> {
    await this.records.deleteOne({ txid, outputIndex })
  }

  async findByOutpoint(outpoint: string): Promise<UTXOReference[]> {
    const [txid, outputIndex] = outpoint.split('.')
    return this.records
      .find({ txid, outputIndex: Number(outputIndex) }, { projection: { txid: 1, outputIndex: 1 } })
      .toArray()
      .then(results => results.map(r => ({ txid: r.txid, outputIndex: r.outputIndex })))
  }

  async findByTokenId(tokenId: string, limit = 50, skip = 0, sortOrder: 'asc' | 'desc' = 'desc'): Promise<UTXOReference[]> {
    if (!tokenId) return []
    const direction = sortOrder === 'asc' ? 1 : -1
    return this.records
      .find({ tokenId }, { projection: { txid: 1, outputIndex: 1, createdAt: 1 } })
      .sort({ createdAt: direction })
      .skip(skip)
      .limit(limit)
      .toArray()
      .then(results => results.map(r => ({ txid: r.txid, outputIndex: r.outputIndex })))
  }

  async findAll(limit = 50, skip = 0, sortOrder: 'asc' | 'desc' = 'desc'): Promise<UTXOReference[]> {
    const direction = sortOrder === 'asc' ? 1 : -1
    return this.records
      .find({}, { projection: { txid: 1, outputIndex: 1, createdAt: 1 } })
      .sort({ createdAt: direction })
      .skip(skip)
      .limit(limit)
      .toArray()
      .then(results => results.map(r => ({ txid: r.txid, outputIndex: r.outputIndex })))
  }
}
