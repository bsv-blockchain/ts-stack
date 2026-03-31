import { Collection, Db } from 'mongodb'
import { IdentityAttributes, IdentityRecord, UTXOReference } from './types.js'
import { Base64String, Certificate, PubKeyHex } from '@bsv/sdk'

interface Query {
  $and: Array<{ [key: string]: any }>
}

// Implements a Lookup Storage Manager for Identity key registry
export class IdentityStorageManager {
  private readonly records: Collection<IdentityRecord>

  /**
   * Constructs a new IdentityStorage instance
   * @param {Db} db - connected mongo database instance
   */
  constructor(private readonly db: Db) {
    this.records = db.collection<IdentityRecord>('identityRecords')
    this.records.createIndex({ txid: 1, outputIndex: 1 }, { unique: true }).catch((e) => console.error(e))
    this.records.createIndex({ 'certificate.serialNumber': 1 }).catch((e) => console.error(e))
    this.records.createIndex({ 'certificate.subject': 1 }).catch((e) => console.error(e))
    this.records.createIndex({ 'certificate.certifier': 1 }).catch((e) => console.error(e))
    this.records.createIndex({ 'certificate.subject': 1, 'certificate.certifier': 1 }).catch((e) => console.error(e))
    this.records.createIndex({ 'certificate.subject': 1, 'certificate.type': 1 }).catch((e) => console.error(e))
    this.records.createIndex({ 'certificate.fields.userName': 1 }).catch((e) => console.error(e))
    this.records.createIndex({ 'certificate.fields.userName': 1, 'certificate.certifier': 1 }).catch((e) => console.error(e))
    this.records.createIndex({
      searchableAttributes: 'text'
    }).catch((e) => console.error(e))
  }

  /**
   * Stores record of certification
   * @param {string} txid transaction id
   * @param {number} outputIndex index of the UTXO
   * @param {Certificate} certificate certificate record to store
   */
  async storeRecord(txid: string, outputIndex: number, certificate: Certificate): Promise<void> {
    // Insert new record
    await this.records.insertOne({
      txid,
      outputIndex,
      certificate,
      createdAt: new Date(),
      searchableAttributes: Object.entries(certificate.fields)
        .filter(([key]) => key !== 'profilePhoto' && key !== 'icon')
        .map(([, value]) => value)
        .join(' ')
    })
  }

  /**
   * Delete a matching Identity record
   * @param {string} txid transaction id
   * @param {number} outputIndex index of the UTXO
   */
  async deleteRecord(txid: string, outputIndex: number): Promise<void> {
    await this.records.deleteOne({ txid, outputIndex })
  }

  private normalizeSearchInput(input: string): string {
    return input.trim().replace(/\s+/g, ' ')
  }

