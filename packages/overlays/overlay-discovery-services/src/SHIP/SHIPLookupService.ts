import { LookupService, LookupQuestion, LookupAnswer, LookupFormula, AdmissionMode, OutputAdmittedByTopic, OutputSpent, SpendNotificationMode } from '@bsv/overlay'
import { SHIPStorage } from './SHIPStorage.js'
import { PushDrop, Utils } from '@bsv/sdk'
import { SHIPQuery } from '../types.js'
import SHIPLookupDocs from './SHIPLookup.docs.js'

/**
 * Implements the SHIP lookup service
 *
 * The SHIP lookup service allows querying for overlay services hosting specific topics
 * within the overlay network.
 */
export class SHIPLookupService implements LookupService {
  admissionMode: AdmissionMode = 'locking-script'
  spendNotificationMode: SpendNotificationMode = 'none'
  constructor (public storage: SHIPStorage) { }

  async outputAdmittedByTopic (payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') throw new Error('Invalid payload')
    const { topic, lockingScript, txid, outputIndex } = payload
    if (topic !== 'tm_ship') return
    const result = PushDrop.decode(lockingScript)
    const shipIdentifier = Utils.toUTF8(result.fields[0])
    const identityKey = Utils.toHex(result.fields[1])
    const domain = Utils.toUTF8(result.fields[2])
    const topicSupported = Utils.toUTF8(result.fields[3])
    if (shipIdentifier !== 'SHIP') return

    // Check for duplicates before storing
    const isDuplicate = await this.storage.hasDuplicateRecord(identityKey, domain, topicSupported)
    if (isDuplicate) {
      console.log(`🚢 Skipping duplicate SHIP record: ${domain} / ${topicSupported}`)
      return
    }

    await this.storage.storeSHIPRecord(txid, outputIndex, identityKey, domain, topicSupported)
  }

  async outputSpent (payload: OutputSpent): Promise<void> {
    if (payload.mode !== 'none') throw new Error('Invalid payload')
    const { topic, txid, outputIndex } = payload
    if (topic !== 'tm_ship') return
    await this.storage.deleteSHIPRecord(txid, outputIndex)
  }

  async outputEvicted (txid: string, outputIndex: number): Promise<void> {
    await this.storage.deleteSHIPRecord(txid, outputIndex)
  }

  async lookup (question: LookupQuestion): Promise<LookupFormula> {
    if (question.query === undefined || question.query === null) {
      throw new Error('A valid query must be provided!')
    }
    if (question.service !== 'ls_ship') {
      throw new Error('Lookup service not supported!')
    }

    // Handle legacy "findAll" string query
    if (question.query === 'findAll') {
      return await this.storage.findAll()
    }

    // Handle object-based query
    if (typeof question.query === 'object') {
      const query = question.query as SHIPQuery

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

      // Handle specific query with domain, topics, identityKey
      const { domain, topics, identityKey, limit, skip, sortOrder } = query

      // Validate query parameters
      if (typeof domain !== 'string' && typeof domain !== 'undefined') {
        throw new Error('query.domain must be a string if provided')
      }
      if (!Array.isArray(topics) && typeof topics !== 'undefined') {
        throw new Error('query.topics must be an array of strings if provided')
      }
      if (typeof identityKey !== 'string' && typeof identityKey !== 'undefined') {
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

      return await this.storage.findRecord({ domain, topics, identityKey, limit, skip, sortOrder })
    }

    throw new Error('Invalid query format. Query must be "findAll" string or an object with valid parameters.')
  }

  async getDocumentation (): Promise<string> {
    return SHIPLookupDocs
  }

  async getMetaData (): Promise<{
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
