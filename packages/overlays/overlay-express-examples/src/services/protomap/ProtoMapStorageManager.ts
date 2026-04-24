import { Collection, Db } from 'mongodb'
import { ProtoMapRegistration, ProtoMapRecord, UTXOReference } from './ProtoMapTypes.js'
import { WalletProtocol } from '@bsv/sdk'

/**
 * Implements a Lookup StorageManager for ProtoMap name registry
 * @public
 */
export class ProtoMapStorageManager {
  private readonly records: Collection<ProtoMapRecord>

  /**
   * Constructs a new ProtoMapStorageManager instance
   * @public
   * @param db - connected mongo database instance
   */
  constructor(private readonly db: Db) {
    this.records = db.collection<ProtoMapRecord>('protomapRecords')
  }

  /**
   * @public
   * @param txid
   * @param outputIndex
   * @param certificate
   */
  async storeRecord(txid: string, outputIndex: number, registration: ProtoMapRegistration): Promise<void> {
    // Insert new record
    await this.records.insertOne({
      txid,
      outputIndex,
      registration,
      createdAt: new Date()
    })
  }

  /**
   * Delete a matching ProtoMap record
   * @public
   * @param txid
   * @param outputIndex
   */
  async deleteRecord(txid: string, outputIndex: number): Promise<void> {
    await this.records.deleteOne({ txid, outputIndex })
  }

  // Custom ProtoMap Lookup Functions --------------------------------------------------------------

  /**
   * Find protocol registration by name
   * @public
   * @param name
   * @param registryOperator
   * @returns
   */
  async findByName(name: string, registryOperators: string[]): Promise<UTXOReference[]> {
    // Find matching results from the DB
    return await this.findRecordWithQuery({
      'registration.registryOperator': { $in: registryOperators },
      'registration.name': name
    })
  }

  /**
  * Find token by protocolID
  * @public
  * @param protocolID
  * @param registryOperators
  * @returns
  */
  async findByProtocolID(
    protocolID: WalletProtocol,
    registryOperators: string[]
  ): Promise<UTXOReference[]> {
    // Destructure the tuple to get the security level and protocol string.
    const [securityLevel, protocol] = protocolID

    // Query for matching documents.
    return await this.findRecordWithQuery({
      'registration.protocolID.securityLevel': securityLevel,
      'registration.protocolID.protocol': protocol,
      'registration.registryOperator': { $in: registryOperators }
    })
  }

  /**
   * Helper function for querying from the database
   * @param query
   * @returns
   */
  private async findRecordWithQuery(query: object): Promise<UTXOReference[]> {
    // Find matching results from the DB
    const results = await this.records.find(query).project({ txid: 1, outputIndex: 1 }).toArray()

    // Convert array of Documents to UTXOReferences
    const parsedResults: UTXOReference[] = results.map(record => ({
      txid: record.txid,
      outputIndex: record.outputIndex
    }))
    return parsedResults
  }
}
