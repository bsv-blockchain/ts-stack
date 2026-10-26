import { BasketMapStorageManager } from './BasketMapStorageManager.js'
import {
  AdmissionMode,
  LookupFormula,
  LookupQuestion,
  LookupService,
  OutputAdmittedByTopic,
  OutputSpent,
  SpendNotificationMode
} from '@bsv/overlay'
import { BasketMapRegistration } from './types.js'
import { Db } from 'mongodb'
import { readPublicKeyArray, readString, requireLookupQuery } from '../shared/queryValidation.js'
import { authenticateRegistryToken, registryText } from '../shared/registryTokenValidation.js'

export class BasketMapLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'

  constructor(public storageManager: BasketMapStorageManager) {}

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid payload')
    const { txid, outputIndex, topic, lockingScript } = payload
    if (topic !== 'tm_basketmap') return

    const [basketID, name, , , , registryOperator] = await authenticateRegistryToken(
      'basket',
      lockingScript
    )
    registryText(basketID, 'Basket ID', 1, 300)
    registryText(name, 'Basket name', 1, 300)

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
    const query = requireLookupQuery(question, 'ls_basketmap', [
      'basketID',
      'name',
      'registryOperators'
    ])
    const basketID = readString(query, 'basketID', { maxBytes: 256 })
    const name = readString(query, 'name', { maxBytes: 256 })
    const registryOperators = readPublicKeyArray(query, 'registryOperators', { maxItems: 32 })

    if (basketID !== undefined && registryOperators !== undefined) {
      return await this.storageManager.findById(basketID, registryOperators)
    } else if (name !== undefined && registryOperators !== undefined) {
      return await this.storageManager.findByName(name, registryOperators)
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

function create(db: Db): BasketMapLookupService {
  return new BasketMapLookupService(new BasketMapStorageManager(db))
}
export default create