  // Helper function to convert a string into a regex pattern for fuzzy search
  private getFuzzyRegex(input: string): RegExp {
    const normalizedInput = this.normalizeSearchInput(input)
    if (normalizedInput.length === 0) {
      return /^$/
    }

    const fuzzyPattern = normalizedInput
      .split(' ')
      .map(token => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')

    return new RegExp(fuzzyPattern, 'i')
  }

  /**
   * Find one or more matching records by attribute
   * @param {IdentityAttributes} attributes certified attributes to query by
   * @param {PubKeyHex[]} [certifiers] acceptable identity certifiers
   * @returns {Promise<UTXOReference[]>} returns matching UTXO references
   */
  async findByAttribute(attributes: IdentityAttributes, certifiers?: string[], limit?: number, offset?: number): Promise<UTXOReference[]> {
    // Make sure valid query attributes are provided
    if (attributes === undefined || Object.keys(attributes).length === 0) {
      return []
    }

    // Initialize the query and optionally apply certifier filter
    const query: Query = {
      $and: []
    }

    if (certifiers !== undefined && certifiers.length > 0) {
      query.$and.push({ 'certificate.certifier': { $in: certifiers } })
    }

    if ('any' in attributes) {
      const anySearch = this.normalizeSearchInput(attributes.any)
      if (anySearch.length === 0) {
        return []
      }
      if (anySearch.length < 2) {
        return []
      }

      // Use text search for scalability (indexed via searchableAttributes text index).
      // Keep regex fallback for very short queries where tokenization may be too coarse.
      if (anySearch.length > 2) {
        query.$and.push({ $text: { $search: anySearch } })
      } else {
        query.$and.push({ searchableAttributes: this.getFuzzyRegex(anySearch) })
      }
    } else {
      // Construct regex queries for specific fields
      const attributeQueries = Object.entries(attributes)
        .filter(([, value]) => this.normalizeSearchInput(value).length > 0)
        .map(([key, value]) => ({
          [`certificate.fields.${key}`]: key === 'userName'
            ? this.normalizeSearchInput(value)
            : this.getFuzzyRegex(value)
        }))

      if (attributeQueries.length === 0) {
        return []
      }

      query.$and.push(...attributeQueries)
    }

    // Find matching results from the DB
    return await this.findRecordWithQuery(query, limit, offset)
  }

  /**
   * Finds matching records by identity key, and optional certifiers
   * @param {PubKeyHex} identityKey the public identity key to query by
   * @param {PubKeyHex[]} [certifiers] acceptable identity certifiers
   * @returns {Promise<UTXOReference[]>} returns matching UTXO references
   */
  async findByIdentityKey(identityKey: PubKeyHex, certifiers?: PubKeyHex[], limit?: number, offset?: number): Promise<UTXOReference[]> {
    // Validate search query param
    if (identityKey === undefined) {
      return []
    }

    // Construct the base query with the identityKey
    const query = {
      'certificate.subject': identityKey
    }

    // If certifiers array is provided and not empty, add the $in query for certifiers
    if (certifiers !== undefined && certifiers.length > 0) {
      (query as any)['certificate.certifier'] = { $in: certifiers }
    }

    // Find matching results from the DB
    return await this.findRecordWithQuery(query, limit, offset)
  }

  /**
   * Find one or more records by matching certifier
   * @param {PubKeyHex[]} certifiers acceptable identity certifiers
   * @returns {Promise<UTXOReference[]>} returns matching UTXO references
   */
  async findByCertifier(certifiers: PubKeyHex[], limit?: number, offset?: number): Promise<UTXOReference[]> {
    // Validate search query param
    if (certifiers === undefined || certifiers.length === 0) {
      return []
    }

    // Construct the query to search for any of the certifiers
    const query = {
      'certificate.certifier': { $in: certifiers }
    }

    // Find matching results from the DB
    return await this.findRecordWithQuery(query, limit, offset)
  }

  /**
   * Find one or more records by matching certificate type
   * @param {Base64String[]} certificateTypes acceptable certificate types
   * @param {PubKeyHex} identityKey identity key of the user
   * @param {PubKeyHex[]} [certifiers] certifier public keys
   * @returns {Promise<UTXOReference[]>} returns matching UTXO references
   */
  async findByCertificateType(certificateTypes: Base64String[], identityKey: PubKeyHex, certifiers?: PubKeyHex[], limit?: number, offset?: number): Promise<UTXOReference[]> {
    // Validate search query param
    if (certificateTypes === undefined || certificateTypes.length === 0 || identityKey === undefined) {
      return []
    }

    // Construct the query to search for the certificate type along with identity and certifier filters
    const query: {
      'certificate.subject': PubKeyHex
      'certificate.type': { $in: Base64String[] }
      'certificate.certifier'?: { $in: PubKeyHex[] }
    } = {
      'certificate.subject': identityKey,
      'certificate.type': { $in: certificateTypes }
    }

    if (certifiers !== undefined && certifiers.length > 0) {
      query['certificate.certifier'] = { $in: certifiers }
    }

    // Find matching results from the DB
    return await this.findRecordWithQuery(query, limit, offset)
  }

  /**
   * Find one or more records by matching certificate serial number
   * @param {Base64String} serialNumber - Unique certificate serial number to query by
   * @returns {Promise<UTXOReference[]>} - Returns matching UTXO references
   */
  async findByCertificateSerialNumber(serialNumber: Base64String, limit?: number, offset?: number): Promise<UTXOReference[]> {
    // Validate the serial number parameter
    if (serialNumber === undefined || serialNumber === '') {
      return []
    }

    // Construct the query to search for the certificate with the given serial number.
    // This assumes that the certificate object includes a top-level `serialNumber` property.
    const query = {
      'certificate.serialNumber': serialNumber
    }

    // Find matching results from the DB
    return await this.findRecordWithQuery(query, limit, offset)
  }

  /**
   * Helper function for querying from the database
   * @param {object} query
   * @returns {Promise<UTXOReference[]>} returns matching UTXO references
   */
  private async findRecordWithQuery(query: object, limit?: number, offset?: number): Promise<UTXOReference[]> {
    // Find matching results from the DB
    let cursor = this.records.find(query).project({ txid: 1, outputIndex: 1 })
    if (typeof limit === 'number' && limit > 0) {
      cursor = cursor.limit(limit)
    }
    if (typeof offset === 'number' && offset >= 0) {
      cursor = cursor.skip(offset)
    }
    const results = await cursor.toArray()

    // Convert array of Documents to UTXOReferences
    const parsedResults: UTXOReference[] = results.map(record => ({
      txid: record.txid,
      outputIndex: record.outputIndex
    }))
    return parsedResults
  }
}
