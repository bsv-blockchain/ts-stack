import { toHex, toUTF8Strict } from '@bsv/sdk/primitives/utils'
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
import { decodeCanonicalPushDrop } from '@bsv/sdk'
import { SHIPQuery } from '../types.js'
import SHIPLookupDocs from './SHIPLookup.docs.js'
import { isAdmissibleDiscoveryOutput } from '../utils/isAdmissibleDiscoveryOutput.js'
import { isValidTopicOrServiceName } from '../utils/isValidTopicOrServiceName.js'
import {
  MAX_DISCOVERY_LOOKUP_RESULTS,
  requireLookupQuery,
  validateOptionalBoolean,
  validateOptionalPublicKey,
  validateOptionalString,
  validateOptionalStringArray,
  validatePaginationQuery
} from '../utils/lookupQueryValidation.js'

function validateCallbackOutpoint(txid: unknown, outputIndex: unknown): [string, number] {
  if (typeof txid !== 'string' || !/^[0-9a-fA-F]{64}$/.test(txid)) {
    throw new Error('Invalid callback transaction ID')
  }
  if (
    !Number.isSafeInteger(outputIndex) ||
    (outputIndex as number) < 0 ||
    (outputIndex as number) > 0xffffffff
  ) {
    throw new Error('Invalid callback output index')
  }
  return [txid.toLowerCase(), outputIndex as number]
}

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
    const { topic, lockingScript } = payload
    if (topic !== 'tm_ship') return
    const [txid, outputIndex] = validateCallbackOutpoint(payload.txid, payload.outputIndex)
    if (!(await isAdmissibleDiscoveryOutput(lockingScript, 'SHIP'))) return
    const result = decodeCanonicalPushDrop(lockingScript, {
      fieldCount: 5,
      maximumFieldBytes: 4096,
      maximumPayloadBytes: 8192
    })
    const shipIdentifier = toUTF8Strict(result.fields[0])
    const identityKey = toHex(result.fields[1])
    const domain = toUTF8Strict(result.fields[2])
    const topicSupported = toUTF8Strict(result.fields[3])
    if (shipIdentifier !== 'SHIP') return

    await this.storage.storeSHIPRecord(txid, outputIndex, identityKey, domain, topicSupported)
  }

  async outputSpent(payload: OutputSpent): Promise<void> {
    if (payload.mode !== 'none') throw new Error('Invalid payload')
    const { topic } = payload
    if (topic !== 'tm_ship') return
    const [txid, outputIndex] = validateCallbackOutpoint(payload.txid, payload.outputIndex)
    await this.storage.deleteSHIPRecord(txid, outputIndex)
  }

  async outputEvicted(txid: string, outputIndex: number): Promise<void> {
    const [validatedTxid, validatedOutputIndex] = validateCallbackOutpoint(txid, outputIndex)
    await this.storage.deleteSHIPRecord(validatedTxid, validatedOutputIndex)
  }

  async lookup(question: LookupQuestion): Promise<LookupFormula> {
    const query = requireLookupQuery(question, 'ls_ship', [
      'findAll',
      'domain',
      'topics',
      'identityKey',
      'limit',
      'skip',
      'sortOrder'
    ])
    if (query === 'findAll') {
      return await this.storage.findAll(MAX_DISCOVERY_LOOKUP_RESULTS, 0, 'desc')
    }
    return await this.lookupObject(query as SHIPQuery)
  }

  private async lookupObject(query: SHIPQuery): Promise<LookupFormula> {
    const { limit, skip, sortOrder } = validatePaginationQuery(query)
    const findAll = validateOptionalBoolean(query.findAll, 'query.findAll')
    if (limit === 0) return []
    if (findAll) return await this.storage.findAll(limit, skip, sortOrder)

    const domain = validateOptionalString(query.domain, 'query.domain')
    const topics = validateOptionalStringArray(query.topics, 'query.topics')
    if (topics?.some(topic => !isValidTopicOrServiceName(topic) || !topic.startsWith('tm_'))) {
      throw new Error('query.topics must contain only valid tm_ topic names')
    }
    const identityKey = validateOptionalPublicKey(query.identityKey, 'query.identityKey')
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
