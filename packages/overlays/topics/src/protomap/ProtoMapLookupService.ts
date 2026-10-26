import { ProtoMapStorageManager } from './ProtoMapStorageManager.js'
import {
  AdmissionMode,
  LookupFormula,
  LookupQuestion,
  LookupService,
  OutputAdmittedByTopic,
  OutputSpent,
  SpendNotificationMode
} from '@bsv/overlay'
import { ProtoMapRegistration } from './types.js'
import { Db } from 'mongodb'
import {
  readPublicKeyArray,
  readString,
  readWalletProtocol,
  requireLookupQuery
} from '../shared/queryValidation.js'
import {
  authenticateRegistryToken,
  registryText,
  validateRegistryProtocol
} from '../shared/registryTokenValidation.js'

export class ProtoMapLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'

  constructor(public storageManager: ProtoMapStorageManager) {}

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid payload')
    const { txid, outputIndex, topic, lockingScript } = payload
    if (topic !== 'tm_protomap') return

    const [serializedProtocolID, name, , , , registryOperator] = await authenticateRegistryToken(
      'protocol',
      lockingScript
    )
    const [securityLevel, protocol] = validateRegistryProtocol(serializedProtocolID)
    registryText(name, 'Protocol name', 1, 300)

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
    const query = requireLookupQuery(question, 'ls_protomap', [
      'name',
      'protocolID',
      'registryOperators'
    ])
    const name = readString(query, 'name', { maxBytes: 256 })
    const protocolID = readWalletProtocol(query, 'protocolID')
    const registryOperators = readPublicKeyArray(query, 'registryOperators', { maxItems: 32 })

    if (name !== undefined && registryOperators !== undefined) {
      return await this.storageManager.findByName(name, registryOperators)
    } else if (protocolID !== undefined && registryOperators !== undefined) {
      return await this.storageManager.findByProtocolID(protocolID, registryOperators)
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

function create(db: Db): ProtoMapLookupService {
  return new ProtoMapLookupService(new ProtoMapStorageManager(db))
}
export default create
