import { DIDStorageManager } from './DIDStorageManager.js'
import { AdmissionMode, LookupFormula, LookupQuestion, LookupService, OutputAdmittedByTopic, OutputSpent, SpendNotificationMode } from '@bsv/overlay'
import { PushDrop, Utils } from '@bsv/sdk'
import { DIDQuery } from './types.js'
import { Db } from 'mongodb'

class DIDLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'

  constructor(public storageManager: DIDStorageManager) { }

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid payload')
    const { txid, outputIndex, topic, lockingScript } = payload
    if (topic !== 'tm_did') return

    const result = PushDrop.decode(lockingScript)
    // Serial number is stored as base64-encoded bytes
    const serialNumber = Utils.toBase64(result.fields[0])

    await this.storageManager.storeRecord(txid, outputIndex, serialNumber)
  }

  async outputSpent(payload: OutputSpent): Promise<void> {
    if (payload.mode !== 'none') throw new Error('Invalid payload')
    const { topic, txid, outputIndex } = payload
    if (topic !== 'tm_did') return
    await this.storageManager.deleteRecord(txid, outputIndex)
  }

  async outputEvicted(txid: string, outputIndex: number): Promise<void> {
    await this.storageManager.deleteRecord(txid, outputIndex)
  }

  async lookup(question: LookupQuestion): Promise<LookupFormula> {
    if (question.query === undefined || question.query === null) {
      throw new Error('A valid query must be provided!')
    }
    if (question.service !== 'ls_did') {
      throw new Error('Lookup service not supported!')
    }

    const questionToAnswer = (question.query as DIDQuery)

    if (questionToAnswer.serialNumber != null) {
      return await this.storageManager.findByCertificateSerialNumber(questionToAnswer.serialNumber)
    }

    if (questionToAnswer.outpoint != null) {
      return await this.storageManager.findByOutpoint(questionToAnswer.outpoint)
    }

    throw new Error('No valid query parameters provided!')
  }

  async getDocumentation(): Promise<string> {
    return 'DID Lookup Service: resolve decentralized identifiers by serial number or outpoint.'
  }

  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'DID Lookup Service',
      shortDescription: 'DID resolution made easy.'
    }
  }
}

function create(db: Db): DIDLookupService { return new DIDLookupService(new DIDStorageManager(db)) }
export default create
