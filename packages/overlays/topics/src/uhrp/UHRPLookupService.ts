import {
  AdmissionMode,
  LookupQuestion,
  LookupService,
  OutputAdmittedByTopic,
  OutputSpent,
  SpendNotificationMode
} from '@bsv/overlay'
import {
  decodeAndVerifyUHRPAdvertisement,
  PublicKey,
  StorageUtils
} from '@bsv/sdk'
import { UHRPRecord, UTXOReference } from './types.js'
import { Db, Collection } from 'mongodb'
import {
  readInteger,
  readString,
  requireLookupQuery,
  requireOutpoint
} from '../shared/queryValidation.js'

export class UHRPLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'
  records: Collection<UHRPRecord>

  constructor(db: Db) {
    this.records = db.collection<UHRPRecord>('uhrp')
  }

  async getDocumentation(): Promise<string> {
    return 'UHRP Lookup Service: lookup service for user file hosting commitment tokens.'
  }

  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'UHRP Lookup Service',
      shortDescription: 'Lookup Service for User file hosting commitment tokens'
    }
  }

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic) {
    if (payload.mode !== 'locking-script') throw new Error('Invalid payload')
    const { topic, txid, outputIndex, lockingScript } = payload
    if (topic !== 'tm_uhrp') return
    if (!/^[0-9a-f]{64}$/i.test(txid) || !Number.isSafeInteger(outputIndex) || outputIndex < 0 || outputIndex > 0xffffffff) {
      throw new Error('Invalid UHRP admission outpoint')
    }
    const token = await decodeAndVerifyUHRPAdvertisement(lockingScript)
    const uhrpUrl = StorageUtils.getURLForHash(token.hash)

    await this.records.replaceOne({ txid: txid.toLowerCase(), outputIndex }, {
      uhrpUrl,
      txid: txid.toLowerCase(),
      outputIndex,
      hostIdentityKey: token.hostIdentityKey,
      hostedFileLocation: token.hostedFileLocation,
      expiryTime: token.expiryTime,
      fileSize: token.fileSize
    }, { upsert: true })
  }

  async outputSpent(payload: OutputSpent) {
    if (payload.mode !== 'none') throw new Error('Invalid payload')
    const { topic, txid, outputIndex } = payload
    if (topic !== 'tm_uhrp') return
    await this.records.deleteOne({ txid, outputIndex })
  }

  async outputEvicted(txid: string, outputIndex: number) {
    await this.records.deleteOne({ txid, outputIndex })
  }

  async lookup(question: LookupQuestion): Promise<UTXOReference[]> {
    const query = requireLookupQuery(question, 'ls_uhrp', [
      'outpoint',
      'uhrpUrl',
      'expiryTime',
      'hostIdentityKey',
      'limit',
      'offset'
    ])
    const outpointValue = readString(query, 'outpoint', { maxBytes: 75 })
    const outpoint = requireOutpoint(outpointValue)
    if (outpoint !== undefined) {
      const result = await this.records.findOne(outpoint)
      if (!result) return []
      return [{ txid: result.txid, outputIndex: result.outputIndex }]
    }

    const rawUhrpUrl = readString(query, 'uhrpUrl', { maxBytes: 128 })
    let uhrpUrl: string | undefined
    if (rawUhrpUrl !== undefined) {
      if (!StorageUtils.isValidURL(rawUhrpUrl))
        throw new Error('Invalid lookup query: uhrpUrl is invalid')
      uhrpUrl = StorageUtils.normalizeURL(rawUhrpUrl)
    }
    const hostIdentityKey = readString(query, 'hostIdentityKey', { maxBytes: 66 })
    if (hostIdentityKey !== undefined) {
      if (!/^(?:02|03)[0-9a-fA-F]{64}$/.test(hostIdentityKey)) {
        throw new Error('Invalid lookup query: hostIdentityKey must be a compressed public key')
      }
      try {
        PublicKey.fromString(hostIdentityKey)
      } catch {
        throw new Error('Invalid lookup query: hostIdentityKey must be a valid public key')
      }
    }
    const expiryTime =
      query.expiryTime === undefined
        ? undefined
        : readInteger(query, 'expiryTime', 0, 1, Number.MAX_SAFE_INTEGER)
    if (uhrpUrl === undefined && expiryTime === undefined && hostIdentityKey === undefined) {
      throw new Error(
        'Lookup must specify either outpoint, or at least one of (uhrpUrl, expiryTime, hostIdentityKey)'
      )
    }

    const limit = readInteger(query, 'limit', 50, 1, 200)
    const offset = readInteger(query, 'offset', 0, 0, 100000)
    const filter: Partial<Pick<UHRPRecord, 'uhrpUrl' | 'expiryTime' | 'hostIdentityKey'>> = {}
    if (uhrpUrl !== undefined) filter.uhrpUrl = uhrpUrl
    if (expiryTime !== undefined) filter.expiryTime = expiryTime
    if (hostIdentityKey !== undefined) filter.hostIdentityKey = hostIdentityKey.toLowerCase()
    const result = await this.records
      .find(filter)
      .project<UHRPRecord>({ txid: 1, outputIndex: 1 })
      .sort({ txid: 1, outputIndex: 1 })
      .skip(offset)
      .limit(limit)
      .toArray()
    return result.map(x => ({ txid: x.txid, outputIndex: x.outputIndex }))
  }
}

function create(db: Db): UHRPLookupService {
  return new UHRPLookupService(db)
}
export default create
