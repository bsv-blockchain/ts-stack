import {
  LookupService,
  LookupQuestion,
  LookupFormula,
  AdmissionMode,
  OutputAdmittedByTopic,
  OutputSpent,
  SpendNotificationMode
} from '@bsv/overlay'

import { SHIPStorage } from './SHIPStorage.js'
import { PushDrop, Utils } from '@bsv/sdk'
import { SHIPQuery } from '../types.js'
import SHIPLookupDocs from './SHIPLookup.docs.js'
import {
  validateOptionalString,
  validateOptionalStringArray,
  validatePaginationQuery
} from '../utils/lookupQueryValidation.js'

/**
 * Implements the SHIP lookup service
 *
 * The SHIP lookup service allows querying for overlay services hosting specific topics
 * within the overlay network.
 */
export class SHIPLookupService implements LookupService {
  admissionMode: AdmissionMode = 'locking-script'
  spendNotificationMode: SpendNotificationMode = 'none'
  constructor(public storage: SHIPStorage) {}

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid payload')
    const { topic, lockingScript, txid, outputIndex } = payload
    if (topic !== 'tm_ship') return
    const result = PushDrop.decode(lockingScript)
    const shipIdentifier = Utils.toUTF8(result.fields[0])
    const identityKey = Utils.toHex(result.fields[1])
    const domain = Utils.toUTF8(result.fields[2])
    const topicSupported = Utils.toUTF8(result.fields[3])
    if (shipIdentifier !== 'SHIP') return

    await this.storage.storeSHIPRecord(txid, outputIndex, identityKey, domain, topicSupported)
  }

  async outputSpent(payload: OutputSpent): Promise<void> {
    if (payload.mode !== 'none') throw new Error('Invalid payload')
    const { topic, txid, outputIndex } = payload
    if (topic !== 'tm_ship') return
    await this.storage.deleteSHIPRecord(txid, outputIndex)
  }

  async outputEvicted(txid: string, outputIndex: number): Promise<void> {
    await this.storage.deleteSHIPRecord(txid, outputIndex)
  }

  async lookup(question: LookupQuestion): Promise<LookupFormula> {
    if (question.query === undefined || question.query === null) {
      throw new Error('A valid query must be provided!')
    }
    if (question.service !== 'ls_ship') {
      throw new Error('Lookup service not supported!')
    }

    if (question.query === 'findAll') return await this.storage.findAll()
    if (typeof question.query !== 'object') {
      throw new TypeError(
        'Invalid query format. Query must be "findAll" string or an object with valid parameters.'
      )
    }
    return await this.lookupObject(question.query as SHIPQuery)
  }

  private async lookupObject(query: SHIPQuery): Promise<LookupFormula> {
    validatePaginationQuery(query)
    const { limit, skip, sortOrder } = query
    if (query.findAll) return await this.storage.findAll(limit, skip, sortOrder)

    validateOptionalString(query.domain, 'query.domain')
    validateOptionalStringArray(query.topics, 'query.topics')
    validateOptionalString(query.identityKey, 'query.identityKey')
    const { domain, topics, identityKey } = query
    return await this.storage.findRecord({ domain, topics, identityKey, limit, skip, sortOrder })
  }

  async getDocumentation(): Promise<string> {
    return SHIPLookupDocs
  }

  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'SHIP Lookup Service',
      shortDescription: 'Provides lookup capabilities for SHIP tokens.'
    }
  }
}
