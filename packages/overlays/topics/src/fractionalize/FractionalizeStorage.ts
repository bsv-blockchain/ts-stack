import { Collection, Db } from 'mongodb'
import { FractionalizeRecord, UTXOReference } from './types.js'

export class FractionalizeStorage {
  private readonly records: Collection<FractionalizeRecord>

  readonly ready: Promise<void>

  constructor(private readonly db: Db) {
    this.records = db.collection<FractionalizeRecord>('fractionalizeRecords')
    this.ready = this.createSearchableIndex()
  }

  private async createSearchableIndex(): Promise<void> {
    await this.records.createIndex({ txid: 1 }, { name: 'txidIndex' })
  }

  async storeRecord(txid: string, outputIndex: number): Promise<void> {
    await this.records.insertOne({ txid, outputIndex, createdAt: new Date() })
  }

  async spendRecord(txid: string, outputIndex: number, spendingTxid: string): Promise<void> {
    await this.records.updateOne({ txid, outputIndex }, { $set: { spendingTxid } })
  }

  async deleteRecord(txid: string, outputIndex: number): Promise<void> {
    await this.records.deleteOne({ txid, outputIndex })
  }

  async findByTxid(txid: string): Promise<UTXOReference | null> {
    if (!txid) return null
    return this.records.findOne({ txid }, { projection: { txid: 1, outputIndex: 1 } })
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
  }
}
