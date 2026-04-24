import { BasketMapStorageManager } from './BasketMapStorageManager.js'
import { AdmissionMode, LookupAnswer, LookupFormula, LookupQuestion, LookupService, OutputAdmittedByTopic, OutputSpent, SpendNotificationMode } from '@bsv/overlay'
import { Script, PushDrop, Utils } from '@bsv/sdk'
import { BasketMapQuery, BasketMapRegistration } from './interfaces/BasketMapTypes.js'
import docs from './docs/BasketMapLookupDocs.md.js'
import { Db } from 'mongodb'

/**
 * Implements a lookup service for BasketMap name registry
 * @public
 */
class BasketMapLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'

  constructor(public storageManager: BasketMapStorageManager) { }

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid payload')
    const { txid, outputIndex, topic, lockingScript } = payload
    if (topic !== 'tm_basketmap') return

    // Decode the BasketMap token fields from the Bitcoin outputScript
    const { fields } = PushDrop.decode(lockingScript)

    // Parse record data correctly from field and validate it
    const basketID = Utils.toUTF8(fields[0])
    const name = Utils.toUTF8(fields[1])
    const registryOperator = Utils.toUTF8(fields[5])

    const registration: BasketMapRegistration = {
      basketID,
      name,
      registryOperator
    }

    // Store Basket type registration
    await this.storageManager.storeRecord(
      txid,
      outputIndex,
      registration
    )
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
    // Validate Params
    if (question.query === undefined || question.query === null) {
      throw new Error('A valid query must be provided!')
    }

    if (question.service !== 'ls_basketmap') {
      throw new Error('Lookup service not supported!')
    }

    const questionToAnswer = (question.query as BasketMapQuery)

    let results
    if (questionToAnswer.basketID !== undefined && questionToAnswer.registryOperators !== undefined) {
      results = await this.storageManager.findById(
        questionToAnswer.basketID,
        questionToAnswer.registryOperators
      )
      return results
    } else if (questionToAnswer.name !== undefined && questionToAnswer.registryOperators !== undefined) {
      results = await this.storageManager.findByName(
        questionToAnswer.name,
        questionToAnswer.registryOperators
      )
      return results
    } else {
      throw new Error('basketID, name, or registryOperator is missing!')
    }
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
      name: 'BasketMap Lookup Service',
      shortDescription: 'Basket name resolution'
    }
  }
}

// Factory function
export default (db: Db): BasketMapLookupService => {
  return new BasketMapLookupService(new BasketMapStorageManager(db))
}
