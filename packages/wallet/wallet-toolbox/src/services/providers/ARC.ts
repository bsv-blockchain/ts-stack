import {
  Beef,
  BEEF_V1,
  BEEF_V2,
  defaultHttpClient,
  HexString,
  HttpClient,
  HttpClientResponse,
  HttpClientRequestOptions,
  Random,
  Utils
} from '@bsv/sdk'
import { PostBeefResult, PostTxResultForTxid, PostTxResultForTxidError } from '../../sdk/WalletServices.interfaces'
import { doubleSha256BE } from '../../utility/utilityHelpers'
import { ReqHistoryNote } from '../../sdk/types'
import { WalletError } from '../../sdk/WalletError'

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
  return `ts-sdk-${Utils.toHex(Random(16))}`
}

const arcAcceptedTxStatuses = new Set([
  'RECEIVED',
  'SENT_TO_NETWORK',
  'ANNOUNCED_TO_NETWORK',
  'ACCEPTED_BY_NETWORK',
  'SEEN_ON_NETWORK',
  'STORED',
  'MINED',
  'IMMUTABLE'
])

const arcDoubleSpendTxStatuses = new Set([
  'DOUBLE_SPEND_ATTEMPTED',
  'SEEN_IN_ORPHAN_MEMPOOL'
])

const arcInvalidTxStatuses = new Set([
  'INVALID',
  'MALFORMED',
  'REJECTED'
])

export function isArcAcceptedTxStatus (txStatus: string | undefined): boolean {
  return txStatus != null && arcAcceptedTxStatuses.has(txStatus)
}

export function isArcDoubleSpendTxStatus (txStatus: string | undefined): boolean {
  return txStatus != null && arcDoubleSpendTxStatuses.has(txStatus)
}

export function isArcInvalidTxStatus (txStatus: string | undefined): boolean {
  return txStatus != null && arcInvalidTxStatuses.has(txStatus)
}

export function isArcServiceErrorStatus (status: number | undefined, detail?: string): boolean {
  if (status == null) return true
  if (status === 408 || status === 429 || status === 476 || status >= 500) return true
  if (detail == null) return false
  const d = detail.toLowerCase()
  return d.includes('maximum batch size') ||
    d.includes('too many requests') ||
    d.includes('rate limit') ||
    d.includes('timeout') ||
    d.includes('temporarily') ||
    d.includes('backpressure') ||
    d.includes('unavailable')
}

interface ArcPostNoteContext {
  nn: () => { name: string; when: string }
  nne: () => {
    rawTx: HexString
    txids: string
    url: string
    name: string
    when: string
  }
}

/**
 * Represents an ARC transaction broadcaster.
 */
export class ARC {
  readonly name: string
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
  constructor (URL: string, config?: ArcConfig, name?: string)
  /**
   * Constructs an instance of the ARC broadcaster.
   *
   * @param {string} URL - The URL endpoint for the ARC API.
   * @param {string} apiKey - The API key used for authorization with the ARC API.
   */
  constructor (URL: string, apiKey?: string, name?: string)

