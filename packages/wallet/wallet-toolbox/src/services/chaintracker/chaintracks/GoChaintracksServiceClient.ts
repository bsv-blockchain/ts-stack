import { Chain } from '../../../sdk/types'
import { asString } from '../../../utility/utilityHelpers.noBuffer'
import { BaseBlockHeader, BlockHeader } from './Api/BlockHeaderApi'
import { ChaintracksClientApi, ChaintracksInfoApi, HeaderListener, ReorgListener } from './Api/ChaintracksClientApi'

export interface GoChaintracksServiceClientOptions {
  /**
   * Path prefix for the go-chaintracks HTTP API.
   * Arcade exposes this at `/chaintracks/v2`.
   */
  apiPrefix?: string
  fetch?: typeof fetch
  /** Timeout for HTTP requests and the initial SSE handshake. */
  requestTimeoutMsecs?: number
  /** Initial delay before reconnecting a closed or failed SSE stream. */
  reconnectWaitMsecs?: number
  /** Maximum SSE reconnect delay. */
  reconnectWaitMaxMsecs?: number
}

interface GoChaintracksHeightResponse {
  height: number
}

interface GoChaintracksNetworkResponse {
  network: string
}

interface SseSubscription {
  id: string
  type: 'header' | 'reorg'
  abort: AbortController
  done: Promise<void>
}

/**
 * Client for go-chaintracks compatible HTTP services, including Arcade's
 * `/chaintracks/v2` surface. Unlike the legacy ChaintracksServiceClient, this
 * can subscribe to tip/reorg SSE streams and therefore drive Monitor block
 * processing without a local WhatsOnChain polling ingestor.
 */
export class GoChaintracksServiceClient implements ChaintracksClientApi {
  private readonly baseUrl: string
  private readonly fetcher: typeof fetch
  private readonly requestTimeoutMsecs: number
  private readonly reconnectWaitMsecs: number
  private readonly reconnectWaitMaxMsecs: number
  private readonly subscriptions = new Map<string, SseSubscription>()
  private nextSubscriptionId = 1

