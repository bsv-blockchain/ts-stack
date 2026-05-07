import { Collection, Db } from 'mongodb'
import { WalletConfigRegistration, WalletConfigRecord, UTXOReference } from './WalletConfigTypes.js'

export class WalletConfigStorageManager {
  private readonly records: Collection<WalletConfigRecord>

  constructor(private readonly db: Db) {
    this.records = db.collection<WalletConfigRecord>('walletConfigRecords')
  }

  async storeRecord(txid: string, outputIndex: number, registration: WalletConfigRegistration): Promise<void> {
    const existingRecord = await this.records.findOne({
      'registration.configID': registration.configID,
      'registration.name': registration.name,
      'registration.icon': registration.icon,
      'registration.wab': registration.wab,
      'registration.storage': registration.storage,
      'registration.messagebox': registration.messagebox,
      'registration.legal': registration.legal,
      'registration.registryOperator': registration.registryOperator
    })
    if (!existingRecord) {
      await this.records.insertOne({ txid, outputIndex, registration, createdAt: new Date() })
    }
  }

  async deleteRecord(txid: string, outputIndex: number): Promise<void> {
    await this.records.deleteOne({ txid, outputIndex })
  }

  async findByConfigId(configID: string, registryOperators: string[]): Promise<UTXOReference[]> {
    return await this.findRecordWithQuery({ 'registration.configID': configID, 'registration.registryOperator': { $in: registryOperators } })
  }

  async findByName(name: string, registryOperators: string[]): Promise<UTXOReference[]> {
    return await this.findRecordWithQuery({ 'registration.name': this.getFuzzyRegex(name), 'registration.registryOperator': { $in: registryOperators } })
  }

  async findByWab(wab: string, registryOperators: string[]): Promise<UTXOReference[]> {
    return await this.findRecordWithQuery({ 'registration.wab': wab, 'registration.registryOperator': { $in: registryOperators } })
  }

  async findByStorage(storage: string, registryOperators: string[]): Promise<UTXOReference[]> {
    return await this.findRecordWithQuery({ 'registration.storage': storage, 'registration.registryOperator': { $in: registryOperators } })
  }

  async findByMessagebox(messagebox: string, registryOperators: string[]): Promise<UTXOReference[]> {
    return await this.findRecordWithQuery({ 'registration.messagebox': messagebox, 'registration.registryOperator': { $in: registryOperators } })
  }

  async listAll(registryOperators: string[]): Promise<UTXOReference[]> {
    return await this.findRecordWithQuery({ 'registration.registryOperator': { $in: registryOperators } })
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
