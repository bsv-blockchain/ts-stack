import { BasketMapStorageManager } from './BasketMapStorageManager.js'
import { AdmissionMode, LookupFormula, LookupQuestion, LookupService, OutputAdmittedByTopic, OutputSpent, SpendNotificationMode } from '@bsv/overlay'
import { PushDrop, Utils } from '@bsv/sdk'
import { BasketMapQuery, BasketMapRegistration } from './types.js'
import { Db } from 'mongodb'

class BasketMapLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'

  constructor(public storageManager: BasketMapStorageManager) { }

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid payload')
    const { txid, outputIndex, topic, lockingScript } = payload
    if (topic !== 'tm_basketmap') return

    const { fields } = PushDrop.decode(lockingScript)

    const basketID = Utils.toUTF8(fields[0])
    const name = Utils.toUTF8(fields[1])
    const registryOperator = Utils.toUTF8(fields[5])

    const registration: BasketMapRegistration = { basketID, name, registryOperator }

    await this.storageManager.storeRecord(txid, outputIndex, registration)
  }

  async outputSpent(payload: OutputSpent): Promise<void> {
    if (payload.mode !== 'none') throw new Error('Invalid payload')
    const { topic, txid, outputIndex } = payload
    if (topic !== 'tm_basketmap') return
    await this.storageManager.deleteRecord(txid, outputIndex)
  }

  async outputEvicted(txid: string, outputIndex: number) {
    await this.storageManager.deleteRecord(txid, outputIndex)
  }

  async lookup(question: LookupQuestion): Promise<LookupFormula> {
    if (question.query === undefined || question.query === null) {
      throw new Error('A valid query must be provided!')
    }
    if (question.service !== 'ls_basketmap') {
      throw new Error('Lookup service not supported!')
    }

    const questionToAnswer = (question.query as BasketMapQuery)

    if (questionToAnswer.basketID !== undefined && questionToAnswer.registryOperators !== undefined) {
      return await this.storageManager.findById(questionToAnswer.basketID, questionToAnswer.registryOperators)
    } else if (questionToAnswer.name !== undefined && questionToAnswer.registryOperators !== undefined) {
      return await this.storageManager.findByName(questionToAnswer.name, questionToAnswer.registryOperators)
    } else {
      throw new Error('basketID, name, or registryOperator is missing!')
    }
  }

  async getDocumentation(): Promise<string> {
    return 'BasketMap Lookup Service: resolve basket names and IDs registered by registry operators.'
  }

  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'BasketMap Lookup Service',
      shortDescription: 'Basket name resolution'
    }
  }
}

export default (db: Db): BasketMapLookupService => new BasketMapLookupService(new BasketMapStorageManager(db))
