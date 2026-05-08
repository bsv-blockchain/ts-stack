import { Collection, Db } from 'mongodb'
import { IdentityAttributes, IdentityRecord, UTXOReference } from './types.js'
import { Base64String, Certificate, PubKeyHex } from '@bsv/sdk'

interface Query {
  $and: Array<{ [key: string]: any }>
}

export class IdentityStorageManager {
  private readonly records: Collection<IdentityRecord>
  private indexInit?: Promise<void>

  constructor(private readonly db: Db) {
    this.records = db.collection<IdentityRecord>('identityRecords')
  }

  private ensureIndexes(): Promise<void> {
    if (this.indexInit === undefined) {
      this.indexInit = (async () => {
        await Promise.all([
          this.records.createIndex({ txid: 1, outputIndex: 1 }, { unique: true }),
          this.records.createIndex({ 'certificate.serialNumber': 1 }),
          this.records.createIndex({ 'certificate.subject': 1 }),
          this.records.createIndex({ 'certificate.certifier': 1 }),
          this.records.createIndex({ 'certificate.subject': 1, 'certificate.certifier': 1 }),
          this.records.createIndex({ 'certificate.subject': 1, 'certificate.type': 1 }),
          this.records.createIndex({ 'certificate.fields.userName': 1 }),
          this.records.createIndex({ 'certificate.fields.userName': 1, 'certificate.certifier': 1 }),
          this.records.createIndex({ searchableAttributes: 'text' })
        ])
      })()
    }
    return this.indexInit
  }

  async storeRecord(txid: string, outputIndex: number, certificate: Certificate): Promise<void> {
    await this.ensureIndexes()
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

  async deleteRecord(txid: string, outputIndex: number): Promise<void> {
    await this.ensureIndexes()
    await this.records.deleteOne({ txid, outputIndex })
  }

  private normalizeSearchInput(input: string): string {
    return input.trim().replaceAll(/\s+/g, ' ')
  }

  private getFuzzyRegex(input: string): RegExp {
    const normalizedInput = this.normalizeSearchInput(input)
    if (normalizedInput.length === 0) {
      return /^$/
    }
    const fuzzyPattern = normalizedInput
      .split(' ')
      .map(token => token.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`))
      .join('.*')
    return new RegExp(fuzzyPattern, 'i')
  }

  async findByAttribute(attributes: IdentityAttributes, certifiers?: string[], limit?: number, offset?: number): Promise<UTXOReference[]> {
    await this.ensureIndexes()
    if (attributes === undefined || Object.keys(attributes).length === 0) {
      return []
    }

    const query: Query = { $and: [] }

    if (certifiers !== undefined && certifiers.length > 0) {
      query.$and.push({ 'certificate.certifier': { $in: certifiers } })
    }

    if ('any' in attributes) {
      const anySearch = this.normalizeSearchInput(attributes.any)
      if (anySearch.length === 0) return []
      if (anySearch.length < 2) return []

      if (anySearch.length > 2) {
        query.$and.push({ $text: { $search: anySearch } })
      } else {
        query.$and.push({ searchableAttributes: this.getFuzzyRegex(anySearch) })
      }
    } else {
      const attributeQueries = Object.entries(attributes)
        .filter(([, value]) => this.normalizeSearchInput(value).length > 0)
        .map(([key, value]) => ({
          [`certificate.fields.${key}`]: key === 'userName'
            ? this.normalizeSearchInput(value)
            : this.getFuzzyRegex(value)
        }))

      if (attributeQueries.length === 0) return []
      query.$and.push(...attributeQueries)
    }

    return await this.findRecordWithQuery(query, limit, offset)
  }

  async findByIdentityKey(identityKey: PubKeyHex, certifiers?: PubKeyHex[], limit?: number, offset?: number): Promise<UTXOReference[]> {
    await this.ensureIndexes()
    if (identityKey === undefined) return []

    const query: any = { 'certificate.subject': identityKey }

    if (certifiers !== undefined && certifiers.length > 0) {
      query['certificate.certifier'] = { $in: certifiers }
    }

    return await this.findRecordWithQuery(query, limit, offset)
  }

  async findByCertifier(certifiers: PubKeyHex[], limit?: number, offset?: number): Promise<UTXOReference[]> {
    await this.ensureIndexes()
    if (certifiers === undefined || certifiers.length === 0) return []

    const query = { 'certificate.certifier': { $in: certifiers } }
    return await this.findRecordWithQuery(query, limit, offset)
  }

  async findByCertificateType(certificateTypes: Base64String[], identityKey: PubKeyHex, certifiers?: PubKeyHex[], limit?: number, offset?: number): Promise<UTXOReference[]> {
    await this.ensureIndexes()
    if (certificateTypes === undefined || certificateTypes.length === 0 || identityKey === undefined) return []

    const query: any = {
      'certificate.subject': identityKey,
      'certificate.type': { $in: certificateTypes }
    }

    if (certifiers !== undefined && certifiers.length > 0) {
      query['certificate.certifier'] = { $in: certifiers }
    }

    return await this.findRecordWithQuery(query, limit, offset)
  }

  async findByCertificateSerialNumber(serialNumber: Base64String, limit?: number, offset?: number): Promise<UTXOReference[]> {
    await this.ensureIndexes()
    if (serialNumber === undefined || serialNumber === '') return []

    const query = { 'certificate.serialNumber': serialNumber }
    return await this.findRecordWithQuery(query, limit, offset)
  }

  private async findRecordWithQuery(query: object, limit?: number, offset?: number): Promise<UTXOReference[]> {
    let cursor = this.records.find(query).project({ txid: 1, outputIndex: 1 })
    if (typeof limit === 'number' && limit > 0) {
      cursor = cursor.limit(limit)
    }
    if (typeof offset === 'number' && offset >= 0) {
      cursor = cursor.skip(offset)
    }
    const results = await cursor.toArray()
    return results.map(record => ({ txid: record.txid, outputIndex: record.outputIndex }))
  }
}
