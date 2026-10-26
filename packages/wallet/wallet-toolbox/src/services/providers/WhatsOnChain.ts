import { Beef, HexString, HttpClientRequestOptions, HttpClientResponse, WhatsOnChainConfig } from '@bsv/sdk'
import { toArray, toHex } from '@bsv/sdk/primitives/utils'
import { convertProofToMerklePath } from '../../utility/tscProofToMerklePath'
import SdkWhatsOnChain from './SdkWhatsOnChain'
import { Chain } from '../../sdk/types'
import {
  BlockHeader,
  BsvExchangeRate,
  GetMerklePathResult,
  GetRawTxResult,
  GetScriptHashHistoryResult,
  GetStatusForTxidsResult,
  GetUtxoStatusOutputFormat,
  GetUtxoStatusResult,
  PostBeefResult,
  PostTxResultForTxid,
  WalletServices
} from '../../sdk/WalletServices.interfaces'
import { WERR_INTERNAL, WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'
import { WalletError } from '../../sdk/WalletError'
import { doubleSha256BE, wait } from '../../utility/utilityHelpers'
import { asArray } from '../../utility/utilityHelpers.noBuffer'
import { Services, validateScriptHash } from '../Services'
import {
  classifyMerklePathResponse,
  handlePostRawTxErrorResponse,
  handleScriptHashHistoryCatch,
  handleScriptHashHistoryResponse,
  handleUtxoConnReset,
  makeMerklePathNote,
  ScriptHashHistoryResponse
} from './whatsOnChainHelpers'
import { validateHeaderFormat, validateHeaderProofOfWork } from '../chaintracker/chaintracks/util/blockHeaderUtilities'
import { normalizeTxid, validateMerklePathResult } from '../validateMerklePathResult'
import { validateStatusForTxidsResult } from '../validateStatusForTxidsResult'
import { MAX_RAW_TRANSACTION_BYTES, validateRawTxResult } from '../validateRawTxResult'
import { MAX_UTXO_STATUS_DETAILS, normalizeWalletOutpoint, validateUtxoStatusResult } from '../validateUtxoStatusResult'
import { validateScriptHashHistoryResult } from '../validateScriptHashHistoryResult'
import {
  normalizePostRawHex,
  snapshotPostBeefRequest,
  validatePostBeefResultOrServiceError,
  validatePostTxResultOrServiceError
} from '../validatePostBeefResult'

const HEX_32_BYTES = /^[0-9a-fA-F]{64}$/
const UINT32_MAX = 0xffffffff
const MAX_BLOCK_HEIGHT = 0x7fffffff

function requirePlainDataRecord(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be a plain data object.`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${name} must be a plain data object.`)
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(descriptors).length > 64 ||
    Object.values(descriptors).some(d => d.get != null || d.set != null)
  ) {
    throw new Error(`${name} must contain only bounded data properties.`)
  }
}

function requireDenseWocArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_UTXO_STATUS_DETAILS) {
    throw new Error(`${name} must be a bounded dense array.`)
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.values(descriptors).some(descriptor => descriptor.get != null || descriptor.set != null)
  ) {
    throw new Error(`${name} must be a bounded dense array.`)
  }
  const expectedKeys = new Set(['length', ...Array.from({ length: value.length }, (_, index) => String(index))])
  if (
    Object.keys(descriptors).some(key => !expectedKeys.has(key)) ||
    Object.keys(descriptors).length !== expectedKeys.size
  ) {
    throw new Error(`${name} must be a bounded dense array.`)
  }
  return value
}

function requireInteger(value: unknown, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(`${name} must be an integer between 0 and ${maximum}.`)
  }
  return value as number
}

function requireFiniteNumber(value: unknown, name: string, maximum = Number.MAX_VALUE): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) {
    throw new Error(`${name} must be a finite non-negative number.`)
  }
  return value
}

function requireHex32(value: unknown, name: string): string {
  if (typeof value !== 'string' || !HEX_32_BYTES.test(value)) throw new Error(`${name} must be 32 hex bytes.`)
  return value.toLowerCase()
}

function requireHeaderBits(value: unknown): number {
  if (typeof value === 'string') {
    if (!/^[0-9a-fA-F]{1,8}$/.test(value)) throw new Error('WhatsOnChain header bits are invalid.')
    return Number.parseInt(value, 16)
  }
  return requireInteger(value, 'WhatsOnChain header bits', UINT32_MAX)
}

