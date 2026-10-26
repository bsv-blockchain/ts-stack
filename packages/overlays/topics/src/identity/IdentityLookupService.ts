import { IdentityStorageManager } from './IdentityStorageManager.js'
import {
  AdmissionMode,
  LookupFormula,
  LookupQuestion,
  LookupService,
  OutputAdmittedByTopic,
  OutputSpent,
  SpendNotificationMode
} from '@bsv/overlay'
import { ProtoWallet, Transaction } from '@bsv/sdk'
import { IdentityQuery } from './types.js'
import { Db } from 'mongodb'
import {
  readInteger,
  readString,
  readStringArray,
  requireBase64_32,
  requireLookupQuery,
  requireMongoFieldName,
  requirePublicKey
} from '../shared/queryValidation.js'
import { validateIdentityOutput } from './identityTokenValidation.js'

export class IdentityLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'whole-tx'
  private readonly anyoneWallet = new ProtoWallet('anyone')

  constructor(public storageManager: IdentityStorageManager) {}

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid payload')
    const { txid, outputIndex, topic, lockingScript } = payload
    if (topic !== 'tm_identity') return

    const { certificate, decryptedFields } = await validateIdentityOutput(
      { lockingScript, satoshis: 0 },
      this.anyoneWallet
    )
    certificate.fields = decryptedFields

    await this.storageManager.storeRecord(txid, outputIndex, certificate)
  }

  async outputSpent(payload: OutputSpent): Promise<void> {
    if (payload.mode !== 'whole-tx') throw new Error('Invalid payload')
    const { topic, txid, outputIndex } = payload
    if (topic !== 'tm_identity') return

    const spendingTransaction = Transaction.fromAtomicBEEF(payload.spendingAtomicBEEF)
    const matches = spendingTransaction.inputs.filter(input => {
      const sourceTxid = input.sourceTXID ?? input.sourceTransaction?.id('hex')
      return (
        sourceTxid?.toLowerCase() === txid.toLowerCase() && input.sourceOutputIndex === outputIndex
      )
    })
    if (matches.length !== 1) {
      throw new Error('Identity spend notification does not contain exactly one matching input')
    }
    const sourceOutput = matches[0].sourceTransaction?.outputs[outputIndex]
    if (sourceOutput?.lockingScript == null) {
      throw new Error('Identity spend notification is missing the authenticated source output')
    }
    const { certificate } = await validateIdentityOutput(sourceOutput, this.anyoneWallet)
    await this.storageManager.revokeRecord(txid, outputIndex, certificate)
  }

  async outputEvicted(txid: string, outputIndex: number): Promise<void> {
    await this.storageManager.deleteRecord(txid, outputIndex)
  }

  async lookup(question: LookupQuestion): Promise<LookupFormula> {
    const rawQuery = requireLookupQuery(question, 'ls_identity', [
      'attributes',
      'certifiers',
      'identityKey',
      'certificateTypes',
      'serialNumber',
      'limit',
      'offset'
    ])
    const limit = readInteger(rawQuery, 'limit', 10, 1, 100)
    const offset = readInteger(rawQuery, 'offset', 0, 0, 100000)
    const identityKey = requirePublicKey(
      readString(rawQuery, 'identityKey', { maxBytes: 66 }),
      'identityKey'
    )
    const serialNumber = requireBase64_32(
      readString(rawQuery, 'serialNumber', { maxBytes: 44 }),
      'serialNumber'
    )
    const certifiers = readStringArray(rawQuery, 'certifiers', {
      maxItems: 32,
      maxItemBytes: 66
    })?.map((value, index) => requirePublicKey(value, `certifiers[${index}]`)!)
    const certificateTypes = readStringArray(rawQuery, 'certificateTypes', {
      maxItems: 32,
      maxItemBytes: 44
    })?.map((value, index) => requireBase64_32(value, `certificateTypes[${index}]`)!)

    let attributes: IdentityQuery['attributes']
    if (rawQuery.attributes !== undefined) {
      if (
        rawQuery.attributes == null ||
        typeof rawQuery.attributes !== 'object' ||
        Array.isArray(rawQuery.attributes) ||
        (Object.getPrototypeOf(rawQuery.attributes) !== Object.prototype &&
          Object.getPrototypeOf(rawQuery.attributes) !== null)
      ) {
        throw new Error('Invalid lookup query: attributes must be a plain object')
      }
      const entries = Object.entries(rawQuery.attributes)
      if (entries.length === 0 || entries.length > 32) {
        throw new Error('Invalid lookup query: attributes must contain 1-32 fields')
      }
      const parsedAttributes: NonNullable<IdentityQuery['attributes']> = Object.create(null)
      for (const [field, value] of entries) {
        requireMongoFieldName(field)
        if (typeof value !== 'string' || new TextEncoder().encode(value).length > 500) {
          throw new Error(
            'Invalid lookup query: attribute values must be strings of at most 500 UTF-8 bytes'
          )
        }
        parsedAttributes[field] = value
      }
      attributes = parsedAttributes
    }

    if (serialNumber !== undefined) {
      return await this.storageManager.findByCertificateSerialNumber(serialNumber, limit, offset)
    }

    if (attributes !== undefined) {
      return await this.storageManager.findByAttribute(attributes, certifiers, limit, offset)
    } else if (identityKey !== undefined && certificateTypes !== undefined) {
      return await this.storageManager.findByCertificateType(
        certificateTypes,
        identityKey,
        certifiers,
        limit,
        offset
      )
    } else if (identityKey !== undefined) {
      return await this.storageManager.findByIdentityKey(identityKey, certifiers, limit, offset)
    } else if (certifiers !== undefined) {
      return await this.storageManager.findByCertifier(certifiers, limit, offset)
    } else {
      throw new Error(
        'One of the following params is missing: attribute, identityKey, certifier, or certificateType'
      )
    }
  }

  async getDocumentation(): Promise<string> {
    return 'Identity Lookup Service: find identity certificates by attribute, identity key, certifier, or certificate type.'
  }

  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'Identity Lookup Service',
      shortDescription: 'Identity resolution made easy.'
    }
  }
}

function create(db: Db): IdentityLookupService {
  return new IdentityLookupService(new IdentityStorageManager(db))
}
export default create
