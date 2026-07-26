import {
  Beef,
  defaultHttpClient,
  HexString,
  HttpClient,
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
    const nn = (): { name: string; when: string } => ({ name: this.name, when: new Date().toISOString() })
    const nne = () => ({ ...nn(), rawTx, txids: txids.join(','), url })

    try {
      const response = await this.httpClient.request<ArcadeResponse>(url, requestOptions)

      const { txid, extraInfo, txStatus, competingTxs } = response.data
      const nnr = () => ({
        txid,
        extraInfo,
        txStatus,
        competingTxs: competingTxs?.join(',')
      })

      if (response.ok) {
        // Arcade's 202 submit response omits extraInfo; avoid a trailing 'undefined'.
        r.data = extraInfo != null && extraInfo !== '' ? `${txStatus} ${extraInfo}` : `${txStatus}`
        if (r.txid !== txid) r.data += ` txid altered from ${r.txid} to ${txid}`
        r.txid = txid
        if (isArcDoubleSpendTxStatus(txStatus)) {
          r.status = 'error'
          r.doubleSpend = true
          r.competingTxs = competingTxs
          r.notes!.push({ ...nne(), ...nnr(), what: 'postRawTxDoubleSpend' })
        } else {
          r.notes!.push({ ...nn(), ...nnr(), what: 'postRawTxSuccess' })
        }
      } else if (typeof response === 'string') {
        r.notes!.push({ ...nne(), what: 'postRawTxString', response })
        r.status = 'error'
        // response is not normally a string
        r.serviceError = true
      } else {
        r.status = 'error'
        // Arcade returns HTTP 400 for terminal validation errors — surface those as
        // invalid-transaction status errors while keeping rate limits, batch limits,
        // 5xx/backpressure and unknown failures as service errors.
        const n: ReqHistoryNote = {
          ...nn(),
          ...nne(),
          ...nnr(),
          what: 'postRawTxError'
        }
        const ed: PostTxResultForTxidError = {}
        r.data = ed
        const st = typeof response.status
        let status: number | undefined
        if (st === 'number' || st === 'string') {
          n.status = response.status
          ed.status = response.status.toString()
          if (typeof response.status === 'number') status = response.status
          else {
            const parsed = Number(response.status)
            if (Number.isFinite(parsed)) status = parsed
          }
        } else {
          n.status = st
          ed.status = 'ERR_UNKNOWN'
        }

        const d = response.data
        if (d && typeof d === 'string') {
          n.data = (response.data as string).slice(0, 128)
        } else if (d && typeof d === 'object') {
          ed.more = d
          ed.detail = (d as { detail?: unknown }).detail as string | undefined
          if (typeof ed.detail !== 'string') ed.detail = undefined
          if (ed.detail) {
            n.detail = ed.detail
          }
        }
        r.serviceError = isArcServiceErrorStatus(status, ed.detail)
        r.notes!.push(n)
      }
    } catch (error_: unknown) {
      const e = WalletError.fromUnknown(error_)
      r.status = 'error'
      r.serviceError = true
      r.data = `${e.code} ${e.message}`
      r.notes!.push({
        ...nne(),
        what: 'postRawTxCatch',
        code: e.code,
        description: e.description
      })
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
