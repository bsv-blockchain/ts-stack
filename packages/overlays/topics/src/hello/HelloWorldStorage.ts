import { Collection, Db } from 'mongodb'
import { CollectionIndexes } from '../shared/collectionIndexes.js'
import { HelloWorldRecord, UTXOReference } from './types.js'

export class HelloWorldStorage {
  private readonly records: Collection<HelloWorldRecord>

  private readonly indexes = new CollectionIndexes('HelloWorldStorage', () => [
    { label: 'MessageTextIndex', collection: this.records, keys: { message: 'text' }, options: { name: 'MessageTextIndex' } }
  ])

  constructor (private readonly db: Db) {
    this.records = db.collection<HelloWorldRecord>('helloWorldRecords')
  }

  private async ensureIndexes (): Promise<void> {
    return await this.indexes.ensure()
  }

  async storeRecord (txid: string, outputIndex: number, message: string): Promise<void> {
    await this.ensureIndexes()
    await this.records.updateOne(
      { txid, outputIndex },
      { $set: { message }, $setOnInsert: { txid, outputIndex, createdAt: new Date() } },
      { upsert: true }
    )
  }

  async deleteRecord (txid: string, outputIndex: number): Promise<void> {
    await this.ensureIndexes()
    await this.records.deleteOne({ txid, outputIndex })
  }

  async findByMessage (message: string, limit = 50, skip = 0, sortOrder: 'asc' | 'desc' = 'desc'): Promise<UTXOReference[]> {
    await this.ensureIndexes()
    if (!message) return []
    const direction = sortOrder === 'asc' ? 1 : -1
    return await this.records
      .find({ $text: { $search: message } }, { projection: { txid: 1, outputIndex: 1, createdAt: 1 } })
      .sort({ createdAt: direction })
      .skip(skip)
      .limit(limit)
      .toArray()
      .then(results => results.map(r => ({ txid: r.txid, outputIndex: r.outputIndex })))
  }

  async findAll (limit = 50, skip = 0, startDate?: Date, endDate?: Date, sortOrder: 'asc' | 'desc' = 'desc'): Promise<UTXOReference[]> {
    await this.ensureIndexes()
    const query: any = {}
    if (startDate || endDate) {
      query.createdAt = {}
      if (startDate) query.createdAt.$gte = startDate
      if (endDate) query.createdAt.$lte = endDate
    }
    const sortDirection = sortOrder === 'asc' ? 1 : -1
    return await this.records.find(query)
      .sort({ createdAt: sortDirection })
      .skip(skip)
      .limit(limit)
      .project<UTXOReference>({ txid: 1, outputIndex: 1 })
      .toArray()
  }
}
