import { CertMapStorageManager } from './CertMapStorageManager.js'
import {
  AdmissionMode,
  LookupFormula,
  LookupQuestion,
  LookupService,
  OutputAdmittedByTopic,
  OutputSpent,
  SpendNotificationMode
} from '@bsv/overlay'
import { CertMapRegistration } from './types.js'
import { Db } from 'mongodb'
import { readPublicKeyArray, readString, requireLookupQuery } from '../shared/queryValidation.js'
import { authenticateRegistryToken, registryText } from '../shared/registryTokenValidation.js'

export class CertMapLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'

  constructor(public storageManager: CertMapStorageManager) {}

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid payload')
    const { txid, outputIndex, topic, lockingScript } = payload
    if (topic !== 'tm_certmap') return

    const [type, name, , , , , registryOperator] = await authenticateRegistryToken(
      'certificate',
      lockingScript
    )
    registryText(type, 'Certificate type', 1, 300)
    registryText(name, 'Certificate name', 1, 300)

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
    const query = requireLookupQuery(question, 'ls_certmap', ['type', 'name', 'registryOperators'])
    const type = readString(query, 'type', { maxBytes: 256 })
    const name = readString(query, 'name', { maxBytes: 256 })
    const registryOperators = readPublicKeyArray(query, 'registryOperators', { maxItems: 32 })

    if (type !== undefined && registryOperators !== undefined) {
      return await this.storageManager.findByType(type, registryOperators)
    } else if (name !== undefined && registryOperators !== undefined) {
      return await this.storageManager.findByName(name, registryOperators)
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

function create(db: Db): CertMapLookupService {
  return new CertMapLookupService(new CertMapStorageManager(db))
}
export default create
