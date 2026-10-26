import { BroadcastResponse, BroadcastFailure, Broadcaster } from '../Broadcaster.js'
import Transaction from '../Transaction.js'
import { HttpClient, HttpClientRequestOptions } from '../http/HttpClient.js'
import Random from '../../primitives/Random.js'
import { toHex } from '../../primitives/utils.js'
import { normalizeArcConfig, normalizeArcUrl, type ArcConfig } from './ArcConfigValidation.js'
import { hasControlCharacter, utf8ByteLength } from '../../primitives/UTF8.js'
import { lockConfiguration } from '../http/ConfigurationLock.js'

export type { ArcConfig } from './ArcConfigValidation.js'

function defaultDeploymentId(): string {
  return `ts-sdk-${toHex(Random(16))}`
}

const ARC_ERROR_STATUSES = new Set([
  'DOUBLE_SPEND_ATTEMPTED',
  'REJECTED',
  'INVALID',
  'MALFORMED',
  'MINED_IN_STALE_BLOCK'
])
const TXID = /^[0-9a-f]{64}$/i
const MAX_ARC_STATUS_BYTES = 128
const MAX_ARC_INFO_BYTES = 8192
const MAX_COMPETING_TXS = 256
const MAX_ARC_RESPONSE_PROPERTIES = 32
const ARC_ACCEPTED_STATUSES = new Set([
  'SUCCESS',
  'RECEIVED',
  'SENT_TO_NETWORK',
  'ANNOUNCED_TO_NETWORK',
  'ACCEPTED_BY_NETWORK',
  'SEEN_ON_NETWORK',
  'STORED',
  'MINED',
  'IMMUTABLE'
])

function boundedText(value: unknown, maximumBytes: number, allowEmpty = true): value is string {
  return (
    typeof value === 'string' &&
    (allowEmpty || value.length !== 0) &&
    utf8ByteLength(value) <= maximumBytes &&
    !hasControlCharacter(value)
  )
}

function ownArcData(value: unknown): Record<string, PropertyDescriptor> | undefined {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  const properties = Object.getOwnPropertyDescriptors(value)
  if (
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(properties).length > MAX_ARC_RESPONSE_PROPERTIES ||
    Object.values(properties).some(property => property.get != null || property.set != null)
  ) {
    return undefined
  }
  return properties
}