  constructor(
    public chain: Chain,
    serviceUrl: string,
    options: GoChaintracksServiceClientOptions = {}
  ) {
    let base = serviceUrl
    while (base.endsWith('/')) base = base.slice(0, -1)
    let prefix = options.apiPrefix ?? ''
    if (prefix !== '') {
      if (!prefix.startsWith('/')) prefix = `/${prefix}`
      while (prefix.endsWith('/')) prefix = prefix.slice(0, -1)
    }
    this.baseUrl = `${base}${prefix}`
    this.fetcher = options.fetch ?? fetch
    this.requestTimeoutMsecs = options.requestTimeoutMsecs ?? 30000
    this.reconnectWaitMsecs = options.reconnectWaitMsecs ?? 1000
    this.reconnectWaitMaxMsecs = options.reconnectWaitMaxMsecs ?? 60000
    for (const [name, value] of [
      ['requestTimeoutMsecs', this.requestTimeoutMsecs],
      ['reconnectWaitMsecs', this.reconnectWaitMsecs],
      ['reconnectWaitMaxMsecs', this.reconnectWaitMaxMsecs]
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive integer.`)
      }
    }
    if (this.reconnectWaitMaxMsecs < this.reconnectWaitMsecs) {
      throw new Error('reconnectWaitMaxMsecs must be greater than or equal to reconnectWaitMsecs.')
    }
  }

  async currentHeight(): Promise<number> {
    return await this.getPresentHeight()
  }

  async isValidRootForHeight(root: string, height: number): Promise<boolean> {
    const h = await this.findHeaderForHeight(height)
    return h != null && root === asString(h.merkleRoot)
  }

  async getChain(): Promise<Chain> {
    const r = await this.getJson<GoChaintracksNetworkResponse | string>('/network')
    return this.normalizeChain(typeof r === 'string' ? r : r.network)
  }

  async getInfo(): Promise<ChaintracksInfoApi> {
    const tip = await this.findChainTipHeader()
    return {
      chain: await this.getChain(),
      heightBulk: tip.height,
      heightLive: tip.height,
      storage: 'go-chaintracks',
      bulkIngestors: [],
      liveIngestors: ['GoChaintracksServiceClient'],
      packages: []
    }
  }

  async getPresentHeight(): Promise<number> {
    const result = await this.getJson<GoChaintracksHeightResponse | number>('/height')
    return typeof result === 'number' ? result : result.height
  }

  async getHeaders(height: number, count: number): Promise<string> {
    const bytes = await this.getBinary(`/headers.bin?height=${height}&count=${count}`)
    return asString(bytes)
  }

  async findChainTipHeader(): Promise<BlockHeader> {
    return await this.getJson<BlockHeader>('/tip')
  }

  async findChainTipHash(): Promise<string> {
    return (await this.findChainTipHeader()).hash
  }

  async findHeaderForHeight(height: number): Promise<BlockHeader | undefined> {
    return await this.getJsonOrUndefined<BlockHeader>(`/header/height/${height}`)
  }

  async findHeaderForBlockHash(hash: string): Promise<BlockHeader | undefined> {
    return await this.getJsonOrUndefined<BlockHeader>(`/header/hash/${hash}`)
  }

  async addHeader(_header: BaseBlockHeader): Promise<void> {
    throw new Error('GoChaintracksServiceClient.addHeader is not supported by the remote v2 API.')
  }

  async startListening(): Promise<void> {
    await this.getPresentHeight()
  }

  async listening(): Promise<void> {
    await this.getPresentHeight()
  }

  async isListening(): Promise<boolean> {
    try {
      await this.getPresentHeight()
      return true
    } catch {
      return false
    }
  }

  async isSynchronized(): Promise<boolean> {
    return await this.isListening()
  }

  async subscribeHeaders(listener: HeaderListener): Promise<string> {
    return this.subscribe('header', '/tip/stream', payload => {
      listener(payload as BlockHeader)
    })
  }

  async subscribeReorgs(listener: ReorgListener): Promise<string> {
    return this.subscribe('reorg', '/reorg/stream', payload => {
      const event = payload as {
        depth?: number
        oldTip?: BlockHeader
        newTip?: BlockHeader
        deactivatedHeaders?: BlockHeader[]
      }
      if (event.oldTip != null && event.newTip != null) {
        listener(event.depth ?? 0, event.oldTip, event.newTip, event.deactivatedHeaders)
      }
    })
  }

  async unsubscribe(subscriptionId: string): Promise<boolean> {
    const sub = this.subscriptions.get(subscriptionId)
    if (sub == null) return false
    this.subscriptions.delete(subscriptionId)
    sub.abort.abort()
    await sub.done.catch(() => {})
    return true
  }

  private async subscribe(
    type: SseSubscription['type'],
    path: string,
    onPayload: (payload: unknown) => void
  ): Promise<string> {
    const id = `${type}-${this.nextSubscriptionId++}`
    const abort = new AbortController()
    const done = this.runSseWithReconnect(path, abort.signal, onPayload)
    this.subscriptions.set(id, { id, type, abort, done })
    done
      .catch(() => {})
      .finally(() => {
        const active = this.subscriptions.get(id)
        if (active?.abort === abort) this.subscriptions.delete(id)
      })
    return id
  }

  private async runSseWithReconnect(
    path: string,
    signal: AbortSignal,
    onPayload: (payload: unknown) => void
  ): Promise<void> {
    let failures = 0
    while (!signal.aborted) {
      try {
        const receivedEvent = await this.runSse(path, signal, onPayload)
        failures = receivedEvent ? 0 : failures + 1
      } catch {
        if (signal.aborted) return
        failures++
      }
      const multiplier = Math.min(2 ** Math.max(0, failures - 1), 64)
      const delay = Math.min(this.reconnectWaitMsecs * multiplier, this.reconnectWaitMaxMsecs)
      await this.waitForReconnect(delay, signal)
    }
  }

  private async waitForReconnect(msecs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted || msecs <= 0) return
    await new Promise<void>(resolve => {
      let timeout: ReturnType<typeof setTimeout>
      const onAbort = () => done()
      const done = () => {
        clearTimeout(timeout)
        signal.removeEventListener('abort', onAbort)
        resolve()
      }
      timeout = setTimeout(done, msecs)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  private async runSse(path: string, signal: AbortSignal, onPayload: (payload: unknown) => void): Promise<boolean> {
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMsecs)
    let receivedEvent = false
    const observePayload = (payload: unknown) => {
      receivedEvent = true
      onPayload(payload)
    }
    try {
      const response = await this.fetcher(this.url(path), {
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal
      })
      clearTimeout(timeout)
      if (!response.ok) {
        throw new Error(`GET ${this.url(path)} failed ${response.status} ${response.statusText}`)
      }
      if (response.body == null) {
        throw new Error(`GET ${this.url(path)} returned no response body`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          buffer = this.processSseBuffer(buffer, observePayload)
        }
        buffer += decoder.decode()
        this.processSseBuffer(`${buffer}\n\n`, observePayload)
      } finally {
        reader.releaseLock()
      }
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
    }
    return receivedEvent
  }

  private processSseBuffer(buffer: string, onPayload: (payload: unknown) => void): string {
    buffer = buffer.replace(/\r\n/g, '\n')
    for (;;) {
      const boundary = buffer.indexOf('\n\n')
      if (boundary < 0) return buffer
      const eventText = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const data = eventText
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n')
      if (data === '') continue
      try {
        onPayload(JSON.parse(data))
      } catch {
        // Ignore malformed events; the next SSE event can still be valid.
      }
    }
  }

  private async getJson<T>(path: string): Promise<T> {
    const r = await this.getJsonOrUndefined<T>(path)
    if (r === undefined) throw new Error(`Value was undefined for ${path}. Requested object may not exist.`)
    return r
  }

  private async getJsonOrUndefined<T>(path: string): Promise<T | undefined> {
    const response = await this.fetchWithTimeout(this.url(path), { headers: { Accept: 'application/json' } })
    if (response.status === 404) return undefined
    if (!response.ok) {
      throw new Error(`GET ${this.url(path)} failed ${response.status} ${response.statusText}`)
    }
    const value = (await response.json()) as unknown
    if (value != null && typeof value === 'object' && 'status' in value) {
      const envelope = value as { status?: string; value?: T; description?: string }
      if (envelope.status === 'success') return envelope.value
      if (envelope.status === 'error') throw new Error(envelope.description ?? `GET ${this.url(path)} failed`)
    }
    return value as T
  }

  private async getBinary(path: string): Promise<Uint8Array> {
    const response = await this.fetchWithTimeout(this.url(path), { headers: { Accept: 'application/octet-stream' } })
    if (!response.ok) {
      throw new Error(`GET ${this.url(path)} failed ${response.status} ${response.statusText}`)
    }
    return new Uint8Array(await response.arrayBuffer())
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMsecs)
    try {
      return await this.fetcher(url, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timeout)
    }
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`
  }

  private normalizeChain(network: string): Chain {
    switch (network.trim().toLowerCase()) {
      case 'main':
      case 'mainnet':
        return 'main'
      case 'test':
      case 'testnet':
        return 'test'
      case 'stn':
      case 'scalingtestnet':
        return 'stn'
      case 'ttn':
      case 'teratest':
      case 'teratestnet':
        return 'ttn'
      case 'tstn':
      case 'teranodescalingtestnet':
        return 'tstn'
      default:
        throw new Error(`Unsupported ChainTracks upstream network '${network}'.`)
    }
  }
}
