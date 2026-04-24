import { Collection, Db } from 'mongodb'
import { CertMapRegistration, CertMapRecord, UTXOReference } from './interfaces/CertMapTypes.js'

/**
 * Implements a Lookup StorageManager for CertMap name registry
 * @public
 */
export class CertMapStorageManager {
  private readonly records: Collection<CertMapRecord>

  /**
  * Constructs a new CertMapStorageManager instance
  * @public
  * @param db - connected mongo database instance
  */
  constructor(private readonly db: Db) {
    this.records = db.collection<CertMapRecord>('certmapRecords')
  }

  /**
  * @public
  * @param txid
  * @param outputIndex
  * @param certificate
  */
  async storeRecord(txid: string, outputIndex: number, registration: CertMapRegistration): Promise<void> {
    // Insert new record
    await this.records.insertOne({
      txid,
      outputIndex,
      registration,
      createdAt: new Date()
    })
  }

  /**
  * Delete a matching CertMap record
  * @public
  * @param txid
  * @param outputIndex
  */
  async deleteRecord(txid: string, outputIndex: number): Promise<void> {
    await this.records.deleteOne({ txid, outputIndex })
  }

  // Custom CertMap Lookup Functions --------------------------------------------------------------

  /**
  * Find certificate type registration by type
  * @public
  * @param type
  * @param registryOperator
  * @returns
  */
  async findByType(type: string, registryOperators: string[]): Promise<UTXOReference[]> {
    // Find matching results from the DB
    return await this.findRecordWithQuery({
      'registration.type': type,
      'registration.registryOperator': { $in: registryOperators }
    })
  }

  /**
  * Find certificate type registration token by name
  * @public
  * @param {string} name - certificate type name to search for
  * @param {string} registryOperator - operator of the certificate registration
  * @returns
  */
  async findByName(name: string, registryOperators: string[]): Promise<UTXOReference[]> {
    // Construct a dynamic query for certificate by name with fuzzy search support
    const query = {
      $and: [
        {
          'registration.registryOperator': { $in: registryOperators },
          'registration.name': this.getFuzzyRegex(name)
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
