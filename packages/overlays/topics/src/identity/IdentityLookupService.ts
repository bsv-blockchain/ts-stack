import { IdentityStorageManager } from './IdentityStorageManager.js'
import { AdmissionMode, LookupFormula, LookupQuestion, LookupService, OutputAdmittedByTopic, OutputSpent, SpendNotificationMode } from '@bsv/overlay'
import { ProtoWallet, PushDrop, Utils, VerifiableCertificate } from '@bsv/sdk'
import { IdentityQuery } from './types.js'
import { Db } from 'mongodb'

class IdentityLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'
  private readonly anyoneWallet = new ProtoWallet('anyone')

  constructor(public storageManager: IdentityStorageManager) { }

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid payload')
    const { txid, outputIndex, topic, lockingScript } = payload
    if (topic !== 'tm_identity') return

    const result = PushDrop.decode(lockingScript)
    const parsedCert = JSON.parse(Utils.toUTF8(result.fields[0]))
    const certificate = new VerifiableCertificate(
      parsedCert.type,
      parsedCert.serialNumber,
      parsedCert.subject,
      parsedCert.certifier,
      parsedCert.revocationOutpoint,
      parsedCert.fields,
      parsedCert.keyring
    )

    const decryptedFields = await certificate.decryptFields(this.anyoneWallet)
    if (Object.keys(decryptedFields).length === 0) throw new Error('No publicly revealed attributes present!')

    certificate.fields = decryptedFields

    await this.storageManager.storeRecord(txid, outputIndex, certificate)
  }

  async outputSpent(payload: OutputSpent): Promise<void> {
    if (payload.mode !== 'none') throw new Error('Invalid payload')
    const { topic, txid, outputIndex } = payload
    if (topic !== 'tm_identity') return
    await this.storageManager.deleteRecord(txid, outputIndex)
  }

  async outputEvicted(txid: string, outputIndex: number): Promise<void> {
    await this.storageManager.deleteRecord(txid, outputIndex)
  }

  async lookup(question: LookupQuestion): Promise<LookupFormula> {
    if (question.query === undefined || question.query === null) {
      throw new Error('A valid query must be provided!')
    }
    if (question.service !== 'ls_identity') {
      throw new Error('Lookup service not supported!')
    }

    const questionToAnswer = (question.query as IdentityQuery)
    const limit = questionToAnswer.limit
    const offset = questionToAnswer.offset

    if (questionToAnswer.serialNumber !== undefined) {
      return await this.storageManager.findByCertificateSerialNumber(questionToAnswer.serialNumber, limit, offset)
    }

    if (questionToAnswer.attributes !== undefined) {
      return await this.storageManager.findByAttribute(questionToAnswer.attributes, questionToAnswer.certifiers, limit, offset)
    } else if (questionToAnswer.identityKey !== undefined && questionToAnswer.certificateTypes !== undefined) {
      return await this.storageManager.findByCertificateType(questionToAnswer.certificateTypes, questionToAnswer.identityKey, questionToAnswer.certifiers, limit, offset)
    } else if (questionToAnswer.identityKey !== undefined) {
      return await this.storageManager.findByIdentityKey(questionToAnswer.identityKey, questionToAnswer.certifiers, limit, offset)
    } else if (questionToAnswer.certifiers !== undefined) {
      return await this.storageManager.findByCertifier(questionToAnswer.certifiers, limit, offset)
    } else {
      throw new Error('One of the following params is missing: attribute, identityKey, certifier, or certificateType')
    }
  }

  async getDocumentation(): Promise<string> {
    return 'Identity Lookup Service: find identity certificates by attribute, identity key, certifier, or certificate type.'
  }

  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'Identity Lookup Service',
      shortDescription: 'Identity resolution made easy.'
    }
  }
}

function create(db: Db): IdentityLookupService { return new IdentityLookupService(new IdentityStorageManager(db)) }
export default create
