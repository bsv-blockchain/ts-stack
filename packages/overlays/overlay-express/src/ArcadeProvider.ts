import { BroadcastFailure, Broadcaster, BroadcastResponse, MerklePath, Transaction } from '@bsv/sdk'
import {
  MAX_PROVIDER_ERROR_BYTES,
  MAX_PROVIDER_JSON_BYTES,
  assertBoundedHex,
  assertBoundedString,
  assertHash,
  assertNonnegativeSafeInteger,
  fetchWithDeadline,
  hasControlCharacters,
  isRecord,
  readBoundedText,
  secureServiceFetch,
  snapshotOwnDataRecord
} from './OutboundSecurity.js'

export interface ArcadeProviderConfig {
  apiKey?: string
  callbackUrl?: string
  callbackToken?: string
  deploymentId?: string
  headers?: Record<string, string>
  fetch?: typeof fetch
  /** Permit HTTP/private endpoints only for isolated local development. */
  allowPrivateHosts?: boolean
  requestTimeoutMs?: number
}

export interface ArcadeMerkleProof {
  txid: string
  merklePath: MerklePath
  blockHeight?: number
  blockHash?: string
  merkleRoot: string
}

interface ArcadeTxResponse {
  txid?: string
  txStatus?: string
  status?: number | string
  extraInfo?: string
  detail?: string
  error?: string
  reason?: string
  competingTxs?: string[]
  merklePath?: string
  blockHeight?: number
  blockHash?: string
}

const TERMINAL_STATUSES = new Set([
  'DOUBLE_SPEND_ATTEMPTED',
  'REJECTED',
  'INVALID',
  'MALFORMED',
  'MINED_IN_STALE_BLOCK'
])

const SUCCESS_STATUSES = new Set([
  'RECEIVED',
  'SENT_TO_NETWORK',
  'ANNOUNCED_TO_NETWORK',
  'ACCEPTED_BY_NETWORK',
  'SEEN_ON_NETWORK',
  'STORED',
  'MINED',
  'IMMUTABLE'
])

export function isTerminalArcStatus(status: unknown, extraInfo?: unknown): boolean {
  const statusText = typeof status === 'string' ? status.toUpperCase() : ''
  const extraText = typeof extraInfo === 'string' ? extraInfo.toUpperCase() : ''
  return (
    TERMINAL_STATUSES.has(statusText) ||
    statusText.includes('ORPHAN') ||
    extraText.includes('ORPHAN')
  )
}

function trimBaseUrl(url: string): string {
  let base = url
  while (base.endsWith('/')) base = base.slice(0, -1)
  return base
}

function optionalHeaderValue(value: unknown, label: string, maxBytes: number): string | undefined {
  if (value === undefined || value === '') return undefined
  assertBoundedString(value, label, maxBytes, false)
  if (hasControlCharacters(value)) {
    throw new TypeError(`${label} must not contain control characters`)
  }
  return value
}

function snapshotArcadeConfig(config: ArcadeProviderConfig): Readonly<ArcadeProviderConfig> {
  const value = snapshotOwnDataRecord(config, 'Arcade config')
  if (value.allowPrivateHosts !== undefined && typeof value.allowPrivateHosts !== 'boolean') {
    throw new TypeError('Arcade allowPrivateHosts must be a boolean')
  }
  if (value.fetch !== undefined && typeof value.fetch !== 'function') {
    throw new TypeError('Arcade fetch must be a function')
  }
  const apiKey = optionalHeaderValue(value.apiKey, 'Arcade API key', 16 * 1024)
  const callbackToken = optionalHeaderValue(value.callbackToken, 'Arcade callback token', 16 * 1024)
  const deploymentId = optionalHeaderValue(value.deploymentId, 'Arcade deployment ID', 256)

  let callbackUrl = optionalHeaderValue(value.callbackUrl, 'Arcade callback URL', 2048)
  if (callbackUrl !== undefined) {
    const parsed = new URL(callbackUrl)
    const allowPrivate = value.allowPrivateHosts ?? false
    if (
      (parsed.protocol !== 'https:' && !(allowPrivate && parsed.protocol === 'http:')) ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.hash !== ''
    ) {
      throw new TypeError('Arcade callback URL must be credential-free HTTPS')
    }
    callbackUrl = parsed.toString()
  }

  let headers: Record<string, string> | undefined
  if (value.headers !== undefined) {
    const supplied = snapshotOwnDataRecord(value.headers, 'Arcade headers')
    headers = Object.create(null) as Record<string, string>
    const reserved = new Set([
      'accept',
      'authorization',
      'content-type',
      'x-callbacktoken',
      'x-callbackurl',
      'xdeployment-id'
    ])
    for (const [name, headerValue] of Object.entries(supplied)) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) || reserved.has(name.toLowerCase())) {
        throw new TypeError(`Arcade custom header name is invalid or reserved: ${name}`)
      }
      assertBoundedString(headerValue, `Arcade header ${name}`, 8192, true)
      if (hasControlCharacters(headerValue)) {
        throw new TypeError(`Arcade header ${name} must not contain control characters`)
      }
      headers[name] = headerValue
    }
    headers = Object.freeze(headers)
  }

  return Object.freeze({
    apiKey,
    callbackUrl,
    callbackToken,
    deploymentId,
    headers,
    fetch: value.fetch,
    allowPrivateHosts: value.allowPrivateHosts,
    requestTimeoutMs: value.requestTimeoutMs
  })
}

