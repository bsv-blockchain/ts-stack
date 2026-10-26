import { Collection, Db } from 'mongodb'
import { createHash } from 'node:crypto'
import { CollectionIndexes } from '../shared/collectionIndexes.js'
import {
  IdentityAttributes,
  IdentityRecord,
  IdentityRevelationRevocation,
  UTXOReference
} from './types.js'
import { Base64String, Certificate, PubKeyHex } from '@bsv/sdk'

interface Query {
  $and: Array<{ [key: string]: any }>
}

export class IdentityStorageManager {
  private readonly records: Collection<IdentityRecord>
  private readonly revocations: Collection<IdentityRevelationRevocation>

  private readonly indexes = new CollectionIndexes('IdentityStorageManager', () => [
    {
      label: 'txid_1_outputIndex_1',
      collection: this.records,
      keys: { txid: 1, outputIndex: 1 },
      options: { unique: true }
    },
    {
      label: 'revelationId_1',
      collection: this.records,
      keys: { revelationId: 1 },
      options: { sparse: true }
    },
    {
      label: 'certificate.serialNumber_1',
      collection: this.records,
      keys: { 'certificate.serialNumber': 1 }
    },
    {
      label: 'certificate.subject_1',
      collection: this.records,
      keys: { 'certificate.subject': 1 }
    },
    {
      label: 'certificate.certifier_1',
      collection: this.records,
      keys: { 'certificate.certifier': 1 }
    },
    {
      label: 'certificate.subject_1_certificate.certifier_1',
      collection: this.records,
      keys: { 'certificate.subject': 1, 'certificate.certifier': 1 }
    },
    {
      label: 'certificate.subject_1_certificate.type_1',
      collection: this.records,
      keys: { 'certificate.subject': 1, 'certificate.type': 1 }
    },
    {
      label: 'certificate.fields.userName_1',
      collection: this.records,
      keys: { 'certificate.fields.userName': 1 }
    },
    {
      label: 'certificate.fields.userName_1_certificate.certifier_1',
      collection: this.records,
      keys: { 'certificate.fields.userName': 1, 'certificate.certifier': 1 }
    },
    {
      label: 'searchableAttributes_text',
      collection: this.records,
      keys: { searchableAttributes: 'text' }
    },
    {
      label: 'revelationId_1_unique',
      collection: this.revocations,
      keys: { revelationId: 1 },
      options: { unique: true }
    }
  ])

  constructor(private readonly db: Db) {
    this.records = db.collection<IdentityRecord>('identityRecords')
    this.revocations = db.collection<IdentityRevelationRevocation>('identityRevelationRevocations')
  }

  private async ensureIndexes(): Promise<void> {
    return await this.indexes.ensure()
  }

  async storeRecord(txid: string, outputIndex: number, certificate: Certificate): Promise<void> {
    await this.ensureIndexes()
    const revelationId = this.getRevelationId(certificate)
    if (await this.isRevoked(revelationId)) return

    // Upsert rather than insert: the same output can be admitted more than once (GASP sync,
    // resubmission), and duplicate rows are what breaks the unique index build.
    await this.records.updateOne(
      { txid, outputIndex },
      {
        $set: {
          certificate,
          revelationId,
          searchableAttributes: Object.entries(certificate.fields)
            .filter(([key]) => key !== 'profilePhoto' && key !== 'icon')
            .map(([, value]) => value)
            .join(' ')
        },
        $setOnInsert: { txid, outputIndex, createdAt: new Date() }
      },
      { upsert: true }
    )

    // A spend notification can race admission. Recheck after the write so a token cannot
    // reappear between the first revocation check and the upsert.
    if (await this.isRevoked(revelationId)) {
      await this.records.deleteMany({ revelationId })
    }
  }

  async deleteRecord(txid: string, outputIndex: number): Promise<void> {
    await this.ensureIndexes()
    await this.records.deleteOne({ txid, outputIndex })
  }

  /**
   * Permanently withdraw one signed public revelation. A PushDrop output is public and can
   * be copied byte-for-byte into another transaction, so deleting only the spent outpoint
   * lets a copied output resurrect the same revelation. The tombstone is keyed by the
   * certificate signature plus its selectively disclosed keyring, which identifies the
   * signed revelation without conflating different field subsets from the same certificate.
   */
  async revokeRecord(
    txid: string,
    outputIndex: number,
    authenticatedCertificate?: Certificate
  ): Promise<void> {
    await this.ensureIndexes()
    const existing = await this.records.findOne({ txid, outputIndex })
    const certificate = authenticatedCertificate ?? existing?.certificate
    if (certificate === undefined) {
      // Preserve idempotent cleanup for legacy callers, but do not create a tombstone from
      // untrusted identifiers alone.
      await this.records.deleteOne({ txid, outputIndex })
      return
    }

    const revelationId = this.getRevelationId(certificate)
    const legacySelector = this.getLegacyRevelationSelector(certificate)
    // Backfill the identifier before publishing the tombstone. If the process exits after
    // the tombstone write but before deletion, lookup's join still hides every legacy copy.
    await this.records.updateMany(legacySelector, { $set: { revelationId } })
    await this.revocations.updateOne(
      { revelationId },
      {
        $setOnInsert: {
          revelationId,
          txid,
          outputIndex,
          revokedAt: new Date()
        }
      },
      { upsert: true }
    )

    // The second selector removes legacy rows written before revelationId was stored.
    await this.records.deleteMany({
      $or: [{ revelationId }, legacySelector]
    })
  }

