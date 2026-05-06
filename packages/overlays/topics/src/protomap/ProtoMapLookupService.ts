import { ProtoMapStorageManager } from './ProtoMapStorageManager.js'
import { AdmissionMode, LookupFormula, LookupQuestion, LookupService, OutputAdmittedByTopic, OutputSpent, SpendNotificationMode } from '@bsv/overlay'
import { PushDrop, Utils } from '@bsv/sdk'

import { ProtoMapQuery, ProtoMapRegistration } from './types.js'
import { Db } from 'mongodb'
import { deserializeWalletProtocol } from './ProtoMapTopicManager.js'

class ProtoMapLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'

  constructor(public storageManager: ProtoMapStorageManager) { }

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid payload')
    const { txid, outputIndex, topic, lockingScript } = payload
    if (topic !== 'tm_protomap') return

    const { fields } = PushDrop.decode(lockingScript)

    const [securityLevel, protocol] = deserializeWalletProtocol(Utils.toUTF8(fields[0]))
    const name = Utils.toUTF8(fields[1])
    const registryOperator = Utils.toUTF8(fields[5])

    const registration: ProtoMapRegistration = {
      registryOperator,
      protocolID: { securityLevel: Number(securityLevel), protocol },
      name
    }

    await this.storageManager.storeRecord(txid, outputIndex, registration)
  }

  async outputSpent(payload: OutputSpent): Promise<void> {
    if (payload.mode !== 'none') throw new Error('Invalid payload')
    const { topic, txid, outputIndex } = payload
    if (topic !== 'tm_protomap') return
    await this.storageManager.deleteRecord(txid, outputIndex)
  }

  async outputEvicted(txid: string, outputIndex: number) {
    await this.storageManager.deleteRecord(txid, outputIndex)
  }

  async lookup(question: LookupQuestion): Promise<LookupFormula> {
    if (question.query === undefined || question.query === null) {
      throw new Error('A valid query must be provided!')
    }
    if (question.service !== 'ls_protomap') {
      throw new Error('Lookup service not supported!')
    }

    const questionToAnswer = (question.query as ProtoMapQuery)

    if (questionToAnswer.name !== undefined && questionToAnswer.registryOperators !== undefined) {
      return await this.storageManager.findByName(questionToAnswer.name, questionToAnswer.registryOperators)
    } else if (questionToAnswer.protocolID && questionToAnswer.registryOperators !== undefined) {
      return await this.storageManager.findByProtocolID(questionToAnswer.protocolID, questionToAnswer.registryOperators)
    } else {
      throw new Error('name, registryOperators, or protocolID must be valid params')
    }
  }

  async getDocumentation(): Promise<string> {
    return 'ProtoMap Lookup Service: find protocol registrations by name or protocol ID.'
  }

  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'ls_protomap',
      shortDescription: 'Protocol name resolution'
    }
  }
}

export default (db: Db): ProtoMapLookupService => new ProtoMapLookupService(new ProtoMapStorageManager(db))
