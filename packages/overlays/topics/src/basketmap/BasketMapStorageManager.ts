import { Collection, Db } from 'mongodb'
import { BasketMapRegistration, BasketMapRecord, UTXOReference } from './types.js'

export class BasketMapStorageManager {
  private readonly records: Collection<BasketMapRecord>

  constructor(private readonly db: Db) {
    this.records = db.collection<BasketMapRecord>('basketmapRecords')
  }

  async storeRecord(txid: string, outputIndex: number, registration: BasketMapRegistration): Promise<void> {
    await this.records.insertOne({ txid, outputIndex, registration, createdAt: new Date() })
  }

  async deleteRecord(txid: string, outputIndex: number): Promise<void> {
    await this.records.deleteOne({ txid, outputIndex })
  }

  async findById(basketID: string, registryOperators: string[]): Promise<UTXOReference[]> {
    return await this.findRecordWithQuery({
      'registration.basketID': basketID,
      'registration.registryOperator': { $in: registryOperators }
    })
  }

  async findByName(name: string, registryOperators: string[]): Promise<UTXOReference[]> {
    const query = {
      $and: [{
        'registration.name': this.getFuzzyRegex(name),
        'registration.registryOperator': { $in: registryOperators }
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
