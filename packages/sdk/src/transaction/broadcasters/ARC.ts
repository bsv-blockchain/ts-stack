import {
  BroadcastResponse,
  BroadcastFailure,
  Broadcaster
} from '../Broadcaster.js'
import Transaction from '../Transaction.js'
import { HttpClient, HttpClientRequestOptions } from '../http/HttpClient.js'
import { defaultHttpClient } from '../http/DefaultHttpClient.js'
import Random from '../../primitives/Random.js'
import { toHex } from '../../primitives/utils.js'

/** Configuration options for the ARC broadcaster. */
export interface ArcConfig {
  /** Authentication token for the ARC API */
  apiKey?: string
  /** The HTTP client used to make requests to the ARC API. */
  httpClient?: HttpClient
  /** Deployment id used annotating api calls in XDeployment-ID header - this value will be randomly generated if not set */
  deploymentId?: string
  /** notification callback endpoint for proofs and double spend notification */
  callbackUrl?: string
  /** default access token for notification callback endpoint. It will be used as a Authorization header for the http callback */
  callbackToken?: string
  /** additional headers to be attached to all tx submissions. */
  headers?: Record<string, string>
}

function defaultDeploymentId (): string {
  return `ts-sdk-${toHex(Random(16))}`
}

const ARC_ERROR_STATUSES = new Set([
  'DOUBLE_SPEND_ATTEMPTED',
  'REJECTED',
  'INVALID',
  'MALFORMED',
  'MINED_IN_STALE_BLOCK'
])

function transactionHex (tx: Transaction): string {
  try {
    return tx.toHexEF()
  } catch (error) {
    if (
      error.message ===
      'All inputs must have source transactions when serializing to EF format'
    ) return tx.toHex()
    throw error
  }
}

function successfulArcResponse (data: ArcResponse): BroadcastResponse | BroadcastFailure {
  const { txid, extraInfo, txStatus, competingTxs } = data
  const upperStatus = txStatus?.toUpperCase()
  const isOrphan = extraInfo?.toUpperCase().includes('ORPHAN') ||
    upperStatus?.includes('ORPHAN')
  if (ARC_ERROR_STATUSES.has(upperStatus) || isOrphan) {
    const failure: BroadcastFailure = {
      status: 'error',
      code: txStatus ?? 'UNKNOWN',
      txid,
      description: `${txStatus ?? ''} ${extraInfo ?? ''}`.trim()
    }
    if (competingTxs != null) failure.more = { competingTxs }
    return failure
  }

  const response: BroadcastResponse = {
    status: 'success',
    txid,
    message: `${txStatus} ${extraInfo}`
  }
  if (competingTxs != null) response.competingTxs = competingTxs
  return response
}

function parseArcFailureData (data: unknown): unknown {
  if (typeof data !== 'string') return data
  try {
    return JSON.parse(data)
  } catch {
    return data
  }
}

function failedArcResponse (status: unknown, responseData: unknown): BroadcastFailure {
  const failure: BroadcastFailure = {
    status: 'error',
    code: typeof status === 'number' || typeof status === 'string'
      ? status.toString()
      : 'ERR_UNKNOWN',
    description: 'Unknown error'
  }
  const data = parseArcFailureData(responseData)
  if (data == null || typeof data !== 'object') return failure
  failure.more = data
  if ('txid' in data && typeof data.txid === 'string') failure.txid = data.txid
  if ('detail' in data && typeof data.detail === 'string') failure.description = data.detail
  return failure
}

function caughtArcResponse (error: unknown): BroadcastFailure {
  return {
    status: 'error',
    code: '500',
    description:
      error != null &&
      typeof error === 'object' &&
      'message' in error &&
      typeof error.message === 'string'
        ? error.message
        : 'Internal Server Error'
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
  private readonly httpClient: HttpClient

  /**
   * Constructs an instance of the ARC broadcaster.
   *
   * @param {string} URL - The URL endpoint for the ARC API.
   * @param {ArcConfig} config - Configuration options for the ARC broadcaster.
   */
  constructor (URL: string, config?: ArcConfig)
  /**
   * Constructs an instance of the ARC broadcaster.
   *
   * @param {string} URL - The URL endpoint for the ARC API.
   * @param {string} apiKey - The API key used for authorization with the ARC API.
   */
  constructor (URL: string, apiKey?: string)

  constructor (URL: string, config?: string | ArcConfig) {
    this.URL = URL
    if (typeof config === 'string') {
      this.apiKey = config
      this.httpClient = defaultHttpClient()
      this.deploymentId = defaultDeploymentId()
      this.callbackToken = undefined
      this.callbackUrl = undefined
    } else {
      const configObj: ArcConfig = config ?? {}
      const {
        apiKey,
        deploymentId,
        httpClient,
        callbackToken,
        callbackUrl,
        headers
      } = configObj
      this.apiKey = apiKey
      this.httpClient = httpClient ?? defaultHttpClient()
      this.deploymentId = deploymentId ?? defaultDeploymentId()
      this.callbackToken = callbackToken
      this.callbackUrl = callbackUrl
      this.headers = headers
    }
  }

  /**
   * Constructs a dictionary of the default & supplied request headers.
   */
  private requestHeaders (): Record<string, string> {
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
      for (const key in this.headers) {
        headers[key] = this.headers[key]
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
  async broadcast (
    tx: Transaction
  ): Promise<BroadcastResponse | BroadcastFailure> {
    const requestOptions: HttpClientRequestOptions = {
      method: 'POST',
      headers: this.requestHeaders(),
      data: { rawTx: transactionHex(tx) }
    }

    try {
      const response = await this.httpClient.request<ArcResponse>(
        `${this.URL}/v1/tx`,
        requestOptions
      )
      return response.ok
        ? successfulArcResponse(response.data)
        : failedArcResponse(response.status, response.data)
    } catch (error) {
      return caughtArcResponse(error)
    }
  }

  /**
   * Broadcasts multiple transactions via ARC.
   * Handles mixed responses where some transactions succeed and others fail.
   *
   * @param {Transaction[]} txs - Array of transactions to be broadcasted.
   * @returns {Promise<Array<object>>} A promise that resolves to an array of objects.
   */
  async broadcastMany (txs: Transaction[]): Promise<object[]> {
    const rawTxs = txs.map(tx => ({ rawTx: transactionHex(tx) }))

    const requestOptions: HttpClientRequestOptions = {
      method: 'POST',
      headers: this.requestHeaders(),
      data: rawTxs
    }

    try {
      const response = await this.httpClient.request<object[]>(
        `${this.URL}/v1/txs`,
        requestOptions
      )

      return response.data as object[]
    } catch (error) {
      const errorResponse = caughtArcResponse(error)
      return txs.map(() => errorResponse)
    }
  }
}

interface ArcResponse {
  txid: string
  extraInfo: string
  txStatus: string
  competingTxs?: string[]
}
