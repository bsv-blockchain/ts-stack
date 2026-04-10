import { Collection, Db } from 'mongodb'
import { DIDRecord, UTXOReference } from './types.js'
import { Base64String } from '@bsv/sdk'
import { LookupFormula } from '@bsv/overlay'

// Implements a Lookup Storage Manager for DID tokens
export class DIDStorageManager {
  private readonly records: Collection<DIDRecord>

  /**
   * Constructs a new DIDStorage instance
   * @param {Db} db - connected mongo database instance
   */
  constructor(private readonly db: Db) {
    this.records = db.collection<DIDRecord>('didRecords')
    this.records.createIndex({
      searchableAttributes: 'text'
    }).catch((e) => console.error(e))
  }

  /**
   * Stores a new DID record
   * @param {string} txid transaction id
   * @param {number} outputIndex index of the UTXO
   * @param {Base64String} serialNumber certificate serial number to store
   */
  async storeRecord(txid: string, outputIndex: number, serialNumber: Base64String): Promise<void> {
    await this.records.insertOne({
      txid,
      outputIndex,
      serialNumber,
      createdAt: new Date()
    })
  }

  /**
   * Delete a matching DID record
   * @param {string} txid transaction id
   * @param {number} outputIndex index of the UTXO
   */
  async deleteRecord(txid: string, outputIndex: number): Promise<void> {
    await this.records.deleteOne({ txid, outputIndex })
  }

  /**
   * Find a matching DID record by matching certificate serial number
   * @param {Base64String} serialNumber - Unique certificate serial number to query by
   * @returns {Promise<LookupFormula>} - Returns matching UTXO references
   */
  async findByCertificateSerialNumber(serialNumber: Base64String): Promise<LookupFormula> {
    return await this.findRecordWithQuery({ serialNumber })
  }

  /**
   * Find a matching DID record by matching outpoint
   * @param {string} outpoint - Outpoint to query by (format: "txid.outputIndex")
   * @returns {Promise<LookupFormula>} - Returns matching UTXO references
   */
  async findByOutpoint(outpoint: string): Promise<LookupFormula> {
    // Parse txid and outputIndex from the outpoint string (format: "txid.outputIndex")
    const [txid, outputIndexStr] = outpoint.split('.')
    const outputIndex = parseInt(outputIndexStr, 10)

    if (!txid || isNaN(outputIndex)) {
      throw new Error('Invalid outpoint format. Expected "txid.outputIndex"')
    }

    return await this.findRecordWithQuery({ txid, outputIndex })
  }

  /**
   * Helper function for querying from the database
   * @param {object} query
   * @returns {Promise<LookupFormula>} returns matching UTXO references
   */
  private async findRecordWithQuery(query: object): Promise<LookupFormula> {
    // Find matching results from the DB
    return await this.records.find(query).project<UTXOReference>({ txid: 1, outputIndex: 1 }).toArray()
  }
} 