function parseDescription(data: unknown, fallback: string): string {
  if (typeof data === 'string') return data
  if (typeof data === 'object' && data !== null) {
    const d = data as ArcadeTxResponse
    return (
      d.detail ??
      d.reason ??
      d.error ??
      `${d.txStatus ?? ''} ${d.extraInfo ?? ''}`.trim() ??
      fallback
    )
  }
  return fallback
}

function validateArcadeResponse(value: unknown, expectedTxid?: string): ArcadeTxResponse {
  if (!isRecord(value)) throw new TypeError('Arcade returned an invalid response object')
  const response = value as ArcadeTxResponse
  if (response.txid !== undefined) {
    assertHash(response.txid, 'Arcade response txid')
    if (expectedTxid !== undefined && response.txid.toLowerCase() !== expectedTxid.toLowerCase()) {
      throw new TypeError('Arcade response txid does not match the request')
    }
  }
  for (const field of ['txStatus', 'extraInfo', 'detail', 'error', 'reason'] as const) {
    if (response[field] !== undefined) {
      assertBoundedString(response[field], `Arcade response ${field}`, 4096)
    }
  }
  if (
    response.status !== undefined &&
    !(typeof response.status === 'number' && Number.isSafeInteger(response.status)) &&
    typeof response.status !== 'string'
  ) {
    throw new TypeError('Arcade response status is invalid')
  }
  if (typeof response.status === 'string') {
    assertBoundedString(response.status, 'Arcade response status', 128)
  }
  if (response.competingTxs !== undefined) {
    if (!Array.isArray(response.competingTxs) || response.competingTxs.length > 100) {
      throw new TypeError('Arcade response competingTxs is invalid')
    }
    const seen = new Set<string>()
    for (const [index, txid] of response.competingTxs.entries()) {
      assertHash(txid, `Arcade response competingTxs[${index}]`)
      const canonical = txid.toLowerCase()
      if (seen.has(canonical))
        throw new TypeError('Arcade response contains duplicate competing txids')
      seen.add(canonical)
    }
  }
  if (response.merklePath !== undefined) {
    assertBoundedHex(response.merklePath, 'Arcade response merklePath', 16 * 1024 * 1024)
  }
  if (response.blockHeight !== undefined) {
    assertNonnegativeSafeInteger(response.blockHeight, 'Arcade response blockHeight')
  }
  if (response.blockHash !== undefined) {
    assertHash(response.blockHash, 'Arcade response blockHash')
  }
  return response
}

function rawTxForArcade(tx: Transaction): string {
  try {
    return tx.toHexEF()
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      error.message === 'All inputs must have source transactions when serializing to EF format'
    ) {
      return tx.toHex()
    }
    throw error
  }
}

/**
 * Broadcaster/proof client for bsv-blockchain/arcade.
 *
 * Arcade exposes transaction propagation at `/tx` and status/proofs at
 * `/tx/{txid}`. It returns terminal validation and double-spend statuses in the
 * body, so callers must classify those as failed broadcasts even when HTTP
 * accepted the request.
 */
export class ArcadeProvider implements Broadcaster {
  readonly name = 'Arcade'
  private readonly baseUrl: string
  private readonly fetcher: typeof fetch
  private readonly requestTimeoutMs: number
  private readonly config: Readonly<ArcadeProviderConfig>

  constructor(url: string, config: ArcadeProviderConfig = {}) {
    this.config = snapshotArcadeConfig(config)
    const transport = secureServiceFetch(url, this.config.fetch, this.config.allowPrivateHosts)
    this.baseUrl = trimBaseUrl(transport.baseUrl)
    this.fetcher = transport.fetchImpl
    this.requestTimeoutMs = this.config.requestTimeoutMs ?? 30_000
    if (
      !Number.isSafeInteger(this.requestTimeoutMs) ||
      this.requestTimeoutMs < 1 ||
      this.requestTimeoutMs > 300_000
    ) {
      throw new TypeError('Arcade requestTimeoutMs must be an integer between 1 and 300000')
    }
  }

