import { Collection, Db } from 'mongodb'
import { ProtoMapRegistration, ProtoMapRecord, UTXOReference } from './types.js'
import { WalletProtocol } from '@bsv/sdk'

export class ProtoMapStorageManager {
  private readonly records: Collection<ProtoMapRecord>

  constructor(private readonly db: Db) {
    this.records = db.collection<ProtoMapRecord>('protomapRecords')
  }

  async storeRecord(txid: string, outputIndex: number, registration: ProtoMapRegistration): Promise<void> {
    await this.records.insertOne({ txid, outputIndex, registration, createdAt: new Date() })
  }

  async deleteRecord(txid: string, outputIndex: number): Promise<void> {
    await this.records.deleteOne({ txid, outputIndex })
  }

  async findByName(name: string, registryOperators: string[]): Promise<UTXOReference[]> {
    return await this.findRecordWithQuery({
      'registration.registryOperator': { $in: registryOperators },
      'registration.name': name
    })
  }

  async findByProtocolID(protocolID: WalletProtocol, registryOperators: string[]): Promise<UTXOReference[]> {
    const [securityLevel, protocol] = protocolID
    return await this.findRecordWithQuery({
      'registration.protocolID.securityLevel': securityLevel,
      'registration.protocolID.protocol': protocol,
      'registration.registryOperator': { $in: registryOperators }
    })
  }

  private async findRecordWithQuery(query: object): Promise<UTXOReference[]> {
    const results = await this.records.find(query).project({ txid: 1, outputIndex: 1 }).toArray()
    return results.map(record => ({ txid: record.txid, outputIndex: record.outputIndex }))
  }
}
