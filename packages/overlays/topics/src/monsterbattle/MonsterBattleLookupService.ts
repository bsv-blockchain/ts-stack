import {
  LookupService,
  LookupQuestion,
  LookupFormula,
  AdmissionMode,
  SpendNotificationMode,
  OutputAdmittedByTopic,
  OutputSpent
} from '@bsv/overlay'
import { MonsterBattleStorage } from './MonsterBattleStorage.js'
import { Db } from 'mongodb'
import {
  readDate,
  readInteger,
  readSortOrder,
  readString,
  requireLookupQuery,
  requireTxid
} from '../shared/queryValidation.js'

export interface MonsterBattleQuery {
  threadHash?: string
  txid?: string
  limit?: number
  skip?: number
  startDate?: Date
  endDate?: Date
  sortOrder?: 'asc' | 'desc'
}

export class MonsterBattleLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'

  constructor(public storage: MonsterBattleStorage) {}

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid mode')
    const { topic, txid, outputIndex } = payload
    if (topic !== 'tm_monsterbattle') return
    try {
      await this.storage.storeRecord(txid, outputIndex)
    } catch (err) {
      console.error(`Monsterbattle: failed to index ${txid}.${outputIndex}`, err)
    }
  }

  async outputSpent(payload: OutputSpent): Promise<void> {
    if (payload.mode !== 'none') throw new Error('Invalid mode')
    const { topic, txid, outputIndex } = payload
    if (topic !== 'tm_monsterbattle') return
    await this.storage.deleteRecord(txid, outputIndex)
  }

  async outputEvicted(txid: string, outputIndex: number): Promise<void> {
    await this.storage.deleteRecord(txid, outputIndex)
  }

  async lookup(question: LookupQuestion): Promise<LookupFormula> {
    const query = requireLookupQuery(question, 'ls_monsterbattle', [
      'txid',
      'limit',
      'skip',
      'startDate',
      'endDate',
      'sortOrder'
    ])
    const txid = requireTxid(readString(query, 'txid', { maxBytes: 64 }))
    const limit = readInteger(query, 'limit', 50, 1, 100)
    const skip = readInteger(query, 'skip', 0, 0, 100000)
    const from = readDate(query, 'startDate')
    const to = readDate(query, 'endDate')
    const sortOrder = readSortOrder(query)
    if (from !== undefined && to !== undefined && from > to) {
      throw new Error('Invalid lookup query: startDate must not be after endDate')
    }

    if (txid) return await this.storage.findByTxid(txid, limit, skip, sortOrder)
    return await this.storage.findAll(limit, skip, from, to, sortOrder)
  }

  async getDocumentation(): Promise<string> {
    return 'MonsterBattle Lookup Service: find monsterbattle tokens on-chain.'
  }

  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'MonsterBattle Lookup Service',
      shortDescription: 'Find monsterbattle tokens on-chain.'
    }
  }
}

function create(db: Db): MonsterBattleLookupService {
  return new MonsterBattleLookupService(new MonsterBattleStorage(db))
}
export default create