  constructor (URL: string, config?: string | ArcConfig, name?: string) {
    this.name = name ?? 'ARC'
    this.URL = URL
    if (typeof config === 'string') {
      this.apiKey = config
      this.httpClient = defaultHttpClient()
      this.deploymentId = defaultDeploymentId()
      this.callbackToken = undefined
      this.callbackUrl = undefined
    } else {
      const configObj: ArcConfig = config ?? {}
      const { apiKey, deploymentId, httpClient, callbackToken, callbackUrl, headers } = configObj
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

  private applySuccessfulPostRawTx (
    result: PostTxResultForTxid,
    data: ArcResponse,
    notes: ArcPostNoteContext
  ): void {
    const { txid, extraInfo, txStatus, competingTxs } = data
    result.data = `${txStatus} ${extraInfo}`
    if (result.txid !== txid) result.data += ` txid altered from ${result.txid} to ${txid}`
    result.txid = txid
    const responseNote = {
      txid,
      extraInfo,
      txStatus,
      competingTxs: competingTxs?.join(',')
    }
    if (isArcDoubleSpendTxStatus(txStatus)) {
      result.status = 'error'
      result.doubleSpend = true
      result.competingTxs = competingTxs
      result.notes!.push({ ...notes.nne(), ...responseNote, what: 'postRawTxDoubleSpend' })
      return
    }
    result.notes!.push({ ...notes.nn(), ...responseNote, what: 'postRawTxSuccess' })
  }

  private applyFailedPostRawTx (
    result: PostTxResultForTxid,
    response: Exclude<HttpClientResponse<ArcResponse>, { ok: true }>,
    data: ArcResponse,
    notes: ArcPostNoteContext
  ): void {
    result.status = 'error'
    const responseNote = {
      txid: data.txid,
      extraInfo: data.extraInfo,
      txStatus: data.txStatus,
      competingTxs: data.competingTxs?.join(',')
    }
    const note: ReqHistoryNote = {
      ...notes.nn(),
      ...notes.nne(),
      ...responseNote,
      what: 'postRawTxError'
    }
    const errorData: PostTxResultForTxidError = {}
    result.data = errorData
    const responseStatus: unknown = response.status
    let numericStatus: number | undefined
    if (typeof responseStatus === 'number' || typeof responseStatus === 'string') {
      note.status = responseStatus
      errorData.status = responseStatus.toString()
      const parsed = Number(responseStatus)
      if (Number.isFinite(parsed)) numericStatus = parsed
    } else {
      note.status = typeof responseStatus
      errorData.status = 'ERR_UNKNOWN'
    }

    const responseData: unknown = response.data
    if (typeof responseData === 'string' && responseData !== '') {
      note.data = responseData.slice(0, 128)
    } else if (responseData != null && typeof responseData === 'object') {
      errorData.more = responseData
      if ('detail' in responseData && typeof responseData.detail === 'string') {
        errorData.detail = responseData.detail
        note.detail = responseData.detail
      }
    }
    result.serviceError = isArcServiceErrorStatus(numericStatus, errorData.detail)
    result.notes!.push(note)
  }

  private applyPostRawTxResponse (
    result: PostTxResultForTxid,
    response: HttpClientResponse<ArcResponse>,
    notes: ArcPostNoteContext
  ): void {
    if (response.ok) {
      this.applySuccessfulPostRawTx(result, response.data, notes)
    } else {
      this.applyFailedPostRawTx(result, response, response.data as ArcResponse, notes)
    }
  }

  private applyPostRawTxCatch (
    result: PostTxResultForTxid,
    error_: unknown,
    notes: ArcPostNoteContext
  ): void {
    const error = WalletError.fromUnknown(error_)
    result.status = 'error'
    result.serviceError = true
    result.data = `${error.code} ${error.message}`
    result.notes!.push({
      ...notes.nne(),
      what: 'postRawTxCatch',
      code: error.code,
      description: error.description
    })
  }

  /**
   * The ARC '/v1/tx' endpoint, as of 2025-02-17 supports all of the following hex string formats:
   *   1. Single serialized raw transaction.
   *   2. Single EF serialized raw transaction (untested).
   *   3. V1 serialized Beef (results returned reflect only the last transaction in the beef)
   *
   * The ARC '/v1/tx' endpoint, as of 2025-02-17 DOES NOT support the following hex string formats:
   *   1. V2 serialized Beef
   *
   * @param rawTx
   * @param txids
   * @returns
   */
  async postRawTx (rawTx: HexString, txids?: string[]): Promise<PostTxResultForTxid> {
    let txid = Utils.toHex(doubleSha256BE(Utils.toArray(rawTx, 'hex')))
    if (txids == null) {
      txids = [txid]
    } else {
      txid = txids.at(-1)!
    }

    const requestOptions: HttpClientRequestOptions = {
      method: 'POST',
      headers: this.requestHeaders(),
      data: { rawTx },
      signal: AbortSignal.timeout(1000 * 30) // 30 seconds timeout, error.code will be 'ABORT_ERR'
    }

    const r: PostTxResultForTxid = {
      txid,
      status: 'success',
      notes: []
    }

    const url = `${this.URL}/v1/tx`
    const notes: ArcPostNoteContext = {
      nn: () => ({ name: this.name, when: new Date().toISOString() }),
      nne: () => ({
        name: this.name,
        when: new Date().toISOString(),
        rawTx,
        txids: txids.join(','),
        url
      })
    }

    try {
      const response = await this.httpClient.request<ArcResponse>(url, requestOptions)
      this.applyPostRawTxResponse(r, response, notes)
    } catch (error_: unknown) {
      this.applyPostRawTxCatch(r, error_, notes)
    }

    return r
  }

  /**
   * ARC does not natively support a postBeef end-point aware of multiple txids of interest in the Beef.
   *
   * It does process multiple new transactions, however, which allows results for all txids of interest
   * to be collected by the `/v1/tx/${txid}` endpoint.
   *
   * @param beef
   * @param txids
   * @returns
   */
  async postBeef (beef: Beef, txids: string[]): Promise<PostBeefResult> {
    const r: PostBeefResult = {
      name: this.name,
      status: 'success',
      txidResults: [],
      notes: []
    }

    const nn = () => ({ name: this.name, when: new Date().toISOString() })

    if (beef.version === BEEF_V2 && beef.txs.every(btx => !btx.isTxidOnly)) {
      beef.version = BEEF_V1
      r.notes!.push({ ...nn(), what: 'postBeefV2ToV1' })
    }

    const beefHex = beef.toHex()

    const prtr = await this.postRawTx(beefHex, txids)

    r.status = prtr.status
    r.txidResults = [prtr]

    // Since postRawTx only returns results for a single txid,
    // replicate the basic results any additional txids.
    for (const txid of txids) {
      if (prtr.txid === txid) continue
      const tr: PostTxResultForTxid = {
        txid,
        status: 'success',
        notes: []
      }
      // For the extra txids, go back to the service for confirmation...
      const dr = await this.getTxData(txid)
      if (dr.txid !== txid) {
        tr.status = 'error'
        tr.data = 'internal error'
        tr.notes!.push({
          ...nn(),
          what: 'postBeefGetTxDataInternal',
          txid,
          returnedTxid: dr.txid
        })
      } else if (isArcAcceptedTxStatus(dr.txStatus)) {
        tr.data = dr.txStatus
        tr.notes!.push({
          ...nn(),
          what: 'postBeefGetTxDataSuccess',
          txid,
          txStatus: dr.txStatus
        })
      } else {
        tr.status = 'error'
        tr.data = dr
        tr.serviceError = !isArcInvalidTxStatus(dr.txStatus)
        if (isArcDoubleSpendTxStatus(dr.txStatus)) {
          tr.doubleSpend = true
          tr.competingTxs = dr.competingTxs ?? undefined
          tr.serviceError = undefined
        }
        tr.notes!.push({
          ...nn(),
          what: 'postBeefGetTxDataError',
          txid,
          txStatus: dr.txStatus
        })
      }
      r.txidResults.push(tr)
      if (r.status === 'success' && tr.status === 'error') r.status = 'error'
    }

    return r
  }

  /**
   * This seems to only work for recently submitted txids...but that's all we need to complete postBeef!
   * @param txid
   * @returns
   */
  async getTxData (txid: string): Promise<ArcMinerGetTxData> {
    const requestOptions: HttpClientRequestOptions = {
      method: 'GET',
      headers: this.requestHeaders()
    }

    const response = await this.httpClient.request<ArcMinerGetTxData>(`${this.URL}/v1/tx/${txid}`, requestOptions)

    return response.data
  }
}

interface ArcResponse {
  txid: string
  extraInfo: string
  txStatus: string
  competingTxs?: string[]
}

export interface ArcMinerGetTxData {
  status: number // 200
  title: string // OK
  blockHash: string
  blockHeight: number
  competingTxs: null | string[]
  extraInfo: string
  merklePath: string
  timestamp: string // ISO Z
  txid: string
  txStatus: string // 'SEEN_IN_ORPHAN_MEMPOOL'
}
