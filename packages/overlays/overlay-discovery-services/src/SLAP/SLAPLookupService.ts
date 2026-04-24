import { LookupService, LookupQuestion, LookupAnswer, LookupFormula, AdmissionMode, OutputAdmittedByTopic, OutputSpent, SpendNotificationMode } from '@bsv/overlay'
import { PushDrop, Utils } from '@bsv/sdk'
import { SLAPStorage } from './SLAPStorage.js'
import { SLAPQuery } from '../types.js'
import SLAPLookupDocs from './SLAPLookup.docs.js'

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
  constructor (public storage: SLAPStorage) { }

  async outputAdmittedByTopic (payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid mode')
    const { txid, outputIndex, lockingScript, topic } = payload
    if (topic !== 'tm_slap') return
    const result = PushDrop.decode(lockingScript)
    const protocol = Utils.toUTF8(result.fields[0])
    const identityKey = Utils.toHex(result.fields[1])
    const domain = Utils.toUTF8(result.fields[2])
    const service = Utils.toUTF8(result.fields[3])
    if (protocol !== 'SLAP') return

    // Check for duplicates before storing
    const isDuplicate = await this.storage.hasDuplicateRecord(identityKey, domain, service)
    if (isDuplicate) {
      console.log(`👏 Skipping duplicate SLAP record: ${domain} / ${service}`)
      return
    }

    await this.storage.storeSLAPRecord(txid, outputIndex, identityKey, domain, service)
  }

  async outputSpent (payload: OutputSpent): Promise<void> {
    if (payload.mode !== 'none') throw new Error('Invalid payload')
    const { topic, txid, outputIndex } = payload
    if (topic !== 'tm_slap') return
    await this.storage.deleteSLAPRecord(txid, outputIndex)
  }

  async outputEvicted (txid: string, outputIndex: number): Promise<void> {
    await this.storage.deleteSLAPRecord(txid, outputIndex)
  }

  async lookup (question: LookupQuestion): Promise<LookupFormula> {
    if (question.query === undefined || question.query === null) {
      throw new Error('A valid query must be provided!')
    }
    if (question.service !== 'ls_slap') {
      throw new Error('Lookup service not supported!')
    }

    // Handle legacy "findAll" string query
    if (question.query === 'findAll') {
      return await this.storage.findAll()
    }

    // Handle object-based query
    if (typeof question.query === 'object') {
      const query = question.query as SLAPQuery

      // Handle new findAll mode with pagination
      if (query.findAll) {
        const { limit, skip, sortOrder } = query

        // Validate pagination parameters
        if (typeof limit !== 'undefined' && (typeof limit !== 'number' || limit < 0)) {
          throw new Error('query.limit must be a positive number if provided')
        }
        if (typeof skip !== 'undefined' && (typeof skip !== 'number' || skip < 0)) {
          throw new Error('query.skip must be a non-negative number if provided')
        }
        if (typeof sortOrder !== 'undefined' && sortOrder !== 'asc' && sortOrder !== 'desc') {
          throw new Error('query.sortOrder must be "asc" or "desc" if provided')
        }

        return await this.storage.findAll(limit, skip, sortOrder)
      }

      // Handle specific query with domain, service, identityKey
      const { domain, service, identityKey, limit, skip, sortOrder } = query

      // Validate query parameters
      if (typeof domain !== 'undefined' && typeof domain !== 'string') {
        throw new Error('query.domain must be a string if provided')
      }
      if (typeof service !== 'undefined' && typeof service !== 'string') {
        throw new Error('query.service must be a string if provided')
      }
      if (typeof identityKey !== 'undefined' && typeof identityKey !== 'string') {
        throw new Error('query.identityKey must be a string if provided')
      }

      // Validate pagination parameters
      if (typeof limit !== 'undefined' && (typeof limit !== 'number' || limit < 0)) {
        throw new Error('query.limit must be a positive number if provided')
      }
      if (typeof skip !== 'undefined' && (typeof skip !== 'number' || skip < 0)) {
        throw new Error('query.skip must be a non-negative number if provided')
      }
      if (typeof sortOrder !== 'undefined' && sortOrder !== 'asc' && sortOrder !== 'desc') {
        throw new Error('query.sortOrder must be "asc" or "desc" if provided')
      }

      // Build the query object dynamically to omit any undefined values
      const queryParams: Partial<SLAPQuery> = {}
      if (domain !== undefined) queryParams.domain = domain
      if (service !== undefined) queryParams.service = service
      if (identityKey !== undefined) queryParams.identityKey = identityKey
      if (limit !== undefined) queryParams.limit = limit
      if (skip !== undefined) queryParams.skip = skip
      if (sortOrder !== undefined) queryParams.sortOrder = sortOrder

      return await this.storage.findRecord(queryParams)
    }

    throw new Error('Invalid query format. Query must be "findAll" string or an object with valid parameters.')
  }

  async getDocumentation (): Promise<string> {
    return SLAPLookupDocs
  }

  async getMetaData (): Promise<{
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
