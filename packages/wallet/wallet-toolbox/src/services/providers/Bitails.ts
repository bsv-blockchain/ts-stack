import { Beef, defaultHttpClient, HexString, HttpClient } from '@bsv/sdk'
import { toArray, toHex } from '@bsv/sdk/primitives/utils'
import { Chain, ReqHistoryNote } from '../../sdk/types'
import {
  GetMerklePathResult,
  PostBeefResult,
  PostTxResultForTxid,
  WalletServices
} from '../../sdk/WalletServices.interfaces'
import { doubleSha256BE } from '../../utility/utilityHelpers'
import { WalletError } from '../../sdk/WalletError'
import { convertProofToMerklePath } from '../../utility/tscProofToMerklePath'
import { normalizeTxid, validateMerklePathResult } from '../validateMerklePathResult'
import {
  MAX_POST_BEEF_BYTES,
  MAX_POST_BEEF_TXIDS,
  normalizePostRawHex,
  snapshotPostBeefRequest,
  validatePostBeefResultOrServiceError
} from '../validatePostBeefResult'

export interface BitailsConfig {
  /** Authentication token for BitTails API */
  apiKey?: string
  /** The HTTP client used to make requests to the API. */
  httpClient?: HttpClient
  /** Whole-request deadline applied to Bitails calls. Defaults to 30 seconds. */
  requestTimeoutMsecs?: number
}

interface BitailsPostNoteContext {
  nn: () => { name: string; when: string }
  nne: () => {
    name: string
    when: string
    raws: string
    txids: string
    url: string
  }
}

function denseBitailsArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_POST_BEEF_TXIDS) {
    throw new Error(`${name} must contain 1 through ${MAX_POST_BEEF_TXIDS} items.`)
  }
  const properties = Object.getOwnPropertyDescriptors(value)
  const expected = new Set(['length', ...Array.from({ length: value.length }, (_, index) => String(index))])
  if (
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(properties).length !== expected.size ||
    Object.keys(properties).some(key => !expected.has(key)) ||
    Object.values(properties).some(property => property.get != null || property.set != null)
  ) {
    throw new Error(`${name} must be an accessor-free dense array.`)
  }
  return Array.from({ length: value.length }, (_, index) => properties[String(index)].value)
}

function validateBitailsPostRequest(
  rawValues: unknown,
  requestedValues?: unknown
): { raws: HexString[]; txids?: string[] } {
  let aggregateBytes = 0
  const raws = denseBitailsArray(rawValues, 'raws').map((raw, index) => {
    const normalized = normalizePostRawHex(raw, MAX_POST_BEEF_BYTES, `raws[${index}]`)
    aggregateBytes += normalized.length / 2
    if (!Number.isSafeInteger(aggregateBytes) || aggregateBytes > MAX_POST_BEEF_BYTES) {
      throw new Error(`raws must total no more than ${MAX_POST_BEEF_BYTES} bytes.`)
    }
    return normalized
  })
  const rawTxids = new Set(raws.map(raw => toHex(doubleSha256BE(toArray(raw, 'hex')))))
  const txids =
    requestedValues === undefined
      ? undefined
      : denseBitailsArray(requestedValues, 'txids').map((txid, index) => normalizeTxid(txid, `txids[${index}]`))
  if (txids != null && (new Set(txids).size !== txids.length || txids.some(txid => !rawTxids.has(txid)))) {
    throw new Error('txids must be unique transaction IDs present in raws.')
  }
  return { raws, txids }
}

function initializeBitailsPostResult(
  raws: HexString[],
  requestedTxids?: string[]
): { result: PostBeefResult; rawTxids: string[] } {
  const result: PostBeefResult = {
    name: 'BitailsPostRaws',
    status: 'success',
    txidResults: [],
    notes: []
  }
  const rawTxids: string[] = []
  for (const raw of raws) {
    const txid = toHex(doubleSha256BE(toArray(raw, 'hex')))
    rawTxids.push(txid)
    if (requestedTxids == null || requestedTxids.includes(txid)) {
      result.txidResults.push({ txid, status: 'success', notes: [] })
    }
  }
  return { result, rawTxids }
}

function reconcileBitailsResponseTxids(
  result: PostBeefResult,
  responseResults: BitailsPostRawsResult[],
  rawTxids: string[],
  notes: BitailsPostNoteContext
): boolean {
  if (responseResults.length !== rawTxids.length) {
    result.status = 'error'
    result.notes!.push({ ...notes.nne(), what: 'postRawsErrorResultsCount' })
    return false
  }
  for (let index = 0; index < responseResults.length; index++) {
    const response = responseResults[index]
    if (response.txid == null || response.txid === '') {
      response.txid = rawTxids[index]
      result.notes!.push({
        ...notes.nn(),
        what: 'postRawsResultMissingTxids',
        i: index,
        rawsTxid: rawTxids[index]
      })
    } else if (response.txid !== rawTxids[index]) {
      result.status = 'error'
      result.notes!.push({
        ...notes.nn(),
        what: 'postRawsResultTxids',
        i: index,
        txid: response.txid,
        rawsTxid: rawTxids[index]
      })
    }
  }
  return result.status === 'success'
}

