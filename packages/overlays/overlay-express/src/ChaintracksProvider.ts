import { ChainTracker } from '@bsv/sdk'
import {
  MAX_PROVIDER_ERROR_BYTES,
  MAX_PROVIDER_JSON_BYTES,
  assertHash,
  assertNonnegativeSafeInteger,
  fetchWithDeadline,
  isRecord,
  readBoundedJson,
  readBoundedText,
  secureServiceFetch,
  snapshotOwnDataRecord
} from './OutboundSecurity.js'

export interface ChaintracksProviderConfig {
  apiPrefix?: string
  fetch?: typeof fetch
  /** Permit HTTP/private endpoints only for isolated local development. */
  allowPrivateHosts?: boolean
  requestTimeoutMs?: number
}

export interface ChaintracksHeader {
  height: number
  hash: string
  merkleRoot: string
}

function trimUrl(url: string): string {
  let trimmed = url
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1)
  return trimmed
}

function trimPrefix(prefix: string): string {
  if (prefix === '') return ''
  if (
    prefix.includes('?') ||
    prefix.includes('#') ||
    prefix.includes('\\') ||
    Array.from(prefix).some(character => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 0x1f || codePoint === 0x7f
    })
  ) {
    throw new TypeError('Chaintracks API prefix must be a URL path')
  }
  let trimmed = prefix.startsWith('/') ? prefix : `/${prefix}`
  if (trimmed.startsWith('//'))
    throw new TypeError('Chaintracks API prefix must not be protocol-relative')
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1)
  return trimmed
}

/**
 * Minimal go-chaintracks HTTP client for Overlay Express.
 *
 * It intentionally implements the SDK ChainTracker surface plus header lookup,
 * which is enough for proof validation, BASM headers, and reorg stream URL
 * construction without depending on wallet-toolbox client export timing.
 */
export class ChaintracksProvider implements ChainTracker {
  private readonly baseUrl: string
  private readonly fetcher: typeof fetch
  private readonly requestTimeoutMs: number

  constructor(url: string, config: ChaintracksProviderConfig = {}) {
    const owned = snapshotOwnDataRecord(config, 'Chaintracks config')
    if (owned.fetch !== undefined && typeof owned.fetch !== 'function') {
      throw new TypeError('Chaintracks fetch must be a function')
    }
    if (owned.allowPrivateHosts !== undefined && typeof owned.allowPrivateHosts !== 'boolean') {
      throw new TypeError('Chaintracks allowPrivateHosts must be a boolean')
    }
    if (owned.apiPrefix !== undefined && typeof owned.apiPrefix !== 'string') {
      throw new TypeError('Chaintracks apiPrefix must be a string')
    }
    const transport = secureServiceFetch(url, owned.fetch, owned.allowPrivateHosts)
    this.baseUrl = `${trimUrl(transport.baseUrl)}${trimPrefix(owned.apiPrefix ?? '/chaintracks/v2')}`
    this.fetcher = transport.fetchImpl
    this.requestTimeoutMs = owned.requestTimeoutMs ?? 30_000
    if (
      !Number.isSafeInteger(this.requestTimeoutMs) ||
      this.requestTimeoutMs < 1 ||
      this.requestTimeoutMs > 300_000
    ) {
      throw new TypeError('Chaintracks requestTimeoutMs must be an integer between 1 and 300000')
    }
  }

  async currentHeight(): Promise<number> {
    const response = await this.getJson('/height')
    if (!isRecord(response)) throw new TypeError('Chaintracks height response is invalid')
    assertNonnegativeSafeInteger(response.height, 'Chaintracks height')
    return response.height
  }

  async isValidRootForHeight(root: string, height: number): Promise<boolean> {
    assertHash(root, 'Merkle root')
    assertNonnegativeSafeInteger(height, 'Block height')
    const header = await this.findHeaderForHeight(height)
    return header?.merkleRoot.toLowerCase() === root.toLowerCase()
  }

  async findHeaderForHeight(height: number): Promise<ChaintracksHeader | undefined> {
    assertNonnegativeSafeInteger(height, 'Block height')
    const response = await this.getJsonOrUndefined(`/header/height/${height}`)
    if (response === undefined) return undefined
    if (!isRecord(response)) throw new TypeError('Chaintracks header response is invalid')
    assertNonnegativeSafeInteger(response.height, 'Chaintracks header height')
    assertHash(response.hash, 'Chaintracks block hash')
    assertHash(response.merkleRoot, 'Chaintracks Merkle root')
    if (response.height !== height) {
      throw new TypeError('Chaintracks header height does not match the request')
    }
    return {
      height: response.height,
      hash: response.hash.toLowerCase(),
      merkleRoot: response.merkleRoot.toLowerCase()
    }
  }

  reorgStreamUrl(): string {
    return `${this.baseUrl}/reorg/stream`
  }

  private async getJson(path: string): Promise<unknown> {
    const value = await this.getJsonOrUndefined(path)
    if (value === undefined) {
      throw new Error(`Chaintracks returned no value for ${path}`)
    }
    return value
  }

  private async getJsonOrUndefined(path: string): Promise<unknown | undefined> {
    const response = await fetchWithDeadline(
      this.fetcher,
      `${this.baseUrl}${path}`,
      {
        headers: { Accept: 'application/json' }
      },
      this.requestTimeoutMs
    )
    if (response.status === 404) {
      await response.body?.cancel()
      return undefined
    }
    if (!response.ok) {
      const detail = await readBoundedText(
        response,
        MAX_PROVIDER_ERROR_BYTES,
        'Chaintracks error response'
      )
      throw new Error(
        `Chaintracks request failed for ${path}: ${response.status} ${JSON.stringify(detail)}`
      )
    }
    return await readBoundedJson(response, MAX_PROVIDER_JSON_BYTES, 'Chaintracks response')
  }
}
