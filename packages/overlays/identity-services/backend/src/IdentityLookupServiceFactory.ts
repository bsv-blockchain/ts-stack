import { IdentityStorageManager } from './IdentityStorageManager.js'
import { AdmissionMode, LookupAnswer, LookupFormula, LookupQuestion, LookupService, OutputAdmittedByTopic, OutputSpent, SpendNotificationMode } from '@bsv/overlay'
import { ProtoWallet, PushDrop, Utils, VerifiableCertificate } from '@bsv/sdk'
import docs from './docs/IdentityLookupDocs.md.js'
import { IdentityQuery } from './types.js'
import { Db } from 'mongodb'

/**
 * Implements a lookup service for Identity key registry
 * @public
 */
class IdentityLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'
  private readonly anyoneWallet = new ProtoWallet('anyone')

  constructor(public storageManager: IdentityStorageManager) { }

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid payload')
    const { txid, outputIndex, topic, lockingScript } = payload
    if (topic !== 'tm_identity') return
    console.log(`Identity lookup service outputAdded called with ${txid}.${outputIndex}`)
    // Decode the Identity token fields from the Bitcoin outputScript
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

    // Decrypt certificate fields
    const decryptedFields = await certificate.decryptFields(this.anyoneWallet)
    if (Object.keys(decryptedFields).length === 0) throw new Error('No publicly revealed attributes present!')

    // Replace the certificate fields with the decrypted versions
    certificate.fields = decryptedFields

    console.log(
      'Identity lookup service is storing a record',
      txid,
      outputIndex,
      certificate
    )

    // Store identity certificate
    await this.storageManager.storeRecord(
      txid,
      outputIndex,
      certificate
    )
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
    console.log('Identity lookup with question', question)
    if (question.query === undefined || question.query === null) {
      throw new Error('A valid query must be provided!')
    }
    if (question.service !== 'ls_identity') {
      throw new Error('Lookup service not supported!')
    }

    const questionToAnswer = (question.query as IdentityQuery)
    const limit = questionToAnswer.limit
    const offset = questionToAnswer.offset
    let results

    // If a unique serialNumber is provided, use findByCertificateSerialNumber.
    if (
      questionToAnswer.serialNumber !== undefined
    ) {
      results = await this.storageManager.findByCertificateSerialNumber(
        questionToAnswer.serialNumber,
        limit,
        offset
      )
      console.log('Identity lookup returning this many results: ', results.length)
      return results
    }

    // Handle all available queries
    if (questionToAnswer.attributes !== undefined) {
      results = await this.storageManager.findByAttribute(
        questionToAnswer.attributes,
        questionToAnswer.certifiers,
        limit,
        offset
      )
      console.log('Identity lookup returning this many results: ', results.length)
      return results
    } else if (questionToAnswer.identityKey !== undefined && questionToAnswer.certificateTypes !== undefined) {
      results = await this.storageManager.findByCertificateType(
        questionToAnswer.certificateTypes,
        questionToAnswer.identityKey,
        questionToAnswer.certifiers,
        limit,
        offset
      )
      console.log('Identity lookup returning this many results: ', results.length)
      return results
    } else if (questionToAnswer.identityKey !== undefined) {
      results = await this.storageManager.findByIdentityKey(
        questionToAnswer.identityKey,
        questionToAnswer.certifiers,
        limit,
        offset
      )
      console.log('Identity lookup returning this many results: ', results.length)
      return results
    } else if (questionToAnswer.certifiers !== undefined) {
      results = await this.storageManager.findByCertifier(
        questionToAnswer.certifiers,
        limit,
        offset
      )
      console.log('Identity lookup returning this many results: ', results.length)
      return results
    } else {
      throw new Error('One of the following params is missing: attribute, identityKey, certifier, or certificateType')
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
      name: 'Identity Lookup Service',
      shortDescription: 'Identity resolution made easy.'
    }
  }
}

// Factory function
export default (db: Db): IdentityLookupService => {
  return new IdentityLookupService(new IdentityStorageManager(db))
}
