import { ChainTracker } from '@bsv/sdk'

export interface ChaintracksProviderConfig {
  apiPrefix?: string
  fetch?: typeof fetch
}

export interface ChaintracksHeader {
  height: number
  hash: string
  merkleRoot: string
}

function trimUrl (url: string): string {
  let trimmed = url
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1)
  return trimmed
}

function trimPrefix (prefix: string): string {
  if (prefix === '') return ''
  let trimmed = prefix.startsWith('/') ? prefix : `/${prefix}`
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

  constructor (url: string, config: ChaintracksProviderConfig = {}) {
    this.baseUrl = `${trimUrl(url)}${trimPrefix(config.apiPrefix ?? '/chaintracks/v2')}`
    this.fetcher = config.fetch ?? fetch
  }

  async currentHeight (): Promise<number> {
    const response = await this.getJson<{ height: number }>('/height')
    return response.height
  }

  async isValidRootForHeight (root: string, height: number): Promise<boolean> {
    const header = await this.findHeaderForHeight(height)
    return header !== undefined && header.merkleRoot === root
  }

  async findHeaderForHeight (height: number): Promise<ChaintracksHeader | undefined> {
    return await this.getJsonOrUndefined<ChaintracksHeader>(`/header/height/${height}`)
  }

  reorgStreamUrl (): string {
    return `${this.baseUrl}/reorg/stream`
  }

  private async getJson<T>(path: string): Promise<T> {
    const value = await this.getJsonOrUndefined<T>(path)
    if (value === undefined) {
      throw new Error(`Chaintracks returned no value for ${path}`)
    }
    return value
  }

  private async getJsonOrUndefined<T>(path: string): Promise<T | undefined> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      headers: { Accept: 'application/json' }
    })
    if (response.status === 404) return undefined
    if (!response.ok) {
      throw new Error(`Chaintracks request failed for ${path}: ${response.status} ${response.statusText}`)
    }
    return await response.json() as T
  }
}
