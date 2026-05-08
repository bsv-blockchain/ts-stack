import { Collection, Db } from 'mongodb'
import { SupplyChainRecord, UTXOReference } from './types.js'

export class SupplyChainStorage {
  private readonly records: Collection<SupplyChainRecord>
  private indexInit?: Promise<void>

  constructor(private readonly db: Db) {
    this.records = db.collection<SupplyChainRecord>('supplyChainRecords')
  }

  private ensureIndexes(): Promise<void> {
    if (this.indexInit === undefined) {
      this.indexInit = (async () => {
        await this.records.createIndex({ 'offChainValues.chainId': 1 }, { name: 'offChainValuesIndex' })
      })()
    }
    return this.indexInit
  }

  async storeRecord(txid: string, outputIndex: number, offChainValues: Record<string, any>): Promise<void> {
    await this.ensureIndexes()
    await this.records.insertOne({ txid, outputIndex, offChainValues, createdAt: new Date() })
  }

  async deleteRecord(txid: string, outputIndex: number): Promise<void> {
    await this.ensureIndexes()
    await this.records.deleteOne({ txid, outputIndex })
  }

  async spendRecord(txid: string, outputIndex: number, spendingTxid: string): Promise<void> {
    await this.ensureIndexes()
    await this.records.updateOne({ txid, outputIndex }, { $set: { spendingTxid } })
  }

  async findByChainId(chainId: string, limit = 8, skip = 0): Promise<UTXOReference[]> {
    await this.ensureIndexes()
    if (!chainId) return []
    return this.records
      .find({ 'offChainValues.chainId': chainId }, { projection: { txid: 1, outputIndex: 1, createdAt: 1 } })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .project<UTXOReference>({ txid: 1, outputIndex: 1 })
      .toArray()
  }

  async findByTxid(txid: string, limit = 50, skip = 0, sortOrder: 'asc' | 'desc' = 'desc'): Promise<UTXOReference[]> {
    await this.ensureIndexes()
    if (!txid) return []
    const direction = sortOrder === 'asc' ? 1 : -1
    return this.records
      .find({ txid }, { projection: { txid: 1, outputIndex: 1, createdAt: 1 } })
      .sort({ createdAt: direction })
      .skip(skip)
      .limit(limit)
      .project<UTXOReference>({ txid: 1, outputIndex: 1 })
      .toArray()
  }

  async findAll(limit = 50, skip = 0, startDate?: Date, endDate?: Date, sortOrder: 'asc' | 'desc' = 'desc'): Promise<UTXOReference[]> {
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
