import { Validation } from '@bsv/sdk'
import { WERR_BAD_REQUEST, WERR_INTERNAL } from '../../sdk/WERR_errors'
import { WalletError } from '../../sdk/WalletError'
import {
  GetScriptHashHistoryResult,
  GetUtxoStatusResult,
  PostTxResultForTxid
} from '../../sdk/WalletServices.interfaces'
import { ReqHistoryNote } from '../../sdk/types'

// ---------------------------------------------------------------------------
// postRawTx helpers
// ---------------------------------------------------------------------------

/** Handle a double-spend / missing-inputs error response from WoC */
function handleDoubleSpendError (
  r: PostTxResultForTxid,
  nne: () => Record<string, unknown>,
  what: string
): void {
  r.doubleSpend = true
  r.competingTxs = undefined
  r.notes!.push({ ...nne(), what })
}

/** Handle any other non-OK, non-recognised error response from WoC */
function handleGenericPostError (
  r: PostTxResultForTxid,
  nne: () => Record<string, unknown>,
  response: { data?: unknown; statusText?: unknown; status?: unknown }
): void {
  const n: ReqHistoryNote = { ...nne(), what: 'postRawTxError' }
  if (typeof response.data === 'string') {
    n.data = response.data.slice(0, 128)
    r.data = response.data
  } else {
    r.data = ''
  }
  if (typeof response.statusText === 'string') {
    n.statusText = response.statusText.slice(0, 128)
    r.data += `,${response.statusText}`
  }
  if (typeof response.status === 'string') {
    n.status = (response.status as string).slice(0, 128)
    r.data += `,${response.status}`
  }
  if (typeof response.status === 'number') {
    n.status = response.status
    r.data += `,${response.status}`
  }
  r.notes!.push(n)
}

/**
 * Classify an error-status WoC response and mutate `r` accordingly.
 */
export function handlePostRawTxErrorResponse (
  r: PostTxResultForTxid,
  nne: () => Record<string, unknown>,
  response: { data?: unknown; statusText?: unknown; status?: unknown; ok?: boolean }
): void {
  r.status = 'error'
  const data = response.data as string | undefined
  if (data === 'unexpected response code 500: 258: txn-mempool-conflict') {
    handleDoubleSpendError(r, nne, 'postRawTxErrorMempoolConflict')
  } else if (data === 'unexpected response code 500: Missing inputs') {
    handleDoubleSpendError(r, nne, 'postRawTxErrorMissingInputs')
  } else {
    handleGenericPostError(r, nne, response)
  }
}

// ---------------------------------------------------------------------------
// getUtxoStatus helpers
// ---------------------------------------------------------------------------

/** Populate UTXO details from a WoC result array */
export function populateUtxoDetails (
  r: GetUtxoStatusResult,
  result: Array<{ tx_hash: string; value: number; height: number; tx_pos: number }>,
  outpoint?: string
): void {
  for (const s of result) {
    r.details.push({
      txid: s.tx_hash,
      satoshis: s.value,
      height: s.height,
      index: s.tx_pos
    })
  }
  if (outpoint) {
    const { txid, vout } = Validation.parseWalletOutpoint(outpoint)
    r.isUtxo = r.details.some(d => d.txid === txid && d.index === vout)
  } else {
    r.isUtxo = r.details.length > 0
  }
}

/**
 * Decide whether the ECONNRESET error is retryable and, if not, set `r.error`.
 * Returns true when the caller should retry, false when it should return.
 */
export function handleUtxoConnReset (
  r: GetUtxoStatusResult,
  error_: unknown,
  url: string,
  retry: number,
  maxRetry: number
): boolean {
  const e = WalletError.fromUnknown(error_)
  if (e.code === 'ECONNRESET' && retry < maxRetry) return true
  r.error = new WERR_INTERNAL(
    `service failure: ${url}, error: ${JSON.stringify(e)}`
  )
  return false
}

// ---------------------------------------------------------------------------
// getScriptHashHistory helpers (shared between confirmed + unconfirmed)
// ---------------------------------------------------------------------------

export interface ScriptHashHistoryResponse {
  ok: boolean
  status: number
  statusText: string
  data?: {
    result: Array<{ tx_hash: string; height?: number }>
    error?: string
  }
}

/**
 * Inspect a WoC script-hash history response and update `r` in-place.
 *
 * Returns:
 *  - `'continue'`  — rate-limited, caller should retry
 *  - `'return'`    — done, caller should return `r`
 *  - `'ok'`        — response was successful, continue parsing
 */
export function handleScriptHashHistoryResponse (
  r: GetScriptHashHistoryResult,
  response: ScriptHashHistoryResponse,
  methodName: string,
  retry: number
): 'continue' | 'return' | 'ok' {
  if (response.statusText === 'Too Many Requests' && retry < 2) {
    return 'continue'
  }

  if (!response.ok && response.status === 404) {
    r.status = 'success'
    return 'return'
  }

  if (!response.data || !response.ok || response.status !== 200) {
    r.error = new WERR_BAD_REQUEST(
      `WoC ${methodName} response ${response.ok} ${response.status} ${response.statusText}`
    )
    return 'return'
  }

  if (response.data.error) {
    r.error = new WERR_BAD_REQUEST(`WoC ${methodName} error ${response.data.error}`)
    return 'return'
  }

  return 'ok'
}

/**
 * Decide whether a caught error is retryable for script-hash history calls.
 * If not retryable, sets `r.error` and returns false.
 */
export function handleScriptHashHistoryCatch (
  r: GetScriptHashHistoryResult,
  error_: unknown,
  url: string,
  methodName: string,
  retry: number,
  maxRetry: number
): boolean {
  const e = WalletError.fromUnknown(error_)
  if (e.code === 'ECONNRESET' && retry < maxRetry) return true
  r.error = new WERR_INTERNAL(
    `WoC ${methodName} service failure: ${url}, error: ${JSON.stringify(e)}`
  )
  return false
}

// ---------------------------------------------------------------------------
// getMerklePath helpers
// ---------------------------------------------------------------------------

export type MerklePathNoteWhat =
  | 'getMerklePathRetry'
  | 'getMerklePathNotFound'
  | 'getMerklePathBadStatus'
  | 'getMerklePathNoData'
  | 'getMerklePathSuccess'
  | 'getMerklePathNoHeader'
  | 'getMerklePathError'
  | 'getMerklePathInternal'

export interface MerklePathNote {
  what: MerklePathNoteWhat
  name: string
  status?: number
  statusText?: string
  target?: string
  code?: string
  description?: string
  [key: string]: boolean | string | number | undefined
}

export function makeMerklePathNote (
  what: MerklePathNoteWhat,
  name: string,
  extra: Partial<MerklePathNote> = {}
): MerklePathNote {
  return { what, name, ...extra }
}

/**
 * Classify a non-OK status response for getMerklePath.
 *
 * Returns `'retry'` when the request was rate-limited and the caller should retry,
 * `'notFound'` for 404, `'badStatus'` for other non-200 codes.
 */
export function classifyMerklePathResponse (
  status: number,
  statusText: string,
  retry: number
): 'retry' | 'notFound' | 'badStatus' | 'ok' {
  if (statusText === 'Too Many Requests' && retry < 2) return 'retry'
  if (status === 404 && statusText === 'Not Found') return 'notFound'
  return 'badStatus'
}
