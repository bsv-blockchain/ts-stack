import { WalletConfigStorageManager } from './WalletConfigStorageManager.js'
import { AdmissionMode, LookupFormula, LookupQuestion, LookupService, OutputAdmittedByTopic, OutputSpent, SpendNotificationMode } from '@bsv/overlay'
import { PushDrop, Utils } from '@bsv/sdk'
import { WalletConfigQuery, WalletConfigRegistration } from './WalletConfigTypes.js'
import docs from './WalletConfigLookupServiceDocs.md.js'
import { Db } from 'mongodb'

/**
 * Implements a lookup service for WalletConfig registry
 * @public
 */
class WalletConfigLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'

  constructor(public storageManager: WalletConfigStorageManager) { }

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid payload')
    const { txid, outputIndex, topic, lockingScript } = payload
    if (topic !== 'tm_walletconfig') return

    // Decode the WalletConfig token fields from the Bitcoin outputScript
    const { fields } = PushDrop.decode(lockingScript)

    // Parse record data correctly from fields and validate it
    const configID = Utils.toUTF8(fields[0])
    const name = Utils.toUTF8(fields[1])
    const icon = Utils.toUTF8(fields[2])
    const wab = Utils.toUTF8(fields[3])
    const storage = Utils.toUTF8(fields[4])
    const messagebox = Utils.toUTF8(fields[5])
    const legal = Utils.toUTF8(fields[6])
    const registryOperator = Utils.toUTF8(fields[7])

    const registration: WalletConfigRegistration = {
      configID,
      name,
      icon,
      wab,
      storage,
      messagebox,
      legal,
      registryOperator
    }

    // Store wallet config registration (with duplicate check)
    await this.storageManager.storeRecord(
      txid,
      outputIndex,
      registration
    )
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
    // Validate Params
    if (question.query === undefined || question.query === null) {
      throw new Error('A valid query must be provided!')
    }

    if (question.service !== 'ls_walletconfig') {
      throw new Error('Lookup service not supported!')
    }

    const questionToAnswer = (question.query as WalletConfigQuery)

    // Validate that registryOperators is provided
    if (!questionToAnswer.registryOperators || questionToAnswer.registryOperators.length === 0) {
      throw new Error('registryOperators must be provided!')
    }

    let results

    // Query by configID
    if (questionToAnswer.configID !== undefined) {
      results = await this.storageManager.findByConfigId(
        questionToAnswer.configID,
        questionToAnswer.registryOperators
      )
      return results
    }

    // Query by name
    if (questionToAnswer.name !== undefined) {
      results = await this.storageManager.findByName(
        questionToAnswer.name,
        questionToAnswer.registryOperators
      )
      return results
    }

    // Query by wab
    if (questionToAnswer.wab !== undefined) {
      results = await this.storageManager.findByWab(
        questionToAnswer.wab,
        questionToAnswer.registryOperators
      )
      return results
    }

    // Query by storage
    if (questionToAnswer.storage !== undefined) {
      results = await this.storageManager.findByStorage(
        questionToAnswer.storage,
        questionToAnswer.registryOperators
      )
      return results
    }

    // Query by messagebox
    if (questionToAnswer.messagebox !== undefined) {
      results = await this.storageManager.findByMessagebox(
        questionToAnswer.messagebox,
        questionToAnswer.registryOperators
      )
      return results
    }

    // List all configs (when only registryOperators is provided)
    results = await this.storageManager.listAll(questionToAnswer.registryOperators)
    return results
  }

  async getDocumentation(): Promise<string> {
    return docs
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

// Factory function
export default (db: Db): WalletConfigLookupService => {
  return new WalletConfigLookupService(new WalletConfigStorageManager(db))
}
