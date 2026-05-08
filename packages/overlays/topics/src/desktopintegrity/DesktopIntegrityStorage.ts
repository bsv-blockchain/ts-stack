import { Collection, Db } from 'mongodb'
import { DesktopIntegrityRecord, UTXOReference } from './types.js'

export class DesktopIntegrityStorage {
  private readonly records: Collection<DesktopIntegrityRecord>
  private indexInit?: Promise<void>

  constructor(private readonly db: Db) {
    this.records = db.collection<DesktopIntegrityRecord>('desktopIntegrityRecords')
  }

  private ensureIndexes(): Promise<void> {
    if (this.indexInit === undefined) {
      this.indexInit = (async () => {
        await this.records.createIndex({ fileHash: 1 }, { name: 'fileHashIndex' })
      })()
    }
    return this.indexInit
  }

  async storeRecord(txid: string, outputIndex: number, fileHash: string): Promise<void> {
    await this.ensureIndexes()
    await this.records.insertOne({ txid, outputIndex, fileHash, createdAt: new Date() })
  }

  async deleteRecord(txid: string, outputIndex: number): Promise<void> {
    await this.ensureIndexes()
    await this.records.deleteOne({ txid, outputIndex })
  }

  async findByFileHash(fileHash: string, limit = 50, skip = 0, sortOrder: 'asc' | 'desc' = 'desc'): Promise<UTXOReference[]> {
    await this.ensureIndexes()
    if (!fileHash) return []
    const direction = sortOrder === 'asc' ? 1 : -1
    const results = await this.records.find({ fileHash })
      .sort({ createdAt: direction })
      .skip(skip)
      .limit(limit)
      .project<{ txid: string; outputIndex: number }>({ txid: 1, outputIndex: 1 })
      .toArray()
    return results.map(r => ({ txid: r.txid, outputIndex: r.outputIndex }))
  }

  async findByTxid(txid: string, limit = 50, skip = 0, sortOrder: 'asc' | 'desc' = 'desc'): Promise<UTXOReference[]> {
    await this.ensureIndexes()
    if (!txid) return []
    const direction = sortOrder === 'asc' ? 1 : -1
    const results = await this.records.find({ txid })
      .sort({ createdAt: direction })
      .skip(skip)
      .limit(limit)
      .project<{ txid: string; outputIndex: number }>({ txid: 1, outputIndex: 1 })
      .toArray()
    return results.map(r => ({ txid: r.txid, outputIndex: r.outputIndex }))
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
    const results = await this.records.find(query)
      .sort({ createdAt: sortDirection })
      .skip(skip)
      .limit(limit)
      .project<{ txid: string; outputIndex: number }>({ txid: 1, outputIndex: 1 })
      .toArray()
    return results.map(r => ({ txid: r.txid, outputIndex: r.outputIndex }))
  }
}
