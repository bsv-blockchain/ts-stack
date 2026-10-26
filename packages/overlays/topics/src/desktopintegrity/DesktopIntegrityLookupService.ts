import { toHex } from '@bsv/sdk/primitives/utils'
import {
  LookupService,
  LookupQuestion,
  LookupFormula,
  AdmissionMode,
  SpendNotificationMode,
  OutputAdmittedByTopic,
  OutputSpent
} from '@bsv/overlay'
import { DesktopIntegrityStorage } from './DesktopIntegrityStorage.js'
import { Db } from 'mongodb'
import {
  readDate,
  readInteger,
  readSortOrder,
  readString,
  requireHex,
  requireLookupQuery,
  requireTxid
} from '../shared/queryValidation.js'

export interface DesktopIntegrityQuery {
  fileHash?: string
  txid?: string
  limit?: number
  skip?: number
  startDate?: Date
  endDate?: Date
  sortOrder?: 'asc' | 'desc'
}

export class DesktopIntegrityLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'

  constructor(public storage: DesktopIntegrityStorage) {}

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid mode')
    const { topic, lockingScript, txid, outputIndex } = payload
    if (topic !== 'tm_desktopintegrity') return

    try {
      const fileHash = lockingScript.chunks[1].data
      if (fileHash === undefined || fileHash[0] !== 32 || fileHash.length !== 33)
        throw new Error('Invalid DesktopIntegrity token: file hash must be exactly 32 bytes')
      const fileHashString = toHex(fileHash.slice(1))
      await this.storage.storeRecord(txid, outputIndex, fileHashString)
    } catch (err) {
      console.error(`DesktopIntegrityLookupService: failed to index ${txid}.${outputIndex}`, err)
    }
  }

  async outputSpent(payload: OutputSpent): Promise<void> {
    if (payload.mode !== 'none') throw new Error('Invalid mode')
    const { topic, txid, outputIndex } = payload
    if (topic !== 'tm_desktopintegrity') return
    await this.storage.deleteRecord(txid, outputIndex)
  }

  async outputEvicted(txid: string, outputIndex: number): Promise<void> {
    await this.storage.deleteRecord(txid, outputIndex)
  }

  async lookup(question: LookupQuestion): Promise<LookupFormula> {
    const query = requireLookupQuery(question, 'ls_desktopintegrity', [
      'fileHash',
      'txid',
      'limit',
      'skip',
      'startDate',
      'endDate',
      'sortOrder'
    ])
    const fileHash = requireHex(readString(query, 'fileHash', { maxBytes: 64 }), 'fileHash', 32)
    const txid = requireTxid(readString(query, 'txid', { maxBytes: 64 }))
    const limit = readInteger(query, 'limit', 50, 1, 100)
    const skip = readInteger(query, 'skip', 0, 0, 100000)
    const from = readDate(query, 'startDate')
    const to = readDate(query, 'endDate')
    const sortOrder = readSortOrder(query)
    if (from !== undefined && to !== undefined && from > to) {
      throw new Error('Invalid lookup query: startDate must not be after endDate')
    }

    if (fileHash) return await this.storage.findByFileHash(fileHash, limit, skip, sortOrder)
    if (txid) return await this.storage.findByTxid(txid, limit, skip, sortOrder)
    return await this.storage.findAll(limit, skip, from, to, sortOrder)
  }

  async getDocumentation(): Promise<string> {
    return 'DesktopIntegrity Lookup Service: find files on-chain.'
  }

  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'DesktopIntegrity Lookup Service',
      shortDescription: 'Find files on-chain.'
    }
  }
}

function create(db: Db): DesktopIntegrityLookupService {
  return new DesktopIntegrityLookupService(new DesktopIntegrityStorage(db))
}
export default create