  private async isRevoked(revelationId: string): Promise<boolean> {
    return (await this.revocations.findOne({ revelationId }, { projection: { _id: 1 } })) !== null
  }

  private getRevelationId(certificate: Certificate): string {
    const keyring = (certificate as Certificate & { keyring?: unknown }).keyring
    if (
      keyring == null ||
      typeof keyring !== 'object' ||
      Array.isArray(keyring) ||
      (Object.getPrototypeOf(keyring) !== Object.prototype &&
        Object.getPrototypeOf(keyring) !== null)
    ) {
      throw new Error('Identity revelation certificate must contain a plain keyring')
    }
    const keyringEntries = Object.entries(keyring as Record<string, unknown>)
      .map(([name, value]) => {
        if (typeof value !== 'string') {
          throw new Error('Identity revelation certificate keyring values must be strings')
        }
        return [name, value] as const
      })
      .sort(([left], [right]) => left.localeCompare(right))
    if (keyringEntries.length === 0) {
      throw new Error('Identity revelation certificate keyring must not be empty')
    }

    return createHash('sha256')
      .update(
        JSON.stringify([
          certificate.type,
          certificate.serialNumber,
          certificate.subject,
          certificate.certifier,
          certificate.revocationOutpoint,
          certificate.signature,
          keyringEntries
        ]),
        'utf8'
      )
      .digest('hex')
  }

  private getLegacyRevelationSelector(certificate: Certificate): Record<string, unknown> {
    return {
      'certificate.type': certificate.type,
      'certificate.serialNumber': certificate.serialNumber,
      'certificate.subject': certificate.subject,
      'certificate.certifier': certificate.certifier,
      'certificate.revocationOutpoint': certificate.revocationOutpoint,
      'certificate.signature': certificate.signature,
      'certificate.keyring': (certificate as Certificate & { keyring: Record<string, string> })
        .keyring
    }
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

  async findByAttribute(
    attributes: IdentityAttributes,
    certifiers?: string[],
    limit?: number,
    offset?: number
  ): Promise<UTXOReference[]> {
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
          [`certificate.fields.${key}`]:
            key === 'userName' ? this.normalizeSearchInput(value) : this.getFuzzyRegex(value)
        }))

      if (attributeQueries.length === 0) return []
      query.$and.push(...attributeQueries)
    }

    return await this.findRecordWithQuery(query, limit, offset)
  }

  async findByIdentityKey(
    identityKey: PubKeyHex,
    certifiers?: PubKeyHex[],
    limit?: number,
    offset?: number
  ): Promise<UTXOReference[]> {
    await this.ensureIndexes()
    if (identityKey === undefined) return []

    const query: any = { 'certificate.subject': identityKey }

    if (certifiers !== undefined && certifiers.length > 0) {
      query['certificate.certifier'] = { $in: certifiers }
    }

    return await this.findRecordWithQuery(query, limit, offset)
  }

  async findByCertifier(
    certifiers: PubKeyHex[],
    limit?: number,
    offset?: number
  ): Promise<UTXOReference[]> {
    await this.ensureIndexes()
    if (certifiers === undefined || certifiers.length === 0) return []

    const query = { 'certificate.certifier': { $in: certifiers } }
    return await this.findRecordWithQuery(query, limit, offset)
  }

  async findByCertificateType(
    certificateTypes: Base64String[],
    identityKey: PubKeyHex,
    certifiers?: PubKeyHex[],
    limit?: number,
    offset?: number
  ): Promise<UTXOReference[]> {
    await this.ensureIndexes()
    if (
      certificateTypes === undefined ||
      certificateTypes.length === 0 ||
      identityKey === undefined
    )
      return []

    const query: any = {
      'certificate.subject': identityKey,
      'certificate.type': { $in: certificateTypes }
    }

    if (certifiers !== undefined && certifiers.length > 0) {
      query['certificate.certifier'] = { $in: certifiers }
    }

    return await this.findRecordWithQuery(query, limit, offset)
  }

  async findByCertificateSerialNumber(
    serialNumber: Base64String,
    limit?: number,
    offset?: number
  ): Promise<UTXOReference[]> {
    await this.ensureIndexes()
    if (serialNumber === undefined || serialNumber === '') return []

    const query = { 'certificate.serialNumber': serialNumber }
    return await this.findRecordWithQuery(query, limit, offset)
  }

  private async findRecordWithQuery(
    query: object,
    limit?: number,
    offset?: number
  ): Promise<UTXOReference[]> {
    const pipeline: object[] = [
      { $match: query },
      {
        $lookup: {
          from: 'identityRevelationRevocations',
          localField: 'revelationId',
          foreignField: 'revelationId',
          as: 'revelationRevocations'
        }
      },
      { $match: { revelationRevocations: { $size: 0 } } },
      { $project: { txid: 1, outputIndex: 1 } }
    ]
    if (typeof offset === 'number' && offset >= 0) {
      pipeline.push({ $skip: offset })
    }
    if (typeof limit === 'number' && limit > 0) {
      pipeline.push({ $limit: limit })
    }
    const results = await this.records
      .aggregate<Pick<IdentityRecord, 'txid' | 'outputIndex'>>(pipeline)
      .toArray()
    return results.map(record => ({ txid: record.txid, outputIndex: record.outputIndex }))
  }
}
