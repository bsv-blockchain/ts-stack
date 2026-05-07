import { Collection, Db } from 'mongodb'
import { CertMapRegistration, CertMapRecord, UTXOReference } from './types.js'

export class CertMapStorageManager {
  private readonly records: Collection<CertMapRecord>

  constructor(private readonly db: Db) {
    this.records = db.collection<CertMapRecord>('certmapRecords')
  }

  async storeRecord(txid: string, outputIndex: number, registration: CertMapRegistration): Promise<void> {
    await this.records.insertOne({ txid, outputIndex, registration, createdAt: new Date() })
  }

  async deleteRecord(txid: string, outputIndex: number): Promise<void> {
    await this.records.deleteOne({ txid, outputIndex })
  }

  async findByType(type: string, registryOperators: string[]): Promise<UTXOReference[]> {
    return await this.findRecordWithQuery({
      'registration.type': type,
      'registration.registryOperator': { $in: registryOperators }
    })
  }

  async findByName(name: string, registryOperators: string[]): Promise<UTXOReference[]> {
    const query = {
      $and: [{
        'registration.registryOperator': { $in: registryOperators },
        'registration.name': this.getFuzzyRegex(name)
      }]
    }
    return await this.findRecordWithQuery(query)
  }

  private getFuzzyRegex(input: string): RegExp {
    const escapedInput = input.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
    return new RegExp(escapedInput.split('').join('.*'), 'i')
  }

  private async findRecordWithQuery(query: object): Promise<UTXOReference[]> {
    const results = await this.records.find(query).project({ txid: 1, outputIndex: 1 }).toArray()
    return results.map(record => ({ txid: record.txid, outputIndex: record.outputIndex }))
  }
}