  async broadcast(tx: Transaction): Promise<BroadcastResponse | BroadcastFailure> {
    const rawTx = rawTxForArcade(tx)
    const expectedTxid = tx.id('hex')
    try {
      const response = await fetchWithDeadline(
        this.fetcher,
        `${this.baseUrl}/tx`,
        {
          method: 'POST',
          headers: this.requestHeaders(),
          body: JSON.stringify({ rawTx })
        },
        this.requestTimeoutMs
      )
      const data = await this.readResponse(response, expectedTxid)
      if (!response.ok) {
        const failure: BroadcastFailure = {
          status: 'error',
          code: data?.txStatus ?? String(response.status),
          txid: data?.txid,
          description: parseDescription(data, response.statusText)
        }
        const more: Record<string, unknown> = {
          provider: this.name,
          httpStatus: response.status,
          terminal: response.status === 400 || isTerminalArcStatus(data?.txStatus, data?.extraInfo),
          response: data
        }
        if (data?.competingTxs !== undefined) {
          more.competingTxs = data.competingTxs
        }
        failure.more = more
        return failure
      }

      const txStatus = data?.txStatus
      if (isTerminalArcStatus(txStatus, data?.extraInfo)) {
        const failure: BroadcastFailure = {
          status: 'error',
          code: txStatus ?? 'UNKNOWN',
          txid: data?.txid,
          description: `${txStatus ?? ''} ${data?.extraInfo ?? ''}`.trim()
        }
        const more: Record<string, unknown> = {
          provider: this.name,
          terminal: true,
          response: data
        }
        if (data?.competingTxs !== undefined) {
          more.competingTxs = data.competingTxs
        }
        failure.more = more
        return failure
      }

      const statusText = typeof txStatus === 'string' ? txStatus.toUpperCase() : undefined
      if (statusText === undefined || !SUCCESS_STATUSES.has(statusText)) {
        throw new TypeError('Arcade returned an unknown success status')
      }
      return {
        status: 'success',
        txid: data?.txid ?? expectedTxid,
        message: `${txStatus} ${data?.extraInfo ?? ''}`.trim(),
        competingTxs: data?.competingTxs
      }
    } catch (error: unknown) {
      return {
        status: 'error',
        code: '500',
        description: error instanceof Error ? error.message : 'Internal Server Error',
        more: { provider: this.name, terminal: false }
      }
    }
  }

  async fetchMerkleProof(txid: string): Promise<ArcadeMerkleProof | undefined> {
    assertHash(txid, 'Arcade proof txid')
    const response = await fetchWithDeadline(
      this.fetcher,
      `${this.baseUrl}/tx/${txid}`,
      {
        method: 'GET',
        headers: this.requestHeaders({ accept: 'application/json' })
      },
      this.requestTimeoutMs
    )
    if (response.status === 404) return undefined
    const data = await this.readResponse(response, txid)
    if (!response.ok) {
      throw new Error(
        `Arcade proof lookup failed for ${txid}: ${response.status} ${parseDescription(data, response.statusText)}`
      )
    }
    const mined = data?.txStatus === 'MINED' || data?.txStatus === 'IMMUTABLE'
    if (!mined || data?.merklePath === undefined || data.merklePath === '') {
      return undefined
    }
    const merklePath = MerklePath.fromHex(data.merklePath)
    if (data.blockHeight !== undefined && data.blockHeight !== merklePath.blockHeight) {
      throw new TypeError('Arcade proof block height does not match its Merkle path')
    }
    return {
      txid,
      merklePath,
      blockHeight: data.blockHeight ?? merklePath.blockHeight,
      blockHash: data.blockHash,
      merkleRoot: merklePath.computeRoot(txid)
    }
  }

  private requestHeaders(options: { accept?: string } = {}): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: options.accept ?? 'application/json',
      'Content-Type': 'application/json'
    }
    if (this.config.deploymentId !== undefined && this.config.deploymentId !== '') {
      headers['XDeployment-ID'] = this.config.deploymentId
    }
    if (this.config.apiKey !== undefined && this.config.apiKey !== '') {
      headers.Authorization = `Bearer ${this.config.apiKey}`
    }
    if (this.config.callbackUrl !== undefined && this.config.callbackUrl !== '') {
      headers['X-CallbackUrl'] = this.config.callbackUrl
    }
    if (this.config.callbackToken !== undefined && this.config.callbackToken !== '') {
      headers['X-CallbackToken'] = this.config.callbackToken
    }
    if (this.config.headers !== undefined) {
      for (const [key, value] of Object.entries(this.config.headers)) {
        headers[key] = value
      }
    }
    return headers
  }

  private async readResponse(
    response: Response,
    expectedTxid?: string
  ): Promise<ArcadeTxResponse | undefined> {
    const text = await readBoundedText(
      response,
      response.ok ? MAX_PROVIDER_JSON_BYTES : MAX_PROVIDER_ERROR_BYTES,
      'Arcade response body'
    )
    if (text === '') return undefined
    try {
      return validateArcadeResponse(JSON.parse(text), expectedTxid)
    } catch {
      if (!response.ok) {
        assertBoundedString(text, 'Arcade error response', MAX_PROVIDER_ERROR_BYTES)
        return { error: text }
      }
      throw new TypeError('Arcade returned malformed JSON')
    }
  }
}