export function validateWocChainInfo(value: unknown, expectedChain: Chain): WocChainInfo {
  requirePlainDataRecord(value, 'WhatsOnChain chain info')
  if (value.chain !== expectedChain) {
    throw new Error(`WhatsOnChain returned chain ${String(value.chain)} for configured chain ${expectedChain}.`)
  }
  if (typeof value.pruned !== 'boolean') throw new Error('WhatsOnChain chain info pruned must be boolean.')
  return {
    chain: value.chain as Chain,
    blocks: requireInteger(value.blocks, 'WhatsOnChain chain info blocks', MAX_BLOCK_HEIGHT),
    headers: requireInteger(value.headers, 'WhatsOnChain chain info headers', MAX_BLOCK_HEIGHT),
    bestblockhash: requireHex32(value.bestblockhash, 'WhatsOnChain chain info bestblockhash'),
    difficulty: requireFiniteNumber(value.difficulty, 'WhatsOnChain chain info difficulty'),
    mediantime: requireInteger(value.mediantime, 'WhatsOnChain chain info mediantime', UINT32_MAX),
    verificationprogress: requireFiniteNumber(
      value.verificationprogress,
      'WhatsOnChain chain info verificationprogress',
      2
    ),
    pruned: value.pruned,
    chainwork: requireHex32(value.chainwork, 'WhatsOnChain chain info chainwork')
  }
}

export interface WalletToolboxWhatsOnChainConfig extends WhatsOnChainConfig {
  /** Optional request-start gate used by ChainTracks' shared public-rate scheduler. */
  requestGate?: () => Promise<void>
  /** Whole-request deadline applied to every explorer call. Defaults to 30 seconds. */
  requestTimeoutMsecs?: number
}

export class WhatsOnChainNoServices extends SdkWhatsOnChain {
  private readonly requestGate?: () => Promise<void>

  constructor(chain: Chain = 'main', config: WalletToolboxWhatsOnChainConfig = {}) {
    if (chain === 'mock') throw new Error("WhatsOnChain does not support 'mock' chain. Use MockServices directly.")
    super(chain, config)
    const requestGate = Object.getOwnPropertyDescriptor(config, 'requestGate')?.value
    if (requestGate !== undefined && typeof requestGate !== 'function') {
      throw new Error('WhatsOnChain request gate must be a function or absent.')
    }
    this.requestGate = requestGate
  }

  private async requestWithAnonymousAuthFallback<T>(
    url: string,
    requestOptions: HttpClientRequestOptions
  ): Promise<HttpClientResponse<T>> {
    await this.requestGate?.()
    const response = await this.request<T>(url, requestOptions)
    if ((response.status !== 401 && response.status !== 403) || this.apiKey.trim() === '') {
      return response
    }

    // Treat the anonymous retry as another public request start so a stale
    // key cannot create a burst above the documented keyless allowance.
    if (this.requestGate != null) await this.requestGate()
    else await wait(350)
    return await this.request<T>(url, {
      method: 'GET',
      headers: { Accept: 'application/json' }
    })
  }

  /**
   * POST
   * https://api.whatsonchain.com/v1/bsv/main/txs/status
   * Content-Type: application/json
   * data: "{\"txids\":[\"6815f8014db74eab8b7f75925c68929597f1d97efa970109d990824c25e5e62b\"]}"
   *
   * result for a mined txid:
   *     [{
   *        "txid":"294cd1ebd5689fdee03509f92c32184c0f52f037d4046af250229b97e0c8f1aa",
   *        "blockhash":"000000000000000004b5ce6670f2ff27354a1e87d0a01bf61f3307f4ccd358b5",
   *        "blockheight":612251,
   *        "blocktime":1575841517,
   *        "confirmations":278272
   *      }]
   *
   * result for a valid recent txid:
   *     [{"txid":"6815f8014db74eab8b7f75925c68929597f1d97efa970109d990824c25e5e62b"}]
   *
   * result for an unknown txid:
   *     [{"txid":"6815f8014db74eab8b7f75925c68929597f1d97efa970109d990824c25e5e62c","error":"unknown"}]
   */
  async getStatusForTxids(txids: string[]): Promise<GetStatusForTxidsResult> {
    const normalizedTxids = txids.map((txid, index) => normalizeTxid(txid, `txids[${index}]`))
    const r: GetStatusForTxidsResult = {
      name: 'WoC',
      status: 'error',
      error: undefined,
      results: []
    }

    const requestOptions = {
      method: 'POST',
      headers: this.getHttpHeaders(),
      data: { txids: normalizedTxids }
    }

    const url = `${this.URL}/txs/status`

    try {
      const response = await this.request<WhatsOnChainTxsStatusData[]>(url, requestOptions)

      if (!response.data || !response.ok || response.status !== 200) {
        throw new WERR_INVALID_OPERATION('Unable to get status for txids at this timei.')
      }

      const data = response.data
      for (const txid of normalizedTxids) {
        const d = data.find(d => d.txid === txid)
        if (d == null || d.error === 'unknown') r.results.push({ txid, status: 'unknown', depth: undefined })
        else if (d.error !== undefined) {
          r.results.push({ txid, status: 'unknown', depth: undefined })
        } else if (d.confirmations === undefined) r.results.push({ txid, status: 'known', depth: 0 })
        else r.results.push({ txid, status: 'mined', depth: d.confirmations })
      }
      r.status = 'success'
      return validateStatusForTxidsResult(r, normalizedTxids, r.name)
    } catch (error_: unknown) {
      const e = WalletError.fromUnknown(error_)
      r.status = 'error'
      r.error = e
      r.results = []
    }

    return r
  }

