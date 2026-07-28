import {
  LookupService,
  LookupQuestion,
  LookupFormula,
  AdmissionMode,
  OutputAdmittedByTopic,
  OutputSpent,
  SpendNotificationMode
} from '@bsv/overlay'

import { PushDrop, Utils } from '@bsv/sdk'
import { SLAPStorage } from './SLAPStorage.js'
import { SLAPQuery } from '../types.js'
import SLAPLookupDocs from './SLAPLookup.docs.js'
import {
  definedProperties,
  validateOptionalString,
  validatePaginationQuery
} from '../utils/lookupQueryValidation.js'

/**
 * Implements the SLAP lookup service
 *
 * The SLAP lookup service allows querying for service availability within the
 * overlay network. This service listens for SLAP-related UTXOs and stores relevant
 * records for lookup purposes.
 */
export class SLAPLookupService implements LookupService {
  admissionMode: AdmissionMode = 'locking-script'
  spendNotificationMode: SpendNotificationMode = 'none'
  constructor(public storage: SLAPStorage) {}

  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid mode')
    const { txid, outputIndex, lockingScript, topic } = payload
    if (topic !== 'tm_slap') return
    const result = PushDrop.decode(lockingScript)
    const protocol = Utils.toUTF8(result.fields[0])
    const identityKey = Utils.toHex(result.fields[1])
    const domain = Utils.toUTF8(result.fields[2])
    const service = Utils.toUTF8(result.fields[3])
    if (protocol !== 'SLAP') return

    await this.storage.storeSLAPRecord(txid, outputIndex, identityKey, domain, service)
  }

  async outputSpent(payload: OutputSpent): Promise<void> {
    if (payload.mode !== 'none') throw new Error('Invalid payload')
    const { topic, txid, outputIndex } = payload
    if (topic !== 'tm_slap') return
    await this.storage.deleteSLAPRecord(txid, outputIndex)
  }

  async outputEvicted(txid: string, outputIndex: number): Promise<void> {
    await this.storage.deleteSLAPRecord(txid, outputIndex)
  }

  async lookup(question: LookupQuestion): Promise<LookupFormula> {
    if (question.query === undefined || question.query === null) {
      throw new Error('A valid query must be provided!')
    }
    if (question.service !== 'ls_slap') {
      throw new Error('Lookup service not supported!')
    }

    if (question.query === 'findAll') return await this.storage.findAll()
    if (typeof question.query !== 'object') {
      throw new Error(
        'Invalid query format. Query must be "findAll" string or an object with valid parameters.'
      )
    }
    return await this.lookupObject(question.query as SLAPQuery)
  }

  private async lookupObject(query: SLAPQuery): Promise<LookupFormula> {
    validatePaginationQuery(query)
    const { limit, skip, sortOrder } = query
    if (query.findAll) return await this.storage.findAll(limit, skip, sortOrder)

    validateOptionalString(query.domain, 'query.domain')
    validateOptionalString(query.service, 'query.service')
    validateOptionalString(query.identityKey, 'query.identityKey')
    const { domain, service, identityKey } = query
    const queryParams = definedProperties({ domain, service, identityKey, limit, skip, sortOrder })
    return await this.storage.findRecord(queryParams)
  }

  async getDocumentation(): Promise<string> {
    return SLAPLookupDocs
  }

  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'SLAP Lookup Service',
      shortDescription: 'Provides lookup capabilities for SLAP tokens.'
    }
  }
}
