import { Collection, Db } from 'mongodb'
import { CollectionIndexes } from '../shared/collectionIndexes.js'
import { FractionalizeRecord, UTXOReference } from './types.js'

export class FractionalizeStorage {
  private readonly records: Collection<FractionalizeRecord>

  private readonly indexes = new CollectionIndexes('FractionalizeStorage', () => [
    { label: 'txidIndex', collection: this.records, keys: { txid: 1 }, options: { name: 'txidIndex' } }
  ])

  constructor (private readonly db: Db) {
    this.records = db.collection<FractionalizeRecord>('fractionalizeRecords')
  }

  private async ensureIndexes (): Promise<void> {
    return await this.indexes.ensure()
  }

  async storeRecord (txid: string, outputIndex: number): Promise<void> {
    await this.ensureIndexes()
    await this.records.updateOne(
      { txid, outputIndex },
      { $setOnInsert: { txid, outputIndex, createdAt: new Date() } },
      { upsert: true }
    )
  }

  async spendRecord (txid: string, outputIndex: number, spendingTxid: string): Promise<void> {
    await this.ensureIndexes()
    await this.records.updateOne({ txid, outputIndex }, { $set: { spendingTxid } })
  }

  async deleteRecord (txid: string, outputIndex: number): Promise<void> {
    await this.ensureIndexes()
    await this.records.deleteOne({ txid, outputIndex })
  }

  async findByTxid (txid: string): Promise<UTXOReference | null> {
    await this.ensureIndexes()
    if (!txid) return null
    return await this.records.findOne({ txid }, { projection: { txid: 1, outputIndex: 1 } })
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
