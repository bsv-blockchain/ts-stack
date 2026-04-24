import { CertMapStorageManager } from './CertMapStorageManager.js'
import { AdmissionMode, LookupFormula, LookupQuestion, LookupService, OutputAdmittedByTopic, OutputSpent, SpendNotificationMode } from '@bsv/overlay'
import { PushDrop, Utils } from '@bsv/sdk'
import { CertMapQuery, CertMapRegistration } from './types.js'
import { Db } from 'mongodb'

class CertMapLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'

  constructor(public storageManager: CertMapStorageManager) { }

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid payload')
    const { txid, outputIndex, topic, lockingScript } = payload
    if (topic !== 'tm_certmap') return

    const { fields } = PushDrop.decode(lockingScript)

    const type = Utils.toUTF8(fields[0])
    const name = Utils.toUTF8(fields[1])
    const registryOperator = Utils.toUTF8(fields[6])

    const registration: CertMapRegistration = { type, name, registryOperator }

    await this.storageManager.storeRecord(txid, outputIndex, registration)
  }

  async outputSpent(payload: OutputSpent): Promise<void> {
    if (payload.mode !== 'none') throw new Error('Invalid payload')
    const { topic, txid, outputIndex } = payload
    if (topic !== 'tm_certmap') return
    await this.storageManager.deleteRecord(txid, outputIndex)
  }

  async outputEvicted(txid: string, outputIndex: number) {
    await this.storageManager.deleteRecord(txid, outputIndex)
  }

  async lookup(question: LookupQuestion): Promise<LookupFormula> {
    if (question.query === undefined || question.query === null) {
      throw new Error('A valid query must be provided!')
    }
    if (question.service !== 'ls_certmap') {
      throw new Error('Lookup service not supported!')
    }

    const questionToAnswer = (question.query as CertMapQuery)

    if (questionToAnswer.type !== undefined && questionToAnswer.registryOperators !== undefined) {
      return await this.storageManager.findByType(questionToAnswer.type, questionToAnswer.registryOperators)
    } else if (questionToAnswer.name !== undefined && questionToAnswer.registryOperators !== undefined) {
      return await this.storageManager.findByName(questionToAnswer.name, questionToAnswer.registryOperators)
    } else {
      throw new Error('type, name, and registryOperator must be valid params')
    }
  }

  async getDocumentation(): Promise<string> {
    return 'CertMap Lookup Service: find certificate type registrations by type or name.'
  }

  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'CertMap Lookup Service',
      shortDescription: 'Certificate information registration'
    }
  }
}

export default (db: Db): CertMapLookupService => new CertMapLookupService(new CertMapStorageManager(db))
