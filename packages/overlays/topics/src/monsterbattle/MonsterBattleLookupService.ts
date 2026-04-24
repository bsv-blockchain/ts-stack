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

  constructor(public storage: MonsterBattleStorage) { }

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
    if (!question) throw new Error('A valid query must be provided!')
    if (question.service !== 'ls_monsterbattle') throw new Error('Lookup service not supported!')

    const { txid, limit = 50, skip = 0, startDate, endDate, sortOrder } = question.query as MonsterBattleQuery

    if (limit < 0) throw new Error('Limit must be a non-negative number')
    if (skip < 0) throw new Error('Skip must be a non-negative number')

    const from = startDate ? new Date(startDate) : undefined
    const to = endDate ? new Date(endDate) : undefined
    if (from && isNaN(from.getTime())) throw new Error('Invalid startDate provided!')
    if (to && isNaN(to.getTime())) throw new Error('Invalid endDate provided!')

    if (txid) return this.storage.findByTxid(txid, limit, skip, sortOrder)
    return this.storage.findAll(limit, skip, from, to, sortOrder)
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

export default (db: Db): MonsterBattleLookupService => new MonsterBattleLookupService(new MonsterBattleStorage(db))