  /**
   * 2025-02-16 throwing internal server error 500.
   * @param txid
   * @returns
   */
  async getTxPropagation(txid: string): Promise<number> {
    const requestOptions = {
      method: 'GET',
      headers: this.getHttpHeaders()
    }

    const response = await this.request<string>(`${this.URL}/tx/hash/${txid}/propagation`, requestOptions)

    // response.statusText is often, but not always 'OK' on success...
    if (!response.data || !response.ok || response.status !== 200) {
      throw new WERR_INVALID_PARAMETER('txid', `valid transaction. '${txid}' response ${response.statusText}`)
    }

    return 0
  }

  /**
   * May return undefined for unmined transactions that are in the mempool.
   * @param txid
   * @returns raw transaction as hex string or undefined if txid not found in mined block.
   */
  async getRawTx(txid: string): Promise<string | undefined> {
    const normalizedTxid = normalizeTxid(txid)
    const headers = this.getHttpHeaders()
    headers['Cache-Control'] = 'no-cache'

    const requestOptions = {
      method: 'GET',
      headers
    }

    const url = `${this.URL}/tx/${normalizedTxid}/hex`

    for (let retry = 0; retry < 2; retry++) {
      const response = await this.request<string>(url, requestOptions)
      if (response.statusText === 'Too Many Requests' && retry < 2) {
        await wait(2000)
        continue
      }

      if (response.status === 404 && response.statusText === 'Not Found') return undefined

      // response.statusText is often, but not always 'OK' on success...
      if (!response.data || !response.ok || response.status !== 200) {
        throw new WERR_INVALID_PARAMETER('txid', `valid transaction. '${txid}' response ${response.statusText}`)
      }

      if (
        response.data.length === 0 ||
        response.data.length > MAX_RAW_TRANSACTION_BYTES * 2 ||
        response.data.length % 2 !== 0 ||
        !/^[0-9a-fA-F]+$/.test(response.data)
      ) {
        throw new WERR_INVALID_OPERATION('WhatsOnChain returned malformed or excessive raw transaction data.')
      }
      return response.data.toLowerCase()
    }
    throw new WERR_INTERNAL()
  }

  async getRawTxResult(txid: string): Promise<GetRawTxResult> {
    const normalizedTxid = normalizeTxid(txid)
    const r: GetRawTxResult = { name: 'WoC', txid: normalizedTxid }

    try {
      const rawTxHex = await this.getRawTx(normalizedTxid)
      if (rawTxHex) r.rawTx = asArray(rawTxHex)
    } catch (err: unknown) {
      r.error = WalletError.fromUnknown(err)
    }

    return validateRawTxResult(r, normalizedTxid, 'WoC')
  }

