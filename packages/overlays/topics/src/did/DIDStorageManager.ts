import { Collection, Db } from 'mongodb'
import { CollectionIndexes } from '../shared/collectionIndexes.js'
import { DIDRecord } from './types.js'
import { Base64String } from '@bsv/sdk'
import { LookupFormula } from '@bsv/overlay'

export class DIDStorageManager {
  private readonly records: Collection<DIDRecord>

  private readonly indexes = new CollectionIndexes('DIDStorageManager', () => [
    { label: 'searchableAttributes_text', collection: this.records, keys: { searchableAttributes: 'text' } }
  ])

  constructor (private readonly db: Db) {
    this.records = db.collection<DIDRecord>('didRecords')
  }

  private async ensureIndexes (): Promise<void> {
    return await this.indexes.ensure()
  }

  async storeRecord (txid: string, outputIndex: number, serialNumber: Base64String): Promise<void> {
    await this.ensureIndexes()
    await this.records.updateOne(
      { txid, outputIndex },
      { $set: { serialNumber }, $setOnInsert: { txid, outputIndex, createdAt: new Date() } },
      { upsert: true }
    )
  }

  async deleteRecord (txid: string, outputIndex: number): Promise<void> {
    await this.ensureIndexes()
    await this.records.deleteOne({ txid, outputIndex })
  }

  async findByCertificateSerialNumber (serialNumber: Base64String): Promise<LookupFormula> {
    await this.ensureIndexes()
    return await this.findRecordWithQuery({ serialNumber })
  }

  async findByOutpoint (outpoint: string): Promise<LookupFormula> {
    await this.ensureIndexes()
    const [txid, outputIndexStr] = outpoint.split('.')
    const outputIndex = Number.parseInt(outputIndexStr, 10)
    if (!txid || Number.isNaN(outputIndex)) {
      throw new Error('Invalid outpoint format. Expected "txid.outputIndex"')
    }
    return await this.findRecordWithQuery({ txid, outputIndex })
  }

  private async findRecordWithQuery (query: object): Promise<LookupFormula> {
    const results = await this.records.find(query).project({ txid: 1, outputIndex: 1 }).toArray()
    return results.map((record: any) => ({ txid: record.txid, outputIndex: record.outputIndex }))
  }
}
