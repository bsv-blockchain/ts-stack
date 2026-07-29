import {
  Beef,
  defaultHttpClient,
  HexString,
  HttpClient,
  HttpClientResponse,
  HttpClientRequestOptions,
  MerklePath,
  Random,
  Utils
} from '@bsv/sdk'
import {
  GetMerklePathResult,
  PostBeefResult,
  PostTxResultForTxid,
  PostTxResultForTxidError,
  WalletServices
} from '../../sdk/WalletServices.interfaces'
import { doubleSha256BE } from '../../utility/utilityHelpers'
import { ReqHistoryNote } from '../../sdk/types'
import { WalletError } from '../../sdk/WalletError'
// Shared wire-contract types only (no behavior coupling): Arcade is ARC-compatible on the
// configuration and `getTxData` response shape, so it reuses those interfaces.
import { ArcConfig, ArcMinerGetTxData, isArcDoubleSpendTxStatus, isArcServiceErrorStatus } from './ARC'

function defaultDeploymentId(): string {
  return `ts-sdk-${Utils.toHex(Random(16))}`
}

// Storage sendWith can aggregate many transactions into one BEEF. Arcade accepts
// one EF transaction per request, so submit independent transactions concurrently
// while preserving dependency order and avoiding an unbounded burst.
export const ARCADE_POST_BEEF_CONCURRENCY = 4

interface ArcadePostNoteContext {
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
 * Broadcaster for bsv-blockchain/arcade — the Teranode-native, ARC-compatible broadcaster.
 *
 * Arcade is intentionally a separate, self-contained class (not a subclass of {@link ARC}) so
 * the audited ARC transport is never altered. It is ARC-compatible on headers, configuration and
 * the `getTxData` response shape — but differs where it must:
 *
 *  - Endpoints are served at the root: `/tx` and `/tx/{txid}` (no `/v1` prefix).
 *  - A submit returns HTTP 202; HTTP 400 is a terminal validation failure (REJECTED) and is
 *    surfaced as an invalid-transaction status error rather than a transient service error.
 *  - Submission encoding is Extended Format (EF), not BEEF: Arcade's `/tx` parser rejects BEEF
 *    ("failed to parse transaction") and runs fee/script validation that needs per-input source
 *    data, which EF carries inline.
 */
export class Arcade {
  readonly name: string
  readonly URL: string
  readonly apiKey: string | undefined
  readonly deploymentId: string
  readonly callbackUrl: string | undefined
  readonly callbackToken: string | undefined
  readonly headers: Record<string, string> | undefined
  private readonly httpClient: HttpClient