  /**
   * WhatsOnChain does not natively support a postBeef end-point aware of multiple txids of interest in the Beef.
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
    const r: PostBeefResult = {
      name: 'WoC',
      status: 'success',
      txidResults: [],
      notes: []
    }

    let delay = false

    const nn = () => ({ name: 'WoCpostBeef', when: new Date().toISOString() })
    const nne = () => ({ ...nn(), beef: beef.toHex(), txids: txids.join(',') })

    for (const txid of txids) {
      const rawTx = toHex(beef.findTxid(txid)!.rawTx!)

      if (delay) {
        // For multiple txids, give WoC time to propagate each one.
        await wait(3000)
      }
      delay = true

      const tr = await this.postRawTx(rawTx)
      if (txid !== tr.txid) {
        tr.notes!.push({ ...nne(), what: 'postRawTxTxidChanged', txid, trTxid: tr.txid })
      }

      r.txidResults.push(tr)
      if (r.status === 'success' && tr.status !== 'success') r.status = 'error'
    }

    if (r.status === 'success') {
      r.notes!.push({ ...nn(), what: 'postBeefSuccess' })
    } else {
      r.notes!.push({ ...nne(), what: 'postBeefError' })
    }

    return validatePostBeefResultOrServiceError(r, txids, 'WoC')
  }

  /**
   * @param rawTx raw transaction to broadcast as hex string
   * @returns txid returned by transaction processor of transaction broadcast
   */
  async postRawTx(rawTx: HexString): Promise<PostTxResultForTxid> {
    rawTx = normalizePostRawHex(rawTx, MAX_RAW_TRANSACTION_BYTES)
    const txid = toHex(doubleSha256BE(toArray(rawTx, 'hex')))

    const r: PostTxResultForTxid = {
      txid,
      status: 'success',
      notes: []
    }

    const headers = this.getHttpHeaders()
    headers['Content-Type'] = 'application/json'
    headers.Accept = 'text/plain'

    const requestOptions = {
      method: 'POST',
      headers,
      data: { txhex: rawTx }
    }

    const url = `${this.URL}/tx/raw`
    const nn = () => ({ name: 'WoCpostRawTx', when: new Date().toISOString() })
    const nne = () => ({ ...nn(), rawTx, txid, url })

    const retryLimit = 5
    for (let retry = 0; retry < retryLimit; retry++) {
      try {
        const response = await this.request<string>(url, requestOptions)
        if (response.statusText === 'Too Many Requests' && retry < 2) {
          r.notes!.push({ ...nn(), what: 'postRawTxRateLimit' })
          await wait(2000)
          continue
        }
        if (response.ok) {
          r.notes!.push({ ...nn(), what: 'postRawTxSuccess' })
        } else if (response.data === 'unexpected response code 500: Transaction already in the mempool') {
          r.notes!.push({ ...nne(), what: 'postRawTxSuccessAlreadyInMempool' })
        } else {
          handlePostRawTxErrorResponse(r, nne, response)
        }
      } catch (error_: unknown) {
        r.status = 'error'
        const e = WalletError.fromUnknown(error_)
        r.notes!.push({
          ...nne(),
          what: 'postRawTxCatch',
          code: e.code,
          description: e.description
        })
        r.serviceError = true
        r.data = `${e.code} ${e.description}`
      }
      return validatePostTxResultOrServiceError(r, txid, 'WoC')
    }
    r.status = 'error'
    r.serviceError = true
    r.notes!.push({
      ...nne(),
      what: 'postRawTxRetryLimit',
      retryLimit
    })
    return validatePostTxResultOrServiceError(r, txid, 'WoC')
  }

  async updateBsvExchangeRate(rate?: BsvExchangeRate, updateMsecs?: number): Promise<BsvExchangeRate> {
    if (rate != null) {
      // Check if the rate we know is stale enough to update.
      updateMsecs ||= 1000 * 60 * 15
      if (new Date(Date.now() - updateMsecs) < rate.timestamp) return rate
    }

    const requestOptions = {
      method: 'GET',
      headers: this.getHttpHeaders()
    }

    for (let retry = 0; retry < 2; retry++) {
      const response = await this.request<{
        rate: number
        time: number
        currency: string
      }>(`${this.URL}/exchangerate`, requestOptions)
      if (response.statusText === 'Too Many Requests' && retry < 2) {
        await wait(2000)
        continue
      }

      // response.statusText is often, but not always 'OK' on success...
      if (!response.data || !response.ok || response.status !== 200) {
        throw new WERR_INVALID_OPERATION(`WoC exchangerate response ${response.statusText}`)
      }

      const wocrate = response.data
      if (wocrate.currency !== 'USD') wocrate.rate = Number.NaN

      const newRate: BsvExchangeRate = {
        timestamp: new Date(),
        base: 'USD',
        rate: wocrate.rate
      }

      return newRate
    }
    throw new WERR_INTERNAL()
  }

  async getUtxoStatus(
    output: string,
    outputFormat?: GetUtxoStatusOutputFormat,
    outpoint?: string
  ): Promise<GetUtxoStatusResult> {
    const r: GetUtxoStatusResult = { name: 'WoC', status: 'error', error: new WERR_INTERNAL(), details: [] }
    const scriptHash = validateScriptHash(output, outputFormat)
    const url = `${this.URL}/script/${scriptHash}/unspent/all`
    const requestOptions = { method: 'GET', headers: this.getHttpHeaders() }

    for (let retry = 0; retry <= 2; retry++) {
      try {
        const response = await this.request<WhatsOnChainUtxoStatus>(url, requestOptions)
        if (response.statusText === 'Too Many Requests' && retry < 2) {
          await wait(2000)
          continue
        }
        this.applyUtxoStatusResponse(r, response, scriptHash, outpoint)
        return r
      } catch (error_: unknown) {
        const shouldRetry = handleUtxoConnReset(r, error_, url, retry, 2)
        if (!shouldRetry) return r
      }
    }
    return r
  }

