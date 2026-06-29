import {
  BroadcastFailure,
  Broadcaster,
  BroadcastResponse,
  MerklePath,
  Transaction
} from '@bsv/sdk'

export interface ArcadeProviderConfig {
  apiKey?: string
  callbackUrl?: string
  callbackToken?: string
  deploymentId?: string
  headers?: Record<string, string>
  fetch?: typeof fetch
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

export function isTerminalArcStatus (status: unknown, extraInfo?: unknown): boolean {
  const statusText = typeof status === 'string' ? status.toUpperCase() : ''
  const extraText = typeof extraInfo === 'string' ? extraInfo.toUpperCase() : ''
  return TERMINAL_STATUSES.has(statusText) || statusText.includes('ORPHAN') || extraText.includes('ORPHAN')
}

function trimBaseUrl (url: string): string {
  let base = url
  while (base.endsWith('/')) base = base.slice(0, -1)
  return base
}

function parseDescription (data: unknown, fallback: string): string {
  if (typeof data === 'string') return data
  if (typeof data === 'object' && data !== null) {
    const d = data as ArcadeTxResponse
    return d.detail ?? d.reason ?? d.error ?? `${d.txStatus ?? ''} ${d.extraInfo ?? ''}`.trim() ?? fallback
  }
  return fallback
}

function rawTxForArcade (tx: Transaction): string {
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

  constructor (url: string, private readonly config: ArcadeProviderConfig = {}) {
    this.baseUrl = trimBaseUrl(url)
    this.fetcher = config.fetch ?? fetch
  }

  async broadcast (tx: Transaction): Promise<BroadcastResponse | BroadcastFailure> {
    const rawTx = rawTxForArcade(tx)
    try {
      const response = await this.fetcher(`${this.baseUrl}/tx`, {
        method: 'POST',
        headers: this.requestHeaders(),
        body: JSON.stringify({ rawTx })
      })
      const data = await this.readResponse<ArcadeTxResponse>(response)
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
        const more: Record<string, unknown> = { provider: this.name, terminal: true, response: data }
        if (data?.competingTxs !== undefined) {
          more.competingTxs = data.competingTxs
        }
        failure.more = more
        return failure
      }

      const statusText = typeof txStatus === 'string' ? txStatus.toUpperCase() : undefined
      return {
        status: 'success',
        txid: data?.txid ?? tx.id('hex'),
        message: `${txStatus ?? (SUCCESS_STATUSES.has(statusText ?? '') ? statusText ?? '' : response.statusText)} ${data?.extraInfo ?? ''}`.trim(),
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

  async fetchMerkleProof (txid: string): Promise<ArcadeMerkleProof | undefined> {
    const response = await this.fetcher(`${this.baseUrl}/tx/${txid}`, {
      method: 'GET',
      headers: this.requestHeaders({ accept: 'application/json' })
    })
    if (response.status === 404) return undefined
    const data = await this.readResponse<ArcadeTxResponse>(response)
    if (!response.ok) {
      throw new Error(`Arcade proof lookup failed for ${txid}: ${response.status} ${parseDescription(data, response.statusText)}`)
    }
    const mined = data?.txStatus === 'MINED' || data?.txStatus === 'IMMUTABLE'
    if (!mined || data?.merklePath === undefined || data.merklePath === '') {
      return undefined
    }
    const merklePath = MerklePath.fromHex(data.merklePath)
    return {
      txid,
      merklePath,
      blockHeight: data.blockHeight ?? merklePath.blockHeight,
      blockHash: data.blockHash,
      merkleRoot: merklePath.computeRoot(txid)
    }
  }

  private requestHeaders (options: { accept?: string } = {}): Record<string, string> {
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

  private async readResponse<T>(response: Response): Promise<T | undefined> {
    const text = await response.text()
    if (text === '') return undefined
    try {
      return JSON.parse(text) as T
    } catch {
      return text as T
    }
  }
}
