import { Collection, Db } from 'mongodb'
import { AnyRecord, UTXOReference } from './types.js'

// Implements a Lookup StorageEngine for Any
export class AnyStorage {
  private readonly records: Collection<AnyRecord>
  private indexInit?: Promise<void>

  constructor(private readonly db: Db) {
    this.records = db.collection<AnyRecord>('anyRecords')
  }

  private ensureIndexes(): Promise<void> {
    if (this.indexInit === undefined) {
      this.indexInit = (async () => {
        await this.records.createIndex({ txid: 1 }, { name: 'txidIndex' })
      })()
    }
    return this.indexInit
  }

  async storeRecord(txid: string, outputIndex: number): Promise<void> {
    await this.ensureIndexes()
    await this.records.insertOne({
      txid,
      outputIndex,
      createdAt: new Date()
    })
  }

  async spendRecord(txid: string, outputIndex: number, spendingTxid: string): Promise<void> {
    await this.ensureIndexes()
    await this.records.updateOne({ txid, outputIndex }, { $set: { spendingTxid } })
  }

  async deleteRecord(txid: string, outputIndex: number): Promise<void> {
    await this.ensureIndexes()
    await this.records.deleteOne({ txid, outputIndex })
  }

  async findByTxid(txid: string): Promise<UTXOReference | null> {
    await this.ensureIndexes()
    if (!txid) return null
    return this.records.findOne(
      { txid },
      { projection: { txid: 1, outputIndex: 1 } }
    )
  }

  async findAll(
    limit = 50,
    skip = 0,
    startDate?: Date,
    endDate?: Date,
    sortOrder: 'asc' | 'desc' = 'desc'
  ): Promise<UTXOReference[]> {
    await this.ensureIndexes()
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