  private applyUtxoStatusResponse(
    r: GetUtxoStatusResult,
    response: { data?: WhatsOnChainUtxoStatus; ok: boolean; status: number; statusText: string },
    scriptHash: string,
    outpoint?: string
  ): void {
    if (!response.data || !response.ok || response.status !== 200) {
      throw new WERR_INVALID_OPERATION(`WoC getUtxoStatus response ${response.statusText}`)
    }
    const data = response.data
    requirePlainDataRecord(data, 'WhatsOnChain UTXO status')
    if (data.script !== scriptHash) throw new WERR_INTERNAL('WhatsOnChain UTXO status script hash mismatch')
    const details = requireDenseWocArray(data.result, 'WhatsOnChain UTXO status result').map((candidate, index) => {
      requirePlainDataRecord(candidate, `WhatsOnChain UTXO status result[${index}]`)
      return {
        txid: requireHex32(candidate.tx_hash, `WhatsOnChain UTXO status result[${index}].tx_hash`),
        satoshis: requireInteger(
          candidate.value,
          `WhatsOnChain UTXO status result[${index}].value`,
          Number.MAX_SAFE_INTEGER
        ),
        height: requireInteger(candidate.height, `WhatsOnChain UTXO status result[${index}].height`, MAX_BLOCK_HEIGHT),
        index: requireInteger(candidate.tx_pos, `WhatsOnChain UTXO status result[${index}].tx_pos`, UINT32_MAX)
      }
    })
    const normalizedOutpoint = normalizeWalletOutpoint(outpoint)
    r.status = 'success'
    r.error = undefined
    r.details = details
    r.isUtxo =
      normalizedOutpoint == null
        ? details.length > 0
        : details.some(detail => `${detail.txid}.${detail.index}` === normalizedOutpoint)
    Object.assign(r, validateUtxoStatusResult(r, normalizedOutpoint, 'WoC'))
  }

  async getScriptHashConfirmedHistory(hash: string): Promise<GetScriptHashHistoryResult> {
    const r: GetScriptHashHistoryResult = {
      name: 'WoC',
      status: 'error',
      error: undefined,
      history: []
    }

    // Convert the exact little-endian wallet hash to the big-endian WoC route.
    hash = validateScriptHash(hash, 'hashLE')

    const url = `${this.URL}/script/${hash}/confirmed/history`
    const methodName = 'getScriptHashConfirmedHistory'

    for (let retry = 0; retry <= 2; retry++) {
      try {
        const requestOptions = { method: 'GET', headers: this.getHttpHeaders() }
        const response = await this.request<WhatsOnChainScriptHashHistoryData>(url, requestOptions)
        requirePlainDataRecord(response, 'WhatsOnChain script-history response')
        if (response.data != null) requirePlainDataRecord(response.data, 'WhatsOnChain script-history data')

        const action = handleScriptHashHistoryResponse(r, response as ScriptHashHistoryResponse, methodName, retry)
        if (action === 'continue') {
          await wait(2000)
          continue
        }
        if (action === 'return') return validateScriptHashHistoryResult(r, 'WoC')

        r.history = requireDenseWocArray(response.data!.result, 'WhatsOnChain confirmed script history').map(
          (candidate, index) => {
            requirePlainDataRecord(candidate, `WhatsOnChain confirmed script history[${index}]`)
            const txid = requireHex32(candidate.tx_hash, `WhatsOnChain confirmed script history[${index}].tx_hash`)
            const height = requireInteger(
              candidate.height,
              `WhatsOnChain confirmed script history[${index}].height`,
              MAX_BLOCK_HEIGHT
            )
            return { txid, height }
          }
        )
        r.status = 'success'
        return validateScriptHashHistoryResult(r, 'WoC')
      } catch (error_: unknown) {
        const shouldRetry = handleScriptHashHistoryCatch(r, error_, url, methodName, retry, 2)
        if (!shouldRetry) return validateScriptHashHistoryResult(r, 'WoC')
      }
    }

    return r
  }

