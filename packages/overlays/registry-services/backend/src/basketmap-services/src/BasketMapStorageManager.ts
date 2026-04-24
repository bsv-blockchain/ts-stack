import { Collection, Db } from 'mongodb'
import { BasketMapRegistration, BasketMapRecord, UTXOReference } from './interfaces/BasketMapTypes.js'

/**
 * Implements a Lookup StorageManager for BasketMap name registry
 * @public
 */
export class BasketMapStorageManager {
  private readonly records: Collection<BasketMapRecord>

  /**
  * Constructs a new BasketMapStorageManager instance
  * @public
  * @param db - connected mongo database instance
  */
  constructor(private readonly db: Db) {
    this.records = db.collection<BasketMapRecord>('basketmapRecords')
  }

  /**
  * @public
  * @param txid
  * @param outputIndex
  * @param registration
  */
  async storeRecord(txid: string, outputIndex: number, registration: BasketMapRegistration): Promise<void> {
    // Insert new record
    await this.records.insertOne({
      txid,
      outputIndex,
      registration,
      createdAt: new Date()
    })
  }

  /**
  * Delete a matching BasketMap record
  * @public
  * @param txid
  * @param outputIndex
  */
  async deleteRecord(txid: string, outputIndex: number): Promise<void> {
    await this.records.deleteOne({ txid, outputIndex })
  }

  // Custom BasketMap Lookup Functions --------------------------------------------------------------

  /**
  * Find basket type registration by Id
  * @public
  * @param type
  * @param registryOperator
  * @returns
  */
  async findById(basketID: string, registryOperators: string[]): Promise<UTXOReference[]> {
    // Find matching results from the DB
    return await this.findRecordWithQuery({
      'registration.basketID': basketID,
      'registration.registryOperator': { $in: registryOperators }
    })
  }

  /**
  * Find basket type registration token by name
  * @public
  * @param {string} name - basket type name to search for
  * @param {string} registryOperator - operator of the basket registration
  * @returns
  */
  async findByName(name: string, registryOperators: string[]): Promise<UTXOReference[]> {
    // Construct a dynamic query for basket by name with fuzzy search support
    const query = {
      $and: [
        {
          'registration.name': this.getFuzzyRegex(name),
          'registration.registryOperator': { $in: registryOperators }
        }
      ]
    }

    // Find matching results from the DB
    return await this.findRecordWithQuery(query)
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
