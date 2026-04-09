import { Collection, Db } from 'mongodb'
import { WalletConfigRegistration, WalletConfigRecord, UTXOReference } from './WalletConfigTypes.js'

/**
 * Implements a Lookup StorageManager for WalletConfig registry
 * @public
 */
export class WalletConfigStorageManager {
  private readonly records: Collection<WalletConfigRecord>

  /**
  * Constructs a new WalletConfigStorageManager instance
  * @public
  * @param db - connected mongo database instance
  */
  constructor(private readonly db: Db) {
    this.records = db.collection<WalletConfigRecord>('walletConfigRecords')
  }

  /**
  * Store a wallet configuration record. Prevents duplicate entries with same fields.
  * @public
  * @param txid
  * @param outputIndex
  * @param registration
  */
  async storeRecord(txid: string, outputIndex: number, registration: WalletConfigRegistration): Promise<void> {
    // Check if a record with the same field values already exists (excluding txid/outputIndex)
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

    // Only insert if no duplicate exists
    if (!existingRecord) {
      await this.records.insertOne({
        txid,
        outputIndex,
        registration,
        createdAt: new Date()
      })
    }
  }

  /**
  * Delete a matching WalletConfig record
  * @public
  * @param txid
  * @param outputIndex
  */
  async deleteRecord(txid: string, outputIndex: number): Promise<void> {
    await this.records.deleteOne({ txid, outputIndex })
  }

  // Custom WalletConfig Lookup Functions --------------------------------------------------------------

  /**
  * Find wallet config by configID
  * @public
  * @param configID
  * @param registryOperators
  * @returns
  */
  async findByConfigId(configID: string, registryOperators: string[]): Promise<UTXOReference[]> {
    return await this.findRecordWithQuery({
      'registration.configID': configID,
      'registration.registryOperator': { $in: registryOperators }
    })
  }

  /**
  * Find wallet config by name
  * @public
  * @param name - config name to search for
  * @param registryOperators - operators of the config registration
  * @returns
  */
  async findByName(name: string, registryOperators: string[]): Promise<UTXOReference[]> {
    const query = {
      'registration.name': this.getFuzzyRegex(name),
      'registration.registryOperator': { $in: registryOperators }
    }
    return await this.findRecordWithQuery(query)
  }

  /**
  * Find wallet config by WAB URL
  * @public
  * @param wab - Wallet Authentication Backend URL
  * @param registryOperators
  * @returns
  */
  async findByWab(wab: string, registryOperators: string[]): Promise<UTXOReference[]> {
    return await this.findRecordWithQuery({
      'registration.wab': wab,
      'registration.registryOperator': { $in: registryOperators }
    })
  }

  /**
  * Find wallet config by storage URL
  * @public
  * @param storage - Wallet storage URL
  * @param registryOperators
  * @returns
  */
  async findByStorage(storage: string, registryOperators: string[]): Promise<UTXOReference[]> {
    return await this.findRecordWithQuery({
      'registration.storage': storage,
      'registration.registryOperator': { $in: registryOperators }
    })
  }

  /**
  * Find wallet config by messagebox URL
  * @public
  * @param messagebox - Messagebox URL
  * @param registryOperators
  * @returns
  */
  async findByMessagebox(messagebox: string, registryOperators: string[]): Promise<UTXOReference[]> {
    return await this.findRecordWithQuery({
      'registration.messagebox': messagebox,
      'registration.registryOperator': { $in: registryOperators }
    })
  }

  /**
  * List all wallet configs from specified registry operators
  * @public
  * @param registryOperators
  * @returns
  */
  async listAll(registryOperators: string[]): Promise<UTXOReference[]> {
    return await this.findRecordWithQuery({
      'registration.registryOperator': { $in: registryOperators }
    })
  }

  /**
   * Convert a string into a regex pattern for fuzzy search
   * @param {string} input - field to search for
   * @returns
   */
  private getFuzzyRegex(input: string): RegExp {
    const escapedInput = input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(escapedInput.split('').join('.*'), 'i')
  }

  /**
   * Helper function for querying from the database
   * @param {object} query - search object
   * @returns {Promise<UTXOReference[]>} - search results
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