  async getScriptHashUnconfirmedHistory(hash: string): Promise<GetScriptHashHistoryResult> {
    const r: GetScriptHashHistoryResult = {
      name: 'WoC',
      status: 'error',
      error: undefined,
      history: []
    }

    // Convert the exact little-endian wallet hash to the big-endian WoC route.
    hash = validateScriptHash(hash, 'hashLE')

    const url = `${this.URL}/script/${hash}/unconfirmed/history`
    const methodName = 'getScriptHashUnconfirmedHistory'

    for (let retry = 0; ; retry++) {
      try {
        const requestOptions = { method: 'GET', headers: this.getHttpHeaders() }
        const response = await this.request<WhatsOnChainScriptHashHistoryData>(url, requestOptions)
        requirePlainDataRecord(response, 'WhatsOnChain script-history response')
        if (response.data != null) requirePlainDataRecord(response.data, 'WhatsOnChain script-history data')

        const action = handleScriptHashHistoryResponse(r, response as ScriptHashHistoryResponse, methodName, retry)
        if (action === 'continue') {
          await wait(2000)
          continue
        }
        if (action === 'return') return validateScriptHashHistoryResult(r, 'WoC')

        r.history = requireDenseWocArray(response.data!.result, 'WhatsOnChain unconfirmed script history').map(
          (candidate, index) => {
            requirePlainDataRecord(candidate, `WhatsOnChain unconfirmed script history[${index}]`)
            const txid = requireHex32(candidate.tx_hash, `WhatsOnChain unconfirmed script history[${index}].tx_hash`)
            if (candidate.height !== undefined) {
              requireInteger(
                candidate.height,
                `WhatsOnChain unconfirmed script history[${index}].height`,
                MAX_BLOCK_HEIGHT
              )
            }
            return candidate.height === undefined ? { txid } : { txid, height: candidate.height as number }
          }
        )
        r.status = 'success'
        return validateScriptHashHistoryResult(r, 'WoC')
      } catch (error_: unknown) {
        // Note: original used retry > 2 (not >= 2) for the unconfirmed variant
        const shouldRetry = handleScriptHashHistoryCatch(r, error_, url, methodName, retry, 3)
        if (!shouldRetry) return validateScriptHashHistoryResult(r, 'WoC')
      }
    }
  }

  async getScriptHashHistory(hash: string): Promise<GetScriptHashHistoryResult> {
    const r1 = await this.getScriptHashConfirmedHistory(hash)
    if (r1.error || r1.status !== 'success') return r1
    const r2 = await this.getScriptHashUnconfirmedHistory(hash)
    if (r2.error || r2.status !== 'success') return r2
    return validateScriptHashHistoryResult(
      { name: 'WoC', status: 'success', history: r1.history.concat(r2.history) },
      'WoC'
    )
  }

  /**
    {
      "hash": "000000000000000004a288072ebb35e37233f419918f9783d499979cb6ac33eb",
      "confirmations": 328433,
      "size": 14421,
      "height": 575045,
      "version": 536928256,
      "versionHex": "2000e000",
      "merkleroot": "4ebcba09addd720991d03473f39dce4b9a72cc164e505cd446687a54df9b1585",
      "time": 1553416668,
      "mediantime": 1553414858,
      "nonce": 87914848,
      "bits": "180997ee",
      "difficulty": 114608607557.4425,
      "chainwork": "000000000000000000000000000000000000000000ddf5d385546872bab7dc01",
      "previousblockhash": "00000000000000000988156c7075dc9147a5b62922f1310862e8b9000d46dd9b",
      "nextblockhash": "00000000000000000112b36a37c10235fa0c991f680bc5482ba9692e0ae697db",
      "nTx": 0,
      "num_tx": 5
    }
   */
  async getBlockHeaderByHash(hash: string): Promise<BlockHeader | undefined> {
    const requestedHash = requireHex32(hash, 'hash')
    const headers = this.getHttpHeaders()
    const requestOptions = {
      method: 'GET',
      headers
    }

    const url = `${this.URL}/block/${requestedHash}/header`

    for (let retry = 0; retry < 2; retry++) {
      const response = await this.requestWithAnonymousAuthFallback<WocHeader>(url, requestOptions)
      if (response.statusText === 'Too Many Requests' && retry < 2) {
        await wait(2000)
        continue
      }

      if (response.status === 404 && response.statusText === 'Not Found') return undefined

      // response.statusText is often, but not always 'OK' on success...
      if (!response.data || !response.ok || response.status !== 200) {
        throw new WERR_INVALID_PARAMETER('hash', `valid block hash. '${hash}' response ${response.statusText}`)
      }

      const header = convertWocToBlockHeaderHex(response.data)
      if (header.hash !== requestedHash) {
        throw new WERR_INVALID_PARAMETER(
          'hash',
          `matching block hash. Expected '${requestedHash}', got '${header.hash}'.`
        )
      }

      return header
    }
    throw new WERR_INTERNAL()
  }

