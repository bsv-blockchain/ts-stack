import { Collection, Db } from 'mongodb'
import { IdentityAttributes, IdentityRecord, UTXOReference } from './types.js'
import { Base64String, Certificate, PubKeyHex } from '@bsv/sdk'

interface Query {
  $and: Array<{ [key: string]: any }>
}

export class IdentityStorageManager {
  private readonly records: Collection<IdentityRecord>
  private indexInit?: Promise<void>

  constructor (private readonly db: Db) {
    this.records = db.collection<IdentityRecord>('identityRecords')
  }

  /**
   * Index creation is best-effort: a collection that predates the unique
   * (txid, outputIndex) index can hold duplicate rows, and the resulting E11000 must not
   * take every read down with it. Each index is attempted independently, failures are
   * logged, and a failed run is not cached — the next call retries, so a node recovers
   * once the duplicates are cleaned up without needing a restart.
   */
  private async ensureIndexes (): Promise<void> {
    this.indexInit ??= (async () => {
      const specs: Array<[string, Parameters<Collection<IdentityRecord>['createIndex']>[0], { unique?: boolean }]> = [
        ['txid_1_outputIndex_1', { txid: 1, outputIndex: 1 }, { unique: true }],
        ['certificate.serialNumber_1', { 'certificate.serialNumber': 1 }, {}],
        ['certificate.subject_1', { 'certificate.subject': 1 }, {}],
        ['certificate.certifier_1', { 'certificate.certifier': 1 }, {}],
        ['certificate.subject_1_certificate.certifier_1', { 'certificate.subject': 1, 'certificate.certifier': 1 }, {}],
        ['certificate.subject_1_certificate.type_1', { 'certificate.subject': 1, 'certificate.type': 1 }, {}],
        ['certificate.fields.userName_1', { 'certificate.fields.userName': 1 }, {}],
        [
          'certificate.fields.userName_1_certificate.certifier_1',
          { 'certificate.fields.userName': 1, 'certificate.certifier': 1 },
          {}
        ],
        ['searchableAttributes_text', { searchableAttributes: 'text' }, {}]
      ]

      const results = await Promise.all(
        specs.map(async ([name, keys, options]) => {
          try {
            await this.records.createIndex(keys, options)
            return true
          } catch (error) {
            console.error(
              `IdentityStorageManager: failed to create index ${name} on identityRecords; continuing without it`,
              error
            )
            return false
          }
        })
      )

      // Retry on the next call so a repaired collection recovers in place.
      if (results.includes(false)) this.indexInit = undefined
    })()
    return await this.indexInit
  }

  async storeRecord (txid: string, outputIndex: number, certificate: Certificate): Promise<void> {
    await this.ensureIndexes()
    // Upsert rather than insert: the same output can be admitted more than once (GASP sync,
    // resubmission), and duplicate rows are what breaks the unique index build.
    await this.records.updateOne(
      { txid, outputIndex },
      {
        $set: {
          certificate,
          searchableAttributes: Object.entries(certificate.fields)
            .filter(([key]) => key !== 'profilePhoto' && key !== 'icon')
            .map(([, value]) => value)
            .join(' ')
        },
        $setOnInsert: { txid, outputIndex, createdAt: new Date() }
      },
      { upsert: true }
    )
  }

  async deleteRecord (txid: string, outputIndex: number): Promise<void> {
    await this.ensureIndexes()
    await this.records.deleteOne({ txid, outputIndex })
  }

  private normalizeSearchInput (input: string): string {
    return input.trim().replaceAll(/\s+/g, ' ')
  }

  private getFuzzyRegex (input: string): RegExp {
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

  async findByAttribute (attributes: IdentityAttributes, certifiers?: string[], limit?: number, offset?: number): Promise<UTXOReference[]> {
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

  async findByIdentityKey (identityKey: PubKeyHex, certifiers?: PubKeyHex[], limit?: number, offset?: number): Promise<UTXOReference[]> {
    await this.ensureIndexes()
    if (identityKey === undefined) return []

    const query: any = { 'certificate.subject': identityKey }

    if (certifiers !== undefined && certifiers.length > 0) {
      query['certificate.certifier'] = { $in: certifiers }
    }

    return await this.findRecordWithQuery(query, limit, offset)
  }

  async findByCertifier (certifiers: PubKeyHex[], limit?: number, offset?: number): Promise<UTXOReference[]> {
    await this.ensureIndexes()
    if (certifiers === undefined || certifiers.length === 0) return []

    const query = { 'certificate.certifier': { $in: certifiers } }
    return await this.findRecordWithQuery(query, limit, offset)
  }

  async findByCertificateType (certificateTypes: Base64String[], identityKey: PubKeyHex, certifiers?: PubKeyHex[], limit?: number, offset?: number): Promise<UTXOReference[]> {
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

  async findByCertificateSerialNumber (serialNumber: Base64String, limit?: number, offset?: number): Promise<UTXOReference[]> {
    await this.ensureIndexes()
    if (serialNumber === undefined || serialNumber === '') return []

    const query = { 'certificate.serialNumber': serialNumber }
    return await this.findRecordWithQuery(query, limit, offset)
  }

  private async findRecordWithQuery (query: object, limit?: number, offset?: number): Promise<UTXOReference[]> {
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
