import type { BroadcastResponse, BroadcastFailure, Broadcaster } from '../Broadcaster.js'
import Transaction from '../Transaction.js'
import { binaryHttpClient } from '../http/BinaryFetchClient.js'
import type { HttpClient } from '../http/HttpClient.js'
import {
  ARC_ERROR_STATUSES,
  boundedText,
  MAX_ARC_INFO_BYTES,
  MAX_ARC_STATUS_BYTES,
  normalizeBroadcasterHttpClient,
  normalizeBroadcasterUrl,
  ownArcData,
  parseArcData,
  providerDiagnostic,
  providerStatusCode,
  TRANSACTION_ID
} from './BroadcasterValidation.js'
import { lockConfiguration } from '../http/ConfigurationLock.js'

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
   * carries it as `txStatus` (and the body's numeric `status` as `arcStatus`),
   * and its message as `ARC` builds it. `RECEIVED` is still a success but means
   * taken in, not yet validated; callers that need certainty check `txStatus`
   * or poll the service. A status in ARC's failure set, an orphan, or a body
   * naming another transaction is returned as a failure. Unlike `ARC`, an
   * unknown status stays a success, since a plain node may answer anything.
   * A non-2xx keeps the HTTP status as `code` and adds the body's ARC
   * `status`, `txStatus` and `detail` under `more`.
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
 * validated" from network acceptance and from a refusal, so it is surfaced.
 */
function successfulResponse(data: unknown, txid: string): BroadcastResponse | BroadcastFailure {
  const body = ownArcData(parseArcData(data))
  const read = (name: string): unknown => body?.[name]?.value
  const txStatus = read('txStatus')
  if (!boundedText(txStatus, MAX_ARC_STATUS_BYTES, false)) {
    return { status: 'success', txid, message: 'broadcast successful' }
  }
  const echoed = read('txid')
  if (typeof echoed === 'string' && echoed.toLowerCase() !== txid) {
    return {
      status: 'error',
      code: 'ERR_TXID_MISMATCH',
      description: 'Teranode acknowledged a transaction other than the submitted transaction.'
    }
  }
  const extraInfo = read('extraInfo')
  const description =
    `${txStatus} ${boundedText(extraInfo, MAX_ARC_INFO_BYTES) ? extraInfo : ''}`.trim()
  const fields: { txStatus: string; arcStatus?: number } = { txStatus }
  const arcStatus = read('status')
  if (Number.isSafeInteger(arcStatus)) fields.arcStatus = arcStatus as number
  const upper = description.toUpperCase()
  if (ARC_ERROR_STATUSES.has(txStatus.trim().toUpperCase()) || upper.includes('ORPHAN')) {
    return { status: 'error', code: txStatus, txid, description, more: fields }
  }
  return { status: 'success', txid, message: description, ...fields }
}

/** Keeps the HTTP status as the code and adds the ARC fields of an error body. */
function failedResponse(status: unknown, data: unknown, tx: Transaction): BroadcastFailure {
  const failure: BroadcastFailure = {
    status: 'error',
    code: providerStatusCode(status),
    description: providerDiagnostic(data)
  }
  const body = ownArcData(parseArcData(data))
  if (body === undefined) return failure
  const read = (name: string): unknown => body[name]?.value
  const echoed = read('txid')
  // A body naming another transaction only loses its txid here; the HTTP code
  // stays, unlike ARC's ERR_TXID_MISMATCH, so existing callers see no change.
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
  const more: { arcStatus?: number; txStatus?: string; detail?: string } = {}
  const arcStatus = read('status')
  const txStatus = read('txStatus')
  const detail = read('detail')
  if (Number.isSafeInteger(arcStatus)) more.arcStatus = arcStatus as number
  if (boundedText(txStatus, MAX_ARC_STATUS_BYTES, false)) more.txStatus = txStatus
  if (boundedText(detail, MAX_ARC_INFO_BYTES, false)) more.detail = detail
  if (Object.keys(more).length !== 0) failure.more = more
  return failure
}