  async getChainInfo(): Promise<WocChainInfo> {
    const headers = this.getHttpHeaders()
    const requestOptions = {
      method: 'GET',
      headers
    }

    const url = `${this.URL}/chain/info`

    for (let retry = 0; retry < 2; retry++) {
      const response = await this.requestWithAnonymousAuthFallback<WocChainInfo>(url, requestOptions)
      if (response.statusText === 'Too Many Requests' && retry < 2) {
        await wait(2000)
        continue
      }

      // response.statusText is often, but not always 'OK' on success...
      if (!response.data || !response.ok || response.status !== 200) {
        throw new WERR_INVALID_PARAMETER('hash', `valid block hash. '${url}' response ${response.statusText}`)
      }

      const expectedChain: Chain = this.network === 'ttn' ? 'test' : (this.network as Chain)
      return validateWocChainInfo(response.data, expectedChain)
    }
    throw new WERR_INTERNAL()
  }
}

/**
 *
 */
export class WhatsOnChain extends WhatsOnChainNoServices {
  services: Services

  constructor(chain: Chain = 'main', config: WalletToolboxWhatsOnChainConfig = {}, services?: Services) {
    super(chain, config)
    this.services = services || new Services(chain)
  }

  /**
   * @param txid
   * @returns
   */
  async getMerklePath(txid: string, services: WalletServices): Promise<GetMerklePathResult> {
    const r: GetMerklePathResult = { name: 'WoCTsc', notes: [] }
    const name = r.name!
    const requestOptions = { method: 'GET', headers: this.getHttpHeaders() }
    const url = `${this.URL}/tx/${txid}/proof/tsc`

    for (let retry = 0; retry < 2; retry++) {
      try {
        const response = await this.request<WhatsOnChainTscProof | WhatsOnChainTscProof[]>(url, requestOptions)
        const classification = classifyMerklePathResponse(response.status, response.statusText, retry)

        if (classification === 'retry') {
          r.notes!.push(
            makeMerklePathNote('getMerklePathRetry', name, { status: response.status, statusText: response.statusText })
          )
          await wait(2000)
          continue
        }
        if (classification === 'notFound') {
          r.notes!.push(
            makeMerklePathNote('getMerklePathNotFound', name, {
              status: response.status,
              statusText: response.statusText
            })
          )
          return r
        }
        await this.applyMerklePathResponse(r, name, txid, response, services)
      } catch (error_: unknown) {
        const e = WalletError.fromUnknown(error_)
        r.notes!.push(makeMerklePathNote('getMerklePathError', name, { code: e.code, description: e.description }))
        r.error = e
      }
      return r
    }
    r.notes!.push(makeMerklePathNote('getMerklePathInternal', name))
    throw new WERR_INTERNAL()
  }

  private async applyMerklePathResponse(
    r: GetMerklePathResult,
    name: string,
    txid: string,
    response: { data?: WhatsOnChainTscProof | WhatsOnChainTscProof[]; ok: boolean; status: number; statusText: string },
    services: WalletServices
  ): Promise<void> {
    if (!response.ok || response.status !== 200) {
      r.notes!.push(
        makeMerklePathNote('getMerklePathBadStatus', name, { status: response.status, statusText: response.statusText })
      )
      throw new WERR_INVALID_PARAMETER('txid', `valid transaction. '${txid}' response ${response.statusText}`)
    }
    if (!response.data) {
      // Unmined, proof not yet available.
      r.notes!.push(
        makeMerklePathNote('getMerklePathNoData', name, { status: response.status, statusText: response.statusText })
      )
      return
    }
    if (!Array.isArray(response.data)) response.data = [response.data]
    if (response.data.length !== 1) return

    const p = response.data[0]
    const target = normalizeTxid(p.target, 'TSC proof target')
    const header = await services.hashToHeader(target)
    if (header) {
      if (normalizeTxid(header.hash, 'TSC proof header hash') !== target) {
        throw new WERR_INVALID_PARAMETER('blockhash', 'the requested canonical block header')
      }
      const candidate = {
        merklePath: convertProofToMerklePath(txid, { index: p.index, nodes: p.nodes, height: header.height }),
        header
      }
      const validated = validateMerklePathResult(txid, candidate)
      r.merklePath = validated.merklePath
      r.header = validated.header
      r.notes!.push(
        makeMerklePathNote('getMerklePathSuccess', name, { status: response.status, statusText: response.statusText })
      )
    } else {
      r.notes!.push(
        makeMerklePathNote('getMerklePathNoHeader', name, {
          target: p.target,
          status: response.status,
          statusText: response.statusText
        })
      )
      throw new WERR_INVALID_PARAMETER('blockhash', 'a valid on-chain block hash')
    }
  }
}

interface WhatsOnChainTscProof {
  index: number
  nodes: string[]
  target: string
  txOrId: string
}

interface WhatsOnChainScriptHashHistory {
  tx_hash: string
  height?: number
}

