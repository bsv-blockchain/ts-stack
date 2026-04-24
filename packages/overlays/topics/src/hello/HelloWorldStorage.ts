import { Collection, Db } from 'mongodb'
import { HelloWorldRecord, UTXOReference } from './types.js'

export class HelloWorldStorage {
  private readonly records: Collection<HelloWorldRecord>

  constructor(private readonly db: Db) {
    this.records = db.collection<HelloWorldRecord>('helloWorldRecords')
    this.createSearchableIndex()
  }

  private async createSearchableIndex(): Promise<void> {
    await this.records.createIndex({ message: 'text' }, { name: 'MessageTextIndex' })
  }

  async storeRecord(txid: string, outputIndex: number, message: string): Promise<void> {
    await this.records.insertOne({ txid, outputIndex, message, createdAt: new Date() })
  }

  async deleteRecord(txid: string, outputIndex: number): Promise<void> {
    await this.records.deleteOne({ txid, outputIndex })
  }

  async findByMessage(message: string, limit = 50, skip = 0, sortOrder: 'asc' | 'desc' = 'desc'): Promise<UTXOReference[]> {
    if (!message) return []
    const direction = sortOrder === 'asc' ? 1 : -1
    return this.records
      .find({ $text: { $search: message } }, { projection: { txid: 1, outputIndex: 1, createdAt: 1 } })
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
  }
}
