import { WalletConfigStorageManager } from './WalletConfigStorageManager.js'
import { AdmissionMode, LookupFormula, LookupQuestion, LookupService, OutputAdmittedByTopic, OutputSpent, SpendNotificationMode } from '@bsv/overlay'
import { PushDrop, Utils } from '@bsv/sdk'
import { WalletConfigQuery, WalletConfigRegistration } from './WalletConfigTypes.js'
import { Db } from 'mongodb'

class WalletConfigLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'

  constructor(public storageManager: WalletConfigStorageManager) { }

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid payload')
    const { txid, outputIndex, topic, lockingScript } = payload
    if (topic !== 'tm_walletconfig') return

    const { fields } = PushDrop.decode(lockingScript)
    const configID = Utils.toUTF8(fields[0])
    const name = Utils.toUTF8(fields[1])
    const icon = Utils.toUTF8(fields[2])
    const wab = Utils.toUTF8(fields[3])
    const storage = Utils.toUTF8(fields[4])
    const messagebox = Utils.toUTF8(fields[5])
    const legal = Utils.toUTF8(fields[6])
    const registryOperator = Utils.toUTF8(fields[7])

    const registration: WalletConfigRegistration = { configID, name, icon, wab, storage, messagebox, legal, registryOperator }
    await this.storageManager.storeRecord(txid, outputIndex, registration)
  }

  async outputSpent(payload: OutputSpent): Promise<void> {
    if (payload.mode !== 'none') throw new Error('Invalid payload')
    const { topic, txid, outputIndex } = payload
    if (topic !== 'tm_walletconfig') return
    await this.storageManager.deleteRecord(txid, outputIndex)
  }

  async outputEvicted(txid: string, outputIndex: number) {
    await this.storageManager.deleteRecord(txid, outputIndex)
  }

  async lookup(question: LookupQuestion): Promise<LookupFormula> {
    if (question.query === undefined || question.query === null) throw new Error('A valid query must be provided!')
    if (question.service !== 'ls_walletconfig') throw new Error('Lookup service not supported!')

    const questionToAnswer = (question.query as WalletConfigQuery)
    if (!questionToAnswer.registryOperators || questionToAnswer.registryOperators.length === 0) {
      throw new Error('registryOperators must be provided!')
    }

    if (questionToAnswer.configID !== undefined) return await this.storageManager.findByConfigId(questionToAnswer.configID, questionToAnswer.registryOperators)
    if (questionToAnswer.name !== undefined) return await this.storageManager.findByName(questionToAnswer.name, questionToAnswer.registryOperators)
    if (questionToAnswer.wab !== undefined) return await this.storageManager.findByWab(questionToAnswer.wab, questionToAnswer.registryOperators)
    if (questionToAnswer.storage !== undefined) return await this.storageManager.findByStorage(questionToAnswer.storage, questionToAnswer.registryOperators)
    if (questionToAnswer.messagebox !== undefined) return await this.storageManager.findByMessagebox(questionToAnswer.messagebox, questionToAnswer.registryOperators)

    return await this.storageManager.listAll(questionToAnswer.registryOperators)
  }

  async getDocumentation(): Promise<string> {
    return 'WalletConfig Lookup Service: wallet configuration service discovery.'
  }

  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'WalletConfig Lookup Service',
      shortDescription: 'Wallet configuration service discovery'
    }
  }
}

export default (db: Db): WalletConfigLookupService => new WalletConfigLookupService(new WalletConfigStorageManager(db))