interface WhatsOnChainScriptHashHistoryData {
  script: string
  result: WhatsOnChainScriptHashHistory[]
  error?: string
  nextPageToken?: string
}

interface WhatsOnChainTxsStatusData {
  txid: string
  blockhash?: string
  blockheight?: number
  blocktime?: number
  confirmations?: number
  /**
   * 'unknown' if txid isn't known
   */
  error?: string
}

/**
 * GET https://api.whatsonchain.com/v1/bsv/<network>/script/<scriptHash>/unspent/all
 *
 * Response
{
  "error":"",
  "status":200,
  "statusText":"OK",
  "ok":true,
  "data":{
    "script":"d3ef8eeb691e7405caca142bfcd6f499b142884d7883e6701a0ee76047b4af32",
    "result":[
      {
        "height":893652,
        "tx_pos":11,
        "tx_hash":"2178a1e93d46edda946d9069f9b157ddfacb451fee0278e657941f09bfdb5d8f",
        "value":1005,
        "isSpentInMempoolTx":false,
        "status":"confirmed"
      }
    ]
  }
}
 *
 */
interface WhatsOnChainUtxoStatus {
  script: string
  result: Array<{
    value: number
    height: number
    tx_pos: number
    tx_hash: string
    isSpentInMempoolTx: boolean
    status: string // 'confirmed'
  }>
}

export interface WocChainInfo {
  chain: string // "main",
  blocks: number // 635302,
  headers: number // 635299,
  bestblockhash: string // "000000000000000002a40d7410a6c08109521c14f4cf354e7b352b4eab8aa4ea",
  difficulty: number // 287310033717.7086,
  mediantime: number // 1589703256,
  verificationprogress: number // 0.9999754124031851,
  pruned: boolean // false,
  chainwork: string // "0000000000000000000000000000000000000000010969f724913e0fe59377f4"
}

// WhatsOnChain headers looks like:
export interface WocHeader {
  hash: string // "00000000000000000836c9c44151acbf374c6d4a9713d43b5e95011bdbd1ff2e"
  size: number // 71646128,
  height: number // 760633,
  version: number // 712441856,
  versionHex: string // "2a770000",
  merkleroot: string // "af80d255ca21d9ccdd2cc3576dc532adc7fcbc324ce2db3dec8d54079b56a001",
  time: number // 1665274100,
  mediantime: number // 1665270280,
  nonce: number // 618555943,
  bits: number | string // decimal of ox180dc8e5,
  difficulty: number // 79761715531.82063,
  chainwork: string // "0000000000000000000000000000000000000000013d02d8de0ec6cd019bb3a1",
  previousblockhash: string // "00000000000000000272ad9db518e5eeac702f1b00ffa6dc9605f687301dda99",

  confirmations: number // 3,
  txcount: number // 45168,
  nextblockhash: string // "000000000000000004e01d72ccb7502f0412cc12d7e50f6fafa99ac6f89fd063",
  // coinbaseTx
  // orphaned
}

export function convertWocToBlockHeaderHex(woc: WocHeader): BlockHeader {
  requirePlainDataRecord(woc, 'WhatsOnChain header')
  const height = requireInteger(woc.height, 'WhatsOnChain header height', MAX_BLOCK_HEIGHT)
  const previousHash =
    woc.previousblockhash == null || woc.previousblockhash === ''
      ? height === 0
        ? '0'.repeat(64)
        : (() => {
            throw new Error('WhatsOnChain header previousblockhash is missing for a non-genesis header.')
          })()
      : requireHex32(woc.previousblockhash, 'WhatsOnChain header previousblockhash')
  const header: BlockHeader = {
    version: requireInteger(woc.version, 'WhatsOnChain header version', UINT32_MAX),
    previousHash,
    merkleRoot: requireHex32(woc.merkleroot, 'WhatsOnChain header merkleroot'),
    time: requireInteger(woc.time, 'WhatsOnChain header time', UINT32_MAX),
    bits: requireHeaderBits(woc.bits),
    nonce: requireInteger(woc.nonce, 'WhatsOnChain header nonce', UINT32_MAX),
    hash: requireHex32(woc.hash, 'WhatsOnChain header hash'),
    height
  }
  validateHeaderFormat(header)
  validateHeaderProofOfWork(header)
  return header
}

export async function getWhatsOnChainBlockHeaderByHash(
  hash: string,
  chain: Chain = 'main',
  apiKey?: string
): Promise<BlockHeader | undefined> {
  const config = apiKey ? { apiKey } : {}
  const woc = new WhatsOnChain(chain, config)
  const header = await woc.getBlockHeaderByHash(hash)
  return header
}