function applyBitailsTransactionResult(
  result: PostTxResultForTxid,
  response: BitailsPostRawsResult,
  notes: BitailsPostNoteContext
): void {
  if (response.error == null) {
    result.notes!.push({ ...notes.nn(), what: 'postRawsSuccess' })
    return
  }
  const { code, message } = response.error
  if (code === -27) {
    result.notes!.push({ ...notes.nne(), what: 'postRawsSuccessAlreadyInMempool' })
    return
  }

  result.status = 'error'
  if (code === -25) {
    result.doubleSpend = true
    result.competingTxs = undefined
    result.notes!.push({ ...notes.nne(), what: 'postRawsErrorMissingInputs' })
  } else if ((response as BitailsPostRawsResult & { code?: string }).code === 'ECONNRESET') {
    result.notes!.push({
      ...notes.nne(),
      what: 'postRawsErrorECONNRESET',
      txid: result.txid,
      message
    })
  } else {
    result.notes!.push({
      ...notes.nne(),
      what: 'postRawsError',
      txid: result.txid,
      code,
      message
    })
  }
}

function applyRequestedBitailsResults(
  result: PostBeefResult,
  responseResults: BitailsPostRawsResult[],
  notes: BitailsPostNoteContext
): void {
  for (const txResult of result.txidResults) {
    const response = responseResults.find(item => item.txid === txResult.txid)!
    applyBitailsTransactionResult(txResult, response, notes)
    if (txResult.status !== 'success') result.status = 'error'
  }
}

function markBitailsServiceFailure(result: PostBeefResult): void {
  result.status = 'error'
  for (const txResult of result.txidResults) {
    txResult.status = 'error'
    txResult.serviceError = true
    txResult.doubleSpend = undefined
    txResult.competingTxs = undefined
  }
}

/**
 *
 */
export class Bitails {
  readonly chain: Chain
  readonly apiKey: string
  readonly URL: string
  readonly httpClient: HttpClient
  readonly requestTimeoutMsecs: number

  constructor(chain: Chain = 'main', config: BitailsConfig = {}) {
    const { apiKey, httpClient, requestTimeoutMsecs = 30_000 } = config
    if (!Number.isSafeInteger(requestTimeoutMsecs) || requestTimeoutMsecs < 1 || requestTimeoutMsecs > 3_600_000) {
      throw new Error('Bitails requestTimeoutMsecs must be an integer from 1 through 3600000.')
    }
    this.chain = chain
    switch (chain) {
      case 'main':
        this.URL = 'https://api.bitails.io/'
        break
      case 'test':
        this.URL = 'https://test-api.bitails.io/'
        break
      default:
        throw new Error(`Bitails does not support '${chain}' chain.`)
    }
    this.httpClient = httpClient ?? defaultHttpClient()
    this.apiKey = apiKey ?? ''
    this.requestTimeoutMsecs = requestTimeoutMsecs
  }

  getHttpHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json'
    }

    if (typeof this.apiKey === 'string' && this.apiKey.trim() !== '') {
      headers.Authorization = this.apiKey
    }

    return headers
  }

  /**
   * Bitails does not natively support a postBeef end-point aware of multiple txids of interest in the Beef.
   *
   * Send rawTx in `txids` order from beef.
   *
   * @param beef
   * @param txids
   * @returns
   */
  async postBeef(beef: Beef, txids: string[]): Promise<PostBeefResult> {
    const request = snapshotPostBeefRequest(beef, txids)
    beef = Beef.fromBinaryStrict(request.beefBytes)
    txids = request.txids
    const nn = () => ({
      name: 'BitailsPostBeef',
      when: new Date().toISOString()
    })
    const nne = () => ({ ...nn(), beef: beef.toHex(), txids: txids.join(',') })

    const note: ReqHistoryNote = { ...nn(), what: 'postBeef' }

    const raws: string[] = []
    for (const txid of txids) {
      const rawTx = toHex(beef.findTxid(txid)!.rawTx!)
      raws.push(rawTx)
    }

    const r = await this.postRaws(raws, txids)

    r.notes!.unshift(note)
    if (r.status === 'success') r.notes!.push({ ...nn(), what: 'postBeefSuccess' })
    else r.notes!.push({ ...nne(), what: 'postBeefError' })

    return validatePostBeefResultOrServiceError(r, txids, 'BitailsPostRaws')
  }

  /**
   * @param raws Array of raw transactions to broadcast as hex strings
   * @param txids Array of txids for transactions in raws for which results are requested, remaining raws are supporting only.
   * @returns
   */
  async postRaws(raws: HexString[], txids?: string[]): Promise<PostBeefResult> {
    ;({ raws, txids } = validateBitailsPostRequest(raws, txids))
    const { result: r, rawTxids } = initializeBitailsPostResult(raws, txids)

    const headers = this.getHttpHeaders()
    headers['Content-Type'] = 'application/json'
    // headers['Accept'] = 'text/json'

    const data = { raws }
    const requestOptions = {
      method: 'POST',
      headers,
      data,
      signal: AbortSignal.timeout(this.requestTimeoutMsecs)
    }

    const url = `${this.URL}tx/broadcast/multi`
    const notes: BitailsPostNoteContext = {
      nn: () => ({
        name: 'BitailsPostRawTx',
        when: new Date().toISOString()
      }),
      nne: () => ({
        name: 'BitailsPostRawTx',
        when: new Date().toISOString(),
        raws: raws.join(','),
        txids: r.txidResults.map(result => result.txid).join(','),
        url
      })
    }

    try {
      const response = await this.httpClient.request<BitailsPostRawsResult[]>(url, requestOptions)
      if (response.ok) {
        if (reconcileBitailsResponseTxids(r, response.data, rawTxids, notes)) {
          applyRequestedBitailsResults(r, response.data, notes)
        } else {
          markBitailsServiceFailure(r)
        }
      } else {
        markBitailsServiceFailure(r)
        const n: ReqHistoryNote = { ...notes.nne(), what: 'postRawsError' }
        r.notes!.push(n)
      }
    } catch (error_: unknown) {
      markBitailsServiceFailure(r)
      const e = WalletError.fromUnknown(error_)
      const { code, description } = e
      r.notes!.push({ ...notes.nne(), what: 'postRawsCatch', code, description })
    }
    return validatePostBeefResultOrServiceError(
      r,
      r.txidResults.map(result => result.txid),
      'BitailsPostRaws'
    )
  }

  /**
   *
   * @param txid
   * @param services
   * @returns
   */
  async getMerklePath(txid: string, services: WalletServices): Promise<GetMerklePathResult> {
    const r: GetMerklePathResult = { name: 'BitailsTsc', notes: [] }

    const url = `${this.URL}tx/${txid}/proof/tsc`

    const nn = () => ({ name: 'BitailsProofTsc', when: new Date().toISOString(), txid, url })

    const headers = this.getHttpHeaders()
    const requestOptions = { method: 'GET', headers, signal: AbortSignal.timeout(this.requestTimeoutMsecs) }

    try {
      const response = await this.httpClient.request<BitailsMerkleProof>(url, requestOptions)

      const nne = () => ({ ...nn(), txid, url, status: response.status, statusText: response.statusText })

      if (response.status === 404 && response.statusText === 'Not Found') {
        r.notes!.push({ ...nn(), what: 'getMerklePathNotFound' })
      } else if (!response.ok || response.status !== 200 || response.statusText !== 'OK') {
        r.notes!.push({ ...nne(), what: 'getMerklePathBadStatus' })
      } else if (response.data) {
        const p = response.data
        const target = normalizeTxid(p.target, 'TSC proof target')
        const header = await services.hashToHeader(target)
        if (header) {
          if (normalizeTxid(header.hash, 'TSC proof header hash') !== target) {
            throw new Error('Bitails proof header did not match its target block hash.')
          }
          const proof = { index: p.index, nodes: p.nodes, height: header.height }
          const validated = validateMerklePathResult(txid, {
            merklePath: convertProofToMerklePath(txid, proof),
            header
          })
          r.merklePath = validated.merklePath
          r.header = validated.header
          r.notes!.push({ ...nne(), what: 'getMerklePathSuccess' })
        } else {
          r.notes!.push({ ...nne(), what: 'getMerklePathNoHeader', target: p.target })
        }
      } else {
        r.notes!.push({ ...nne(), what: 'getMerklePathNoData' })
      }
    } catch (error_: unknown) {
      const e = WalletError.fromUnknown(error_)
      const { code, description } = e
      r.notes!.push({ ...nn(), what: 'getMerklePathCatch', code, description })
      r.error = e
    }
    return r
  }
}

interface BitailsPostRawsResult {
  txid?: string
  error?: {
    code: number
    message: string
  }
}

export interface BitailsMerkleProof {
  index: number
  txOrId: string
  target: string
  nodes: string[]
}