  /**
   * @param URL - The Arcade endpoint base URL.
   * @param config - Arcade configuration (shares ARC's {@link ArcConfig} shape).
   */
  constructor(URL: string, config?: ArcConfig, name?: string)
  constructor(URL: string, apiKey?: string, name?: string)
  constructor(URL: string, config?: string | ArcConfig, name?: string) {
    this.name = name ?? 'arcade'
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

  /** Constructs a dictionary of the default & supplied request headers. */
  private requestHeaders(): Record<string, string> {
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

  private applySuccessfulPostRawTx(
    result: PostTxResultForTxid,
    data: ArcadeResponse,
    notes: ArcadePostNoteContext
  ): void {
    const { txid, extraInfo, txStatus, competingTxs } = data
    result.data = extraInfo != null && extraInfo !== '' ? `${txStatus} ${extraInfo}` : `${txStatus}`
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

  private applyFailedPostRawTx(
    result: PostTxResultForTxid,
    response: Exclude<HttpClientResponse<ArcadeResponse>, { ok: true }>,
    data: ArcadeResponse,
    notes: ArcadePostNoteContext
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

  private applyPostRawTxResponse(
    result: PostTxResultForTxid,
    response: HttpClientResponse<ArcadeResponse>,
    notes: ArcadePostNoteContext
  ): void {
    if (response.ok) {
      this.applySuccessfulPostRawTx(result, response.data, notes)
    } else {
      this.applyFailedPostRawTx(result, response, response.data as ArcadeResponse, notes)
    }
  }

  private applyPostRawTxCatch(
    result: PostTxResultForTxid,
    error_: unknown,
    notes: ArcadePostNoteContext
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
   * Submit a single transaction to Arcade's `POST /tx` endpoint.
   *
   * `rawTx` must be a single (raw or Extended Format) transaction hex — NOT BEEF. The canonical
   * txid is taken from `txids` when supplied (Arcade derives the same txid from the parsed tx).
   */
  async postRawTx(rawTx: HexString, txids?: string[]): Promise<PostTxResultForTxid> {
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

    const url = `${this.URL}/tx`
    const notes: ArcadePostNoteContext = {
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
      const response = await this.httpClient.request<ArcadeResponse>(url, requestOptions)
      this.applyPostRawTxResponse(r, response, notes)
    } catch (error_: unknown) {
      this.applyPostRawTxCatch(r, error_, notes)
    }

    return r
  }

  /**
   * Post each tx of interest as Extended Format (EF).
   *
   * EF needs each input's source output (satoshis + locking script). For a BEEF that carries every
   * direct parent transaction in full (e.g. the atomic BEEF produced by createAction), that data is
   * present and {@link Transaction.fromBEEF} can reconstruct EF. A BEEF is NOT guaranteed to contain
   * it, however: BEEF V2 `txidOnly` entries (or an otherwise pruned BEEF) can reference a direct
   * parent without its bytes, leaving no source output to embed — so BEEF -> EF is not always
   * possible. When EF cannot be built for a txid, it is recorded as a (non-terminal) service error
   * so cross-provider aggregation falls through to a BEEF-capable broadcaster, which can still
   * broadcast the (valid) transaction.
   */
  async postBeef(beef: Beef, txids: string[]): Promise<PostBeefResult> {
    const r: PostBeefResult = {
      name: this.name,
      status: 'success',
      txidResults: Array.from({ length: txids.length }),
      notes: []
    }
    const nn = (): { name: string; when: string } => ({ name: this.name, when: new Date().toISOString() })

    const txidSet = new Set(txids)
    const prepared = txids.map(txid => {
      try {
        // Extract each transaction from the shared parsed bundle.
        // findAtomicTransaction attaches the source-transaction ancestry
        // required by the EF serialization below.
        const tx = beef.findAtomicTransaction(txid)
        if (tx == null) throw new Error(`transaction ${txid} not found in beef`)
        const dependencies = tx.inputs
          .map(input => input.sourceTXID ?? input.sourceTransaction?.id('hex'))
          .filter(
            (sourceTxid): sourceTxid is string => sourceTxid != null && sourceTxid !== txid && txidSet.has(sourceTxid)
          )
        return { txid, efHex: tx.toHexEF(), dependencies }
      } catch (error_: unknown) {
        const e = WalletError.fromUnknown(error_)
        const error: PostTxResultForTxid = {
          txid,
          status: 'error',
          serviceError: true,
          notes: [{ ...nn(), what: 'arcadeEfBuildFailed', txid, code: e.code, description: e.description }]
        }
        return { txid, dependencies: [] as string[], error }
      }
    })
    const indexByTxid = new Map(txids.map((txid, index) => [txid, index]))
    const pending = new Set(txids.map((_, index) => index))

    while (pending.size > 0) {
      let ready = [...pending].filter(index =>
        prepared[index].dependencies.every(dependency => {
          const dependencyIndex = indexByTxid.get(dependency)
          return dependencyIndex == null || !pending.has(dependencyIndex)
        })
      )
      // A valid transaction graph is acyclic. Preserve forward progress for a
      // malformed/cyclic graph and let Arcade return the authoritative error.
      if (ready.length === 0) ready = [[...pending][0]]

      let nextReady = 0
      const worker = async (): Promise<void> => {
        while (nextReady < ready.length) {
          const index = ready[nextReady++]
          const item = prepared[index]
          r.txidResults[index] = item.error ?? (await this.postRawTx(item.efHex, [item.txid]))
        }
      }

      await Promise.all(Array.from({ length: Math.min(ARCADE_POST_BEEF_CONCURRENCY, ready.length) }, worker))
      for (const index of ready) pending.delete(index)
    }
    if (r.txidResults.some(result => result.status === 'error')) r.status = 'error'

    return r
  }

  /** Look up a transaction's current status (and merkle path once mined) via `GET /tx/{txid}`. */
  async getTxData(txid: string): Promise<ArcMinerGetTxData> {
    const requestOptions: HttpClientRequestOptions = {
      method: 'GET',
      headers: this.requestHeaders()
    }

    const response = await this.httpClient.request<ArcMinerGetTxData>(`${this.URL}/tx/${txid}`, requestOptions)

    return response.data
  }

  /**
   * `getMerklePath` provider: obtain a BUMP merkle proof for a mined transaction from Arcade.
   *
   * Arcade only has a proof for transactions it tracked (i.e. broadcast through it) that have
   * been mined while tracked; for anything else `GET /tx/{txid}` reports a non-mined status (or
   * 404) and this returns no `merklePath`, so {@link Services.getMerklePath} falls through to the
   * other providers (WhatsOnChain/Bitails).
   *
   * The proof is NOT trusted blindly: the canonical block header is resolved from the wallet's
   * own chaintracker via `services.hashToHeader(blockHash)` (which only knows real, mined blocks),
   * and the BUMP's computed merkle root must equal that header's `merkleRoot`. Only then is the
   * proof returned, with the canonical `header` that downstream proof completion requires.
   */
  async getMerklePath(txid: string, services: WalletServices): Promise<GetMerklePathResult> {
    const r: GetMerklePathResult = { name: this.name, notes: [] }
    const nn = (): { name: string; when: string } => ({ name: this.name, when: new Date().toISOString() })

    try {
      const data = await this.getTxData(txid)
      const mined = data.txStatus === 'MINED' || data.txStatus === 'IMMUTABLE'
      if (
        !mined ||
        data.merklePath == null ||
        data.merklePath === '' ||
        data.blockHash == null ||
        data.blockHash === ''
      ) {
        // No proof from Arcade yet (not mined / untracked / 404) — fall through to other providers.
        r.notes!.push({ ...nn(), what: 'getMerklePathArcadeNoProof', txid, txStatus: data.txStatus })
        return r
      }

      const merklePath = MerklePath.fromHex(data.merklePath)
      // Resolve the canonical header from our own chaintracker; throws if the block is unknown.
      const header = await services.hashToHeader(data.blockHash)
      const computedRoot = merklePath.computeRoot(txid)
      if (computedRoot !== header.merkleRoot) {
        // Arcade's BUMP does not reconcile with the canonical block — reject and fall through.
        r.notes!.push({
          ...nn(),
          what: 'getMerklePathArcadeRootMismatch',
          txid,
          computedRoot,
          headerRoot: header.merkleRoot,
          blockHash: data.blockHash
        })
        return r
      }

      r.merklePath = merklePath
      r.header = header
      r.notes!.push({
        ...nn(),
        what: 'getMerklePathArcadeSuccess',
        txid,
        height: header.height,
        blockHash: header.hash
      })
    } catch (error_: unknown) {
      const e = WalletError.fromUnknown(error_)
      r.error = e
      r.notes!.push({ ...nn(), what: 'getMerklePathArcadeError', txid, code: e.code, description: e.description })
    }

    return r
  }
}

/** Arcade's `POST /tx` response body. `extraInfo`/`competingTxs` are absent on the 202. */
interface ArcadeResponse {
  txid: string
  extraInfo?: string
  txStatus: string
  competingTxs?: string[]
  status?: number
}
