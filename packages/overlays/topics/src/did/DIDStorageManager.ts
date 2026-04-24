import { Collection, Db } from 'mongodb'
import { DIDRecord } from './types.js'
import { Base64String } from '@bsv/sdk'
import { LookupFormula } from '@bsv/overlay'

export class DIDStorageManager {
  private readonly records: Collection<DIDRecord>

  constructor(private readonly db: Db) {
    this.records = db.collection<DIDRecord>('didRecords')
    this.records.createIndex({ searchableAttributes: 'text' }).catch((e) => console.error(e))
  }

  async storeRecord(txid: string, outputIndex: number, serialNumber: Base64String): Promise<void> {
    await this.records.insertOne({ txid, outputIndex, serialNumber, createdAt: new Date() })
  }

  async deleteRecord(txid: string, outputIndex: number): Promise<void> {
    await this.records.deleteOne({ txid, outputIndex })
  }

  async findByCertificateSerialNumber(serialNumber: Base64String): Promise<LookupFormula> {
    return await this.findRecordWithQuery({ serialNumber })
  }

  async findByOutpoint(outpoint: string): Promise<LookupFormula> {
    const [txid, outputIndexStr] = outpoint.split('.')
    const outputIndex = parseInt(outputIndexStr, 10)
    if (!txid || isNaN(outputIndex)) {
      throw new Error('Invalid outpoint format. Expected "txid.outputIndex"')
    }
    return await this.findRecordWithQuery({ txid, outputIndex })
  }

  private async findRecordWithQuery(query: object): Promise<LookupFormula> {
    const results = await this.records.find(query).project({ txid: 1, outputIndex: 1 }).toArray()
    return results.map((record: any) => ({ txid: record.txid, outputIndex: record.outputIndex }))
  }
}
