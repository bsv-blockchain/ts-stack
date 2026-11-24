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

import { decodeCanonicalPushDrop } from '@bsv/sdk'
import { SLAPStorage } from './SLAPStorage.js'
import { SLAPQuery } from '../types.js'
import SLAPLookupDocs from './SLAPLookup.docs.js'
import { isAdmissibleDiscoveryOutput } from '../utils/isAdmissibleDiscoveryOutput.js'
import { isValidTopicOrServiceName } from '../utils/isValidTopicOrServiceName.js'
import {
  definedProperties,
  MAX_DISCOVERY_LOOKUP_RESULTS,
  MAX_QUERY_NAME_BYTES,
  requireLookupQuery,
  validateOptionalBoolean,
  validateOptionalPublicKey,
  validateOptionalString,
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
    const { lockingScript, topic } = payload
    if (topic !== 'tm_slap') return
    const [txid, outputIndex] = validateCallbackOutpoint(payload.txid, payload.outputIndex)
    if (!(await isAdmissibleDiscoveryOutput(lockingScript, 'SLAP'))) return
    const result = decodeCanonicalPushDrop(lockingScript, {
      fieldCount: 5,
      maximumFieldBytes: 4096,
      maximumPayloadBytes: 8192
    })
    const protocol = toUTF8Strict(result.fields[0])
    const identityKey = toHex(result.fields[1])
    const domain = toUTF8Strict(result.fields[2])
    const service = toUTF8Strict(result.fields[3])
    if (protocol !== 'SLAP') return

    await this.storage.storeSLAPRecord(txid, outputIndex, identityKey, domain, service)
  }

  async outputSpent(payload: OutputSpent): Promise<void> {
    if (payload.mode !== 'none') throw new Error('Invalid payload')
    const { topic } = payload
    if (topic !== 'tm_slap') return
    const [txid, outputIndex] = validateCallbackOutpoint(payload.txid, payload.outputIndex)
    await this.storage.deleteSLAPRecord(txid, outputIndex)
  }

  async outputEvicted(txid: string, outputIndex: number): Promise<void> {
    const [validatedTxid, validatedOutputIndex] = validateCallbackOutpoint(txid, outputIndex)
    await this.storage.deleteSLAPRecord(validatedTxid, validatedOutputIndex)
  }

  async lookup(question: LookupQuestion): Promise<LookupFormula> {
    const query = requireLookupQuery(question, 'ls_slap', [
      'findAll',
      'domain',
      'service',
      'identityKey',
      'limit',
      'skip',
      'sortOrder'
    ])
    if (query === 'findAll') {
      return await this.storage.findAll(MAX_DISCOVERY_LOOKUP_RESULTS, 0, 'desc')
    }
    return await this.lookupObject(query as SLAPQuery)
  }

  private async lookupObject(query: SLAPQuery): Promise<LookupFormula> {
    const { limit, skip, sortOrder } = validatePaginationQuery(query)
    const findAll = validateOptionalBoolean(query.findAll, 'query.findAll')
    if (limit === 0) return []
    if (findAll) return await this.storage.findAll(limit, skip, sortOrder)

    const domain = validateOptionalString(query.domain, 'query.domain')
    const service = validateOptionalString(query.service, 'query.service', MAX_QUERY_NAME_BYTES)
    if (
      service !== undefined &&
      (!isValidTopicOrServiceName(service) || !service.startsWith('ls_'))
    ) {
      throw new Error('query.service must be a valid ls_ service name')
    }
    const identityKey = validateOptionalPublicKey(query.identityKey, 'query.identityKey')
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