function snapshotCompetingTxs(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > MAX_COMPETING_TXS) return undefined
  const properties = Object.getOwnPropertyDescriptors(value)
  const expectedKeys = new Set([
    'length',
    ...Array.from({ length: value.length }, (_, index) => String(index))
  ])
  if (
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(properties).length !== expectedKeys.size ||
    Object.keys(properties).some(key => !expectedKeys.has(key)) ||
    Object.values(properties).some(property => property.get != null || property.set != null)
  ) {
    return undefined
  }
  const result: string[] = []
  const seen = new Set<string>()
  for (let index = 0; index < value.length; index++) {
    const candidate = properties[index]?.value
    if (typeof candidate !== 'string' || !TXID.test(candidate)) return undefined
    const normalized = candidate.toLowerCase()
    if (seen.has(normalized)) return undefined
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

function transactionHex(tx: Transaction): string {
  try {
    return tx.toHexEF()
  } catch (error) {
    if (
      (error as Error).message ===
      'All inputs must have source transactions when serializing to EF format'
    )
      return tx.toHex()
    throw error
  }
}

function invalidArcResponse(description: string): BroadcastFailure {
  return { status: 'error', code: 'ERR_INVALID_RESPONSE', description }
}

function successfulArcResponse(
  data: unknown,
  expectedTxid: string
): BroadcastResponse | BroadcastFailure {
  const properties = ownArcData(data)
  if (properties === undefined) {
    return invalidArcResponse('ARC returned a malformed response.')
  }
  const read = (name: string): unknown => properties[name]?.value
  const txid = read('txid')
  const extraInfo = read('extraInfo')
  const txStatus = read('txStatus')
  const competingValue = read('competingTxs')
  if (
    !boundedText(txStatus, MAX_ARC_STATUS_BYTES, false) ||
    (extraInfo !== undefined && !boundedText(extraInfo, MAX_ARC_INFO_BYTES))
  ) {
    return invalidArcResponse('ARC returned invalid transaction status metadata.')
  }
  const competingTxs = snapshotCompetingTxs(competingValue)
  if (competingValue !== undefined && competingTxs === undefined) {
    return invalidArcResponse('ARC returned invalid competing transaction identifiers.')
  }
  const upperStatus = txStatus.toUpperCase()
  const isOrphan = extraInfo?.toUpperCase().includes('ORPHAN') || upperStatus.includes('ORPHAN')
  if (ARC_ERROR_STATUSES.has(upperStatus) || isOrphan) {
    if (
      typeof txid === 'string' &&
      TXID.test(txid) &&
      txid.toLowerCase() !== expectedTxid.toLowerCase()
    ) {
      return {
        status: 'error',
        code: 'ERR_TXID_MISMATCH',
        description: 'ARC returned a failure for another transaction.'
      }
    }
    const failure: BroadcastFailure = {
      status: 'error',
      code: txStatus,
      description: `${txStatus} ${extraInfo ?? ''}`.trim()
    }
    if (typeof txid === 'string' && TXID.test(txid)) failure.txid = expectedTxid.toLowerCase()
    if (competingTxs != null) failure.more = { competingTxs }
    return failure
  }

  if (!ARC_ACCEPTED_STATUSES.has(upperStatus)) {
    return invalidArcResponse('ARC returned an unknown transaction status.')
  }

  if (
    typeof txid !== 'string' ||
    !TXID.test(txid) ||
    txid.toLowerCase() !== expectedTxid.toLowerCase()
  ) {
    return {
      status: 'error',
      code: 'ERR_TXID_MISMATCH',
      description: 'ARC acknowledged a transaction other than the submitted transaction.'
    }
  }

  const response: BroadcastResponse = {
    status: 'success',
    txid: expectedTxid,
    message: `${txStatus} ${extraInfo ?? ''}`.trim()
  }
  if (competingTxs != null) response.competingTxs = competingTxs
  return response
}

function parseArcFailureData(data: unknown): unknown {
  if (typeof data !== 'string') return data
  try {
    return JSON.parse(data)
  } catch {
    return data
  }
}

function failedArcResponse(
  status: unknown,
  responseData: unknown,
  expectedTxid?: string
): BroadcastFailure {
  const code =
    (typeof status === 'number' && Number.isSafeInteger(status)) ||
    (typeof status === 'string' && boundedText(status, MAX_ARC_STATUS_BYTES, false))
      ? status.toString()
      : 'ERR_UNKNOWN'
  const failure: BroadcastFailure = {
    status: 'error',
    code,
    description: 'Unknown error'
  }
  const data = parseArcFailureData(responseData)
  const properties = ownArcData(data)
  if (properties === undefined) return failure
  const detail = properties.detail?.value
  const txid = properties.txid?.value
  if (typeof txid === 'string' && TXID.test(txid)) {
    if (expectedTxid !== undefined && txid.toLowerCase() !== expectedTxid.toLowerCase()) {
      return {
        status: 'error',
        code: 'ERR_TXID_MISMATCH',
        description: 'ARC returned a failure for another transaction.'
      }
    }
    failure.txid = txid.toLowerCase()
  }
  const more: { detail?: string; txid?: string } = {}
  if (boundedText(detail, MAX_ARC_INFO_BYTES)) {
    failure.description = detail
    more.detail = detail
  }
  if (failure.txid !== undefined) more.txid = failure.txid
  if (Object.keys(more).length !== 0) failure.more = more
  return failure
}

function caughtArcResponse(): BroadcastFailure {
  return {
    status: 'error',
    code: '500',
    description: 'Internal Server Error'
  }
}

/**
 * Represents an ARC transaction broadcaster.
 */
export default class ARC implements Broadcaster {
  readonly URL: string
  readonly apiKey: string | undefined
  readonly deploymentId: string
  readonly callbackUrl: string | undefined
  readonly callbackToken: string | undefined
  readonly headers: Record<string, string> | undefined
  readonly #httpClient: HttpClient

  /**
   * Constructs an instance of the ARC broadcaster.
   *
   * @param {string} URL - The URL endpoint for the ARC API.
   * @param {ArcConfig} config - Configuration options for the ARC broadcaster.
   */
  constructor(URL: string, config?: ArcConfig)
  /**
   * Constructs an instance of the ARC broadcaster.
   *
   * @param {string} URL - The URL endpoint for the ARC API.
   * @param {string} apiKey - The API key used for authorization with the ARC API.
   */
  constructor(URL: string, apiKey?: string)

  constructor(URL: string, config?: string | ArcConfig) {
    this.URL = normalizeArcUrl(URL)
    const normalized = normalizeArcConfig(config, defaultDeploymentId)
    this.apiKey = normalized.apiKey
    this.#httpClient = normalized.httpClient
    this.deploymentId = normalized.deploymentId
    this.callbackToken = normalized.callbackToken
    this.callbackUrl = normalized.callbackUrl
    this.headers = normalized.headers
    lockConfiguration(this, [
      'URL',
      'apiKey',
      'deploymentId',
      'callbackUrl',
      'callbackToken',
      'headers'
    ])
  }

  /**
   * Constructs a dictionary of the default & supplied request headers.
   */
  #requestHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'XDeployment-ID': this.deploymentId
    }

    if (this.apiKey != null && this.apiKey !== '') {
      headers.Authorization = `Bearer ${this.apiKey}`
    }

    if (this.callbackUrl != null && this.callbackUrl !== '') {
      headers['X-CallbackUrl'] = this.callbackUrl
    }

    if (this.callbackToken != null && this.callbackToken !== '') {
      headers['X-CallbackToken'] = this.callbackToken
    }

    if (this.headers != null) {
      for (const [key, value] of Object.entries(this.headers)) {
        headers[key] = value
      }
    }

    return headers
  }

  /**
   * Broadcasts a transaction via ARC.
   *
   * @param {Transaction} tx - The transaction to be broadcasted.
   * @returns {Promise<BroadcastResponse | BroadcastFailure>} A promise that resolves to either a success or failure response.
   */
  async broadcast(tx: Transaction): Promise<BroadcastResponse | BroadcastFailure> {
    const requestOptions: HttpClientRequestOptions = {
      method: 'POST',
      headers: this.#requestHeaders(),
      data: { rawTx: transactionHex(tx) }
    }

    try {
      const response = await this.#httpClient.request<unknown>(`${this.URL}/v1/tx`, requestOptions)
      return response.ok
        ? successfulArcResponse(response.data, tx.id('hex'))
        : failedArcResponse(response.status, response.data, tx.id('hex'))
    } catch {
      return caughtArcResponse()
    }
  }

  /**
   * Broadcasts multiple transactions via ARC.
   * Handles mixed responses where some transactions succeed and others fail.
   *
   * @param {Transaction[]} txs - Array of transactions to be broadcasted.
   * @returns {Promise<Array<object>>} A promise that resolves to an array of objects.
   */
  async broadcastMany(txs: Transaction[]): Promise<object[]> {
    const rawTxs = txs.map(tx => ({ rawTx: transactionHex(tx) }))

    const requestOptions: HttpClientRequestOptions = {
      method: 'POST',
      headers: this.#requestHeaders(),
      data: rawTxs
    }

    try {
      const response = await this.#httpClient.request<object[]>(
        `${this.URL}/v1/txs`,
        requestOptions
      )
      if (!response.ok) {
        return txs.map(tx => failedArcResponse(response.status, response.data, tx.id('hex')))
      }
      if (!Array.isArray(response.data) || response.data.length !== txs.length) {
        return txs.map(() => invalidArcResponse('ARC returned a malformed batch response.'))
      }
      const responseProperties = Object.getOwnPropertyDescriptors(response.data)
      const expectedArrayKeys = new Set([
        'length',
        ...Array.from({ length: response.data.length }, (_, index) => String(index))
      ])
      if (
        Object.getOwnPropertySymbols(response.data).length !== 0 ||
        Object.keys(responseProperties).length !== expectedArrayKeys.size ||
        Object.keys(responseProperties).some(key => !expectedArrayKeys.has(key)) ||
        Object.values(responseProperties).some(
          property => property.get != null || property.set != null
        )
      ) {
        return txs.map(() => invalidArcResponse('ARC returned a malformed batch response.'))
      }
      const remaining = new Map<string, number>()
      for (const tx of txs) {
        const txid = tx.id('hex').toLowerCase()
        remaining.set(txid, (remaining.get(txid) ?? 0) + 1)
      }
      return Array.from({ length: response.data.length }, (_, index) => {
        const result = responseProperties[index]?.value
        const resultProperties = ownArcData(result)
        if (resultProperties === undefined) {
          return invalidArcResponse('ARC returned a malformed batch result.')
        }
        const txid = resultProperties.txid?.value
        const normalized = typeof txid === 'string' && TXID.test(txid) ? txid.toLowerCase() : ''
        const available = remaining.get(normalized) ?? 0
        if (available < 1) {
          return {
            status: 'error',
            code: 'ERR_TXID_MISMATCH',
            description: 'ARC batch acknowledged a transaction that was not submitted.'
          } satisfies BroadcastFailure
        }
        if (available === 1) remaining.delete(normalized)
        else remaining.set(normalized, available - 1)
        return successfulArcResponse(result, normalized)
      })
    } catch {
      const errorResponse = caughtArcResponse()
      return txs.map(() => errorResponse)
    }
  }
}
