import { Collection, Db } from 'mongodb'
import { CollectionIndexes } from '../shared/collectionIndexes.js'
import { DesktopIntegrityRecord, UTXOReference } from './types.js'

export class DesktopIntegrityStorage {
  private readonly records: Collection<DesktopIntegrityRecord>

  private readonly indexes = new CollectionIndexes('DesktopIntegrityStorage', () => [
    { label: 'fileHashIndex', collection: this.records, keys: { fileHash: 1 }, options: { name: 'fileHashIndex' } }
  ])

  constructor (private readonly db: Db) {
    this.records = db.collection<DesktopIntegrityRecord>('desktopIntegrityRecords')
  }

  private async ensureIndexes (): Promise<void> {
    return await this.indexes.ensure()
  }

  async storeRecord (txid: string, outputIndex: number, fileHash: string): Promise<void> {
    await this.ensureIndexes()
    await this.records.updateOne(
      { txid, outputIndex },
      { $set: { fileHash }, $setOnInsert: { txid, outputIndex, createdAt: new Date() } },
      { upsert: true }
    )
  }

  async deleteRecord (txid: string, outputIndex: number): Promise<void> {
    await this.ensureIndexes()
    await this.records.deleteOne({ txid, outputIndex })
  }

  async findByFileHash (fileHash: string, limit = 50, skip = 0, sortOrder: 'asc' | 'desc' = 'desc'): Promise<UTXOReference[]> {
    await this.ensureIndexes()
    if (!fileHash) return []
    const direction = sortOrder === 'asc' ? 1 : -1
    const results = await this.records.find({ fileHash })
      .sort({ createdAt: direction })
      .skip(skip)
      .limit(limit)
      .project<{ txid: string, outputIndex: number }>({ txid: 1, outputIndex: 1 })
      .toArray()
    return results.map(r => ({ txid: r.txid, outputIndex: r.outputIndex }))
  }

  async findByTxid (txid: string, limit = 50, skip = 0, sortOrder: 'asc' | 'desc' = 'desc'): Promise<UTXOReference[]> {
    await this.ensureIndexes()
    if (!txid) return []
    const direction = sortOrder === 'asc' ? 1 : -1
    const results = await this.records.find({ txid })
      .sort({ createdAt: direction })
      .skip(skip)
      .limit(limit)
      .project<{ txid: string, outputIndex: number }>({ txid: 1, outputIndex: 1 })
      .toArray()
    return results.map(r => ({ txid: r.txid, outputIndex: r.outputIndex }))
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
    const results = await this.records.find(query)
      .sort({ createdAt: sortDirection })
      .skip(skip)
      .limit(limit)
      .project<{ txid: string, outputIndex: number }>({ txid: 1, outputIndex: 1 })
      .toArray()
    return results.map(r => ({ txid: r.txid, outputIndex: r.outputIndex }))
  }
}
