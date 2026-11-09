import type { BroadcastResponse, BroadcastFailure, Broadcaster } from '../Broadcaster.js'
import Transaction from '../Transaction.js'
import { binaryHttpClient } from '../http/BinaryFetchClient.js'
import type { HttpClient } from '../http/HttpClient.js'
import {
  normalizeBroadcasterHttpClient,
  normalizeBroadcasterUrl,
  providerDiagnostic,
  providerStatusCode,
  TRANSACTION_ID
} from './BroadcasterValidation.js'
import { lockConfiguration } from '../http/ConfigurationLock.js'
import { hasControlCharacter, utf8ByteLength } from '../../primitives/UTF8.js'

// Statuses an ARC-style service (such as BSV Broadcaster) may answer with a 2xx
// that still mean the transaction was not accepted; the same set ARC treats as
// failures.
const FAILED_TX_STATUSES = new Set([
  'DOUBLE_SPEND_ATTEMPTED',
  'REJECTED',
  'INVALID',
  'MALFORMED',
  'MINED_IN_STALE_BLOCK'
])
const MAX_STATUS_BYTES = 128
const MAX_INFO_BYTES = 8192

function boundedText(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length !== 0 &&
    utf8ByteLength(value) <= maximumBytes &&
    !hasControlCharacter(value)
  )
}

/** Own data fields of a JSON object body, or undefined for any other body. */
function statusBody(data: unknown): Record<string, unknown> | undefined {
  let value = data
  if (typeof value === 'string') {
    if (!value.trimStart().startsWith('{')) return undefined
    try {
      value = JSON.parse(value)
    } catch {
      return undefined
    }
  }
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  const fields: Record<string, unknown> = Object.create(null)
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if ('value' in descriptor) fields[name] = descriptor.value
  }
  return fields
}

/**
 * Represents an Teranode transaction broadcaster.
 */
export default class Teranode implements Broadcaster {
  readonly URL: string
  readonly httpClient: HttpClient

  /**
   * Constructs an instance of the Teranode broadcaster.
   *
   * @param {string} URL - The URL endpoint for the Teranode API.
   * @param {HttpClient} httpClient - The HTTP client used to make requests to the API, binaryHttpClient by default.
   */
  constructor(URL: string, httpClient: HttpClient = binaryHttpClient()) {
    this.URL = normalizeBroadcasterUrl(URL, 'Teranode URL')
    this.httpClient = normalizeBroadcasterHttpClient(httpClient, 'Teranode httpClient')
    lockConfiguration(this, ['URL', 'httpClient'])
  }

  /**
   * Broadcasts a transaction via Teranode.
   *
   * A bare 2xx (a Teranode node answers `OK` or nothing) is reported as
   * `broadcast successful`. When the endpoint answers an ARC-style JSON body
   * with a `txStatus` (for example BSV Broadcaster's `POST /tx`), the success
   * message carries that status, so `RECEIVED` (taken in, not yet validated)
   * can be told apart from `SEEN_ON_NETWORK` or `MINED`; a refusal status or a
   * body naming another transaction is returned as a failure. A non-2xx keeps
   * the HTTP status as `code` and adds the body's ARC `status` and `detail`
   * under `more`.
   *
   * @param {Transaction} tx - The transaction to be broadcasted.
   * @returns {Promise<BroadcastResponse | BroadcastFailure>} A promise that resolves to either a success or failure response.
   */
  async broadcast(tx: Transaction): Promise<BroadcastResponse | BroadcastFailure> {
    const rawTx = tx.toEF()
    const requestOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream'
      },
      data: new Blob([new Uint8Array(rawTx)])
    }
    try {
      const response = await this.httpClient.request<unknown>(this.URL, requestOptions)
      if (response.ok) {
        const txid = tx.id('hex')
        if (typeof txid !== 'string' || !TRANSACTION_ID.test(txid)) {
          return {
            status: 'error',
            code: 'ERR_INVALID_RESPONSE',
            description: 'Transaction produced an invalid identifier.'
          }
        }
        return successfulResponse(response.data, txid.toLowerCase())
      } else {
        return failedResponse(response.status, response.data, tx)
      }
    } catch {
      return {
        status: 'error',
        code: '500',
        description: 'Internal Server Error'
      }
    }
  }
}

/**
 * A Teranode node answers a bare 2xx, which stays a plain success. An ARC-style
 * service answers a JSON body whose txStatus distinguishes "received, not yet
 * validated" from network acceptance and from a refusal, so it is reported.
 */
function successfulResponse(data: unknown, txid: string): BroadcastResponse | BroadcastFailure {
  const body = statusBody(data)
  const txStatus = body?.txStatus
  if (body === undefined || !boundedText(txStatus, MAX_STATUS_BYTES)) {
    return { status: 'success', txid, message: 'broadcast successful' }
  }
  const echoed = body.txid
  if (typeof echoed === 'string' && echoed.toLowerCase() !== txid) {
    return {
      status: 'error',
      code: 'ERR_TXID_MISMATCH',
      description: 'Teranode acknowledged a transaction other than the submitted transaction.'
    }
  }
  const extraInfo = boundedText(body.extraInfo, MAX_INFO_BYTES) ? body.extraInfo : ''
  const description = `${txStatus} ${extraInfo}`.trim()
  const upper = txStatus.toUpperCase()
  if (
    FAILED_TX_STATUSES.has(upper) ||
    upper.includes('ORPHAN') ||
    extraInfo.toUpperCase().includes('ORPHAN')
  ) {
    return { status: 'error', code: txStatus, txid, description }
  }
  return { status: 'success', txid, message: description }
}

/** Keeps the HTTP status as the code and adds the ARC status of an error body. */
function failedResponse(status: unknown, data: unknown, tx: Transaction): BroadcastFailure {
  const failure: BroadcastFailure = {
    status: 'error',
    code: providerStatusCode(status),
    description: providerDiagnostic(data)
  }
  const body = statusBody(data)
  if (body === undefined) return failure
  const echoed = body.txid
  if (typeof echoed === 'string' && TRANSACTION_ID.test(echoed)) {
    let txid: unknown
    try {
      txid = tx.id('hex')
    } catch {
      // An unidentifiable transaction must not turn a provider refusal into a 500.
    }
    if (typeof txid === 'string' && echoed.toLowerCase() === txid.toLowerCase()) {
      failure.txid = echoed.toLowerCase()
    }
  }
  const more: { arcStatus?: number; detail?: string } = {}
  if (Number.isSafeInteger(body.status)) more.arcStatus = body.status as number
  if (boundedText(body.detail, MAX_INFO_BYTES)) more.detail = body.detail
  if (Object.keys(more).length !== 0) failure.more = more
  return failure
}
