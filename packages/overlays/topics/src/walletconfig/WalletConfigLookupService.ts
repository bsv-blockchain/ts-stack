import { WalletConfigStorageManager } from './WalletConfigStorageManager.js'
import {
  AdmissionMode,
  LookupFormula,
  LookupQuestion,
  LookupService,
  OutputAdmittedByTopic,
  OutputSpent,
  SpendNotificationMode
} from '@bsv/overlay'
import { WalletConfigRegistration } from './WalletConfigTypes.js'
import { Db } from 'mongodb'
import { readPublicKeyArray, readString, requireLookupQuery } from '../shared/queryValidation.js'
import {
  authenticateSignedRegistryToken,
  registryText,
  registryUrl
} from '../shared/registryTokenValidation.js'

export class WalletConfigLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'

  constructor(public storageManager: WalletConfigStorageManager) {}

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid payload')
    const { txid, outputIndex, topic, lockingScript } = payload
    if (topic !== 'tm_walletconfig') return

    const [configID, name, icon, wab, storage, messagebox, legal, registryOperator] =
      await authenticateSignedRegistryToken(lockingScript, 8, [1, 'wallet config option'])
    registryText(configID, 'Wallet config ID', 1, 300)
    registryText(name, 'Wallet config name', 1, 300)
    registryUrl(icon, 'Wallet config icon')
    registryUrl(wab, 'WAB URL')
    registryUrl(storage, 'Storage URL')
    registryUrl(messagebox, 'Message Box URL')
    registryUrl(legal, 'Legal URL')

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
    const query = requireLookupQuery(question, 'ls_walletconfig', [
      'configID',
      'name',
      'wab',
      'storage',
      'messagebox',
      'registryOperators'
    ])
    const registryOperators = readPublicKeyArray(query, 'registryOperators', { maxItems: 32 })
    if (registryOperators === undefined) {
      throw new Error('registryOperators must be provided!')
    }
    const configID = readString(query, 'configID', { maxBytes: 256 })
    const name = readString(query, 'name', { maxBytes: 256 })
    const wab = readString(query, 'wab', { maxBytes: 2048 })
    const storage = readString(query, 'storage', { maxBytes: 2048 })
    const messagebox = readString(query, 'messagebox', { maxBytes: 2048 })

    if (configID !== undefined)
      return await this.storageManager.findByConfigId(configID, registryOperators)
    if (name !== undefined) return await this.storageManager.findByName(name, registryOperators)
    if (wab !== undefined) return await this.storageManager.findByWab(wab, registryOperators)
    if (storage !== undefined)
      return await this.storageManager.findByStorage(storage, registryOperators)
    if (messagebox !== undefined)
      return await this.storageManager.findByMessagebox(messagebox, registryOperators)

    return await this.storageManager.listAll(registryOperators)
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

function create(db: Db): WalletConfigLookupService {
  return new WalletConfigLookupService(new WalletConfigStorageManager(db))
}
export default create
