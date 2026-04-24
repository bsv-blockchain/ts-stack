import { Collection, Db } from 'mongodb'
import { SlackThreadRecord, UTXOReference } from './types.js'

export class SlackThreadsStorage {
  private readonly records: Collection<SlackThreadRecord>

  constructor(private readonly db: Db) {
    this.records = db.collection<SlackThreadRecord>('slackThreadRecords')
    this.createSearchableIndex()
  }

  private async createSearchableIndex(): Promise<void> {
    await this.records.createIndex({ threadHash: 1 }, { name: 'threadHashIndex' })
  }

  async storeRecord(txid: string, outputIndex: number, threadHash: string): Promise<void> {
    await this.records.insertOne({ txid, outputIndex, threadHash, createdAt: new Date() })
  }

  async deleteRecord(txid: string, outputIndex: number): Promise<void> {
    await this.records.deleteOne({ txid, outputIndex })
  }

  async findByThreadHash(threadHash: string, limit = 50, skip = 0, sortOrder: 'asc' | 'desc' = 'desc'): Promise<UTXOReference[]> {
    if (!threadHash) return []
    const direction = sortOrder === 'asc' ? 1 : -1
    return this.records
      .find({ threadHash }, { projection: { txid: 1, outputIndex: 1, createdAt: 1 } })
      .sort({ createdAt: direction })
      .skip(skip)
      .limit(limit)
      .toArray()
      .then(results => results.map(r => ({ txid: r.txid, outputIndex: r.outputIndex })))
  }

  async findByTxid(txid: string, limit = 50, skip = 0, sortOrder: 'asc' | 'desc' = 'desc'): Promise<UTXOReference[]> {
    if (!txid) return []
    const direction = sortOrder === 'asc' ? 1 : -1
    return this.records
      .find({ txid }, { projection: { txid: 1, outputIndex: 1, createdAt: 1 } })
      .sort({ createdAt: direction })
      .skip(skip)
      .limit(limit)
      .toArray()
      .then(results => results.map(r => ({ txid: r.txid, outputIndex: r.outputIndex })))
  }

  async findAll(limit = 50, skip = 0, startDate?: Date, endDate?: Date, sortOrder: 'asc' | 'desc' = 'desc'): Promise<UTXOReference[]> {
    const query: any = {}
    if (startDate || endDate) {
      query.createdAt = {}
      if (startDate) query.createdAt.$gte = startDate
      if (endDate) query.createdAt.$lte = endDate
    }
    const sortDirection = sortOrder === 'asc' ? 1 : -1
    return this.records.find(query)
      .sort({ createdAt: sortDirection })
      .skip(skip)
      .limit(limit)
      .project<UTXOReference>({ txid: 1, outputIndex: 1 })
      .toArray()
      .then(results => results.map(record => ({ txid: record.txid, outputIndex: record.outputIndex })))
  }
}
