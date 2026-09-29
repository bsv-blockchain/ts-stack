import { Chain } from '../../../sdk/types'
import { asString } from '../../../utility/utilityHelpers.noBuffer'
import { BaseBlockHeader, BlockHeader } from './Api/BlockHeaderApi'
import { ChaintracksClientApi, ChaintracksInfoApi, HeaderListener, ReorgListener } from './Api/ChaintracksClientApi'
import { deserializeBlockHeaders, validateHeaderFormat, validateHeaderProofOfWork } from './util/blockHeaderUtilities'
import { containsControlCharacter, safeDiagnostic } from './util/safeDiagnostic'

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
  /** Maximum decoded JSON response size. Default: 1 MiB. */
  maxJsonResponseBytes?: number
  /** Maximum binary header response size. Default: 32 MiB. */
  maxBinaryResponseBytes?: number
  /** Maximum size of one incomplete or complete SSE event. Default: 1 MiB. */
  maxSseEventBytes?: number
  /** Maximum number of deactivated headers accepted in one reorg event. Default: 4096. */
  maxReorgHeaders?: number
  /** Maximum delay between SSE chunks before reconnecting. Default: 45 seconds. */
  streamIdleTimeoutMsecs?: number
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
  /** SSE client; reorg registration is a supported additive capability. */
  readonly supportsReorgEvents = true
  private static readonly MAX_CONFIGURED_BYTES = 512 * 1024 * 1024
  private static readonly MAX_SUBSCRIPTIONS = 100_000
  private readonly baseUrl: string
  private readonly fetcher: typeof fetch
  private readonly requestTimeoutMsecs: number
  private readonly reconnectWaitMsecs: number
  private readonly reconnectWaitMaxMsecs: number
  private readonly maxJsonResponseBytes: number
  private readonly maxBinaryResponseBytes: number
  private readonly maxSseEventBytes: number
  private readonly maxReorgHeaders: number
  private readonly streamIdleTimeoutMsecs: number
  private readonly subscriptions = new Map<string, SseSubscription>()
  private nextSubscriptionId = 1

  constructor(
    public chain: Chain,
    serviceUrl: string,
    options: GoChaintracksServiceClientOptions = {}
  ) {
    if (typeof chain !== 'string' || this.normalizeChain(chain) !== chain) {
      throw new Error('chain must be a supported canonical ChainTracks network.')
    }
    if (options == null || typeof options !== 'object' || Array.isArray(options)) {
      throw new Error('options must be a plain data object.')
    }
    const optionDescriptors = Object.getOwnPropertyDescriptors(options)
    if (Object.values(optionDescriptors).some(descriptor => descriptor.get != null || descriptor.set != null)) {
      throw new Error('options must contain accessor-free data properties.')
    }
    options = Object.freeze({ ...options })
    const parsedServiceUrl = this.parseServiceUrl(serviceUrl)
    let base = parsedServiceUrl.toString()
    while (base.endsWith('/')) base = base.slice(0, -1)
    let prefix = options.apiPrefix ?? ''
    if (prefix !== '') {
      if (/[[\]\\?#]/.test(prefix) || prefix.split('/').some(part => part === '..' || part === '.')) {
        throw new Error('apiPrefix must be an absolute URL path without traversal, query, or fragment.')
      }
      if (!prefix.startsWith('/')) prefix = `/${prefix}`
      while (prefix.endsWith('/')) prefix = prefix.slice(0, -1)
    }
    this.baseUrl = `${base}${prefix}`
    const fetchImpl = options.fetch ?? fetch
    if (typeof fetchImpl !== 'function') throw new Error('fetch must be a function.')
    // Call fetch with no receiver: browsers refuse it on anything but the window.
    this.fetcher = async (input, init) => await fetchImpl(input, init)
    this.requestTimeoutMsecs = options.requestTimeoutMsecs ?? 30000
    this.reconnectWaitMsecs = options.reconnectWaitMsecs ?? 1000
    this.reconnectWaitMaxMsecs = options.reconnectWaitMaxMsecs ?? 60000
    this.maxJsonResponseBytes = this.readPositiveOption(
      options.maxJsonResponseBytes,
      1024 * 1024,
      'maxJsonResponseBytes',
      GoChaintracksServiceClient.MAX_CONFIGURED_BYTES
    )
    this.maxBinaryResponseBytes = this.readPositiveOption(
      options.maxBinaryResponseBytes,
      32 * 1024 * 1024,
      'maxBinaryResponseBytes',
      GoChaintracksServiceClient.MAX_CONFIGURED_BYTES
    )
    this.maxSseEventBytes = this.readPositiveOption(
      options.maxSseEventBytes,
      1024 * 1024,
      'maxSseEventBytes',
      GoChaintracksServiceClient.MAX_CONFIGURED_BYTES
    )
    this.maxReorgHeaders = this.readPositiveOption(options.maxReorgHeaders, 4096, 'maxReorgHeaders', 100_000)
    this.streamIdleTimeoutMsecs = this.readPositiveOption(
      options.streamIdleTimeoutMsecs,
      45_000,
      'streamIdleTimeoutMsecs',
      60 * 60 * 1000
    )
    for (const [name, value] of [
      ['requestTimeoutMsecs', this.requestTimeoutMsecs],
      ['reconnectWaitMsecs', this.reconnectWaitMsecs],
      ['reconnectWaitMaxMsecs', this.reconnectWaitMaxMsecs]
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 60 * 60 * 1000) {
        throw new Error(`${name} must be a positive integer no greater than 3600000.`)
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
    const value = await this.getJson('/network')
    const network =
      typeof value === 'string' ? value : this.readExactRecord(value, ['network'], 'network response').network
    if (typeof network !== 'string' || network.length > 64) {
      throw new Error('ChainTracks upstream returned an invalid network.')
    }
    const actual = this.normalizeChain(network)
    if (actual !== this.chain) {
      throw new Error(`ChainTracks upstream network '${actual}' does not match configured chain '${this.chain}'.`)
    }
    return actual
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
    const value = await this.getJson('/height')
    const height = typeof value === 'number' ? value : this.readExactRecord(value, ['height'], 'height response').height
    return this.validateHeight(height, 'upstream height')
  }

  async getHeaders(height: number, count: number): Promise<string> {
    this.validateHeight(height, 'height')
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new Error('count must be a positive safe integer.')
    }
    if (count > Math.floor(this.maxBinaryResponseBytes / 80)) {
      throw new Error('count exceeds the configured binary response limit.')
    }
    const bytes = await this.getBinary(`/headers.bin?height=${height}&count=${count}`, count * 80)
    if (bytes.length % 80 !== 0) {
      throw new Error('ChainTracks upstream returned a non-canonical binary header response.')
    }
    const headers = deserializeBlockHeaders(height, bytes)
    for (const [index, header] of headers.entries()) {
      this.validateRemoteHeader(header, `binary header ${index}`)
      if (index > 0 && header.previousHash !== headers[index - 1]?.hash) {
        throw new Error('ChainTracks upstream returned an unlinked binary header response.')
      }
    }
    return asString(bytes)
  }

  async findChainTipHeader(): Promise<BlockHeader> {
    return this.validateRemoteHeader(await this.getJson('/tip'), 'chain tip')
  }

  async findChainTipHash(): Promise<string> {
    return (await this.findChainTipHeader()).hash
  }

  async findHeaderForHeight(height: number): Promise<BlockHeader | undefined> {
    this.validateHeight(height, 'height')
    const value = await this.getJsonOrUndefined(`/header/height/${height}`)
    if (value === undefined) return undefined
    const header = this.validateRemoteHeader(value, 'header-by-height response')
    if (header.height !== height) {
      throw new Error('ChainTracks upstream returned a header for the wrong height.')
    }
    return header
  }

  async findHeaderForBlockHash(hash: string): Promise<BlockHeader | undefined> {
    if (!/^[0-9a-fA-F]{64}$/.test(hash)) {
      throw new Error('hash must be exactly 32 hexadecimal bytes.')
    }
    const value = await this.getJsonOrUndefined(`/header/hash/${hash}`)
    if (value === undefined) return undefined
    const header = this.validateRemoteHeader(value, 'header-by-hash response')
    if (header.hash.toLowerCase() !== hash.toLowerCase()) {
      throw new Error('ChainTracks upstream returned a header for the wrong hash.')
    }
    return header
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
    this.validateListener(listener)
    return this.subscribe('header', '/tip/stream', payload => {
      listener(this.validateRemoteHeader(payload, 'tip stream event'))
    })
  }

  async subscribeReorgs(listener: ReorgListener): Promise<string> {
    this.validateListener(listener)
    return this.subscribe('reorg', '/reorg/stream', payload => {
      const event = this.readExactRecord(
        payload,
        ['depth', 'oldTip', 'newTip', 'deactivatedHeaders'],
        'reorg stream event',
        ['deactivatedHeaders']
      )
      const depth = event.depth
      if (!Number.isSafeInteger(depth) || (depth as number) < 0 || (depth as number) > this.maxReorgHeaders) {
        throw new Error('ChainTracks upstream returned an invalid reorg depth.')
      }
      const oldTip = this.validateRemoteHeader(event.oldTip, 'reorg old tip')
      const newTip = this.validateRemoteHeader(event.newTip, 'reorg new tip')
      let deactivatedHeaders: BlockHeader[] | undefined
      if (event.deactivatedHeaders !== undefined) {
        if (!Array.isArray(event.deactivatedHeaders) || event.deactivatedHeaders.length > this.maxReorgHeaders) {
          throw new Error('ChainTracks upstream returned an invalid deactivated-header list.')
        }
        deactivatedHeaders = event.deactivatedHeaders.map((header, index) =>
          this.validateRemoteHeader(header, `deactivated header ${index}`)
        )
        if (deactivatedHeaders.length > (depth as number)) {
          throw new Error('ChainTracks upstream returned more deactivated headers than the reorg depth.')
        }
        if (deactivatedHeaders.length > 0 && deactivatedHeaders[0].hash !== oldTip.hash) {
          throw new Error('ChainTracks upstream returned a deactivated-header list that does not start at the old tip.')
        }
        const seen = new Set<string>()
        for (let index = 0; index < deactivatedHeaders.length; index++) {
          const header = deactivatedHeaders[index]
          if (seen.has(header.hash)) throw new Error('ChainTracks upstream returned duplicate deactivated headers.')
          seen.add(header.hash)
          const parent = deactivatedHeaders[index + 1]
          if (parent != null && (header.height !== parent.height + 1 || header.previousHash !== parent.hash)) {
            throw new Error('ChainTracks upstream returned an unlinked deactivated-header list.')
          }
        }
      }
      listener(depth as number, oldTip, newTip, deactivatedHeaders)
    })
  }

  async unsubscribe(subscriptionId: string): Promise<boolean> {
    if (typeof subscriptionId !== 'string' || subscriptionId.length === 0 || subscriptionId.length > 128) {
      throw new Error('subscriptionId must be a non-empty bounded string.')
    }
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
    if (this.subscriptions.size >= GoChaintracksServiceClient.MAX_SUBSCRIPTIONS) {
      throw new Error('ChainTracks subscription capacity has been reached.')
    }
    if (!Number.isSafeInteger(this.nextSubscriptionId) || this.nextSubscriptionId < 1) {
      throw new Error('ChainTracks subscription id space has been exhausted.')
    }
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
        redirect: 'error',
        signal: controller.signal
      })
      clearTimeout(timeout)
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        throw new Error(`GET ${this.url(path)} failed ${response.status} ${safeDiagnostic(response.statusText, 128)}`)
      }
      if (response.body == null) {
        throw new Error(`GET ${this.url(path)} returned no response body`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder('utf-8', { fatal: true })
      let buffer = ''
      try {
        for (;;) {
          const { done, value } = await this.readStreamChunk(reader, controller.signal, this.streamIdleTimeoutMsecs)
          if (done) break
          if (value.byteLength > this.maxSseEventBytes) {
            throw new Error('ChainTracks upstream SSE chunk exceeds the configured byte limit.')
          }
          buffer += decoder.decode(value, { stream: true })
          buffer = this.processSseBuffer(buffer, observePayload)
        }
        buffer += decoder.decode()
        this.processSseBuffer(`${buffer}\n\n`, observePayload)
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    } finally {
      clearTimeout(timeout)
      controller.abort()
      signal.removeEventListener('abort', onAbort)
    }
    return receivedEvent
  }

  private processSseBuffer(buffer: string, onPayload: (payload: unknown) => void): string {
    buffer = buffer.replaceAll('\r\n', '\n')
    for (;;) {
      const boundary = buffer.indexOf('\n\n')
      if (boundary < 0) {
        this.assertSseSize(buffer)
        return buffer
      }
      const eventText = buffer.slice(0, boundary)
      this.assertSseSize(eventText)
      buffer = buffer.slice(boundary + 2)
      const data = eventText
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n')
      if (data === '') continue
      let payload: unknown
      try {
        payload = JSON.parse(data)
      } catch {
        // Ignore malformed events; the next SSE event can still be valid.
        continue
      }
      onPayload(payload)
    }
  }

  private async getJson(path: string): Promise<unknown> {
    const r = await this.getJsonOrUndefined(path)
    if (r === undefined) throw new Error(`Value was undefined for ${path}. Requested object may not exist.`)
    return r
  }

  private async getJsonOrUndefined(path: string): Promise<unknown | undefined> {
    return await this.consumeWithTimeout(
      this.url(path),
      { headers: { Accept: 'application/json' } },
      async (response, signal) => {
        if (response.status === 404) {
          await response.body?.cancel().catch(() => {})
          return undefined
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {})
          throw new Error(`GET ${this.url(path)} failed ${response.status} ${response.statusText}`)
        }
        const bytes = await this.readBoundedBody(response, this.maxJsonResponseBytes, signal)
        let value: unknown
        try {
          value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
        } catch {
          throw new Error(`GET ${this.url(path)} returned invalid JSON.`)
        }
        if (this.isPlainRecord(value) && Object.hasOwn(value, 'status')) {
          const envelope = this.readRecord(
            value,
            ['status', 'value', 'code', 'description'],
            'legacy ChainTracks envelope'
          )
          if (envelope.status === 'success' && Object.hasOwn(envelope, 'value')) {
            return envelope.value
          }
          if (envelope.status === 'error') {
            const description = envelope.description
            if (description !== undefined && (typeof description !== 'string' || description.length > 4096)) {
              throw new Error('ChainTracks upstream returned an invalid error envelope.')
            }
            throw new Error(
              typeof description === 'string' ? safeDiagnostic(description) : `GET ${this.url(path)} failed`
            )
          }
          throw new Error('ChainTracks upstream returned an invalid legacy envelope.')
        }
        return value
      }
    )
  }

  private async getBinary(path: string, expectedMaximum: number): Promise<Uint8Array> {
    const maximum = Math.min(this.maxBinaryResponseBytes, expectedMaximum)
    return await this.consumeWithTimeout(
      this.url(path),
      { headers: { Accept: 'application/octet-stream' } },
      async (response, signal) => {
        if (!response.ok) {
          await response.body?.cancel().catch(() => {})
          throw new Error(`GET ${this.url(path)} failed ${response.status} ${safeDiagnostic(response.statusText, 128)}`)
        }
        return await this.readBoundedBody(response, maximum, signal)
      }
    )
  }

  private async consumeWithTimeout<T>(
    url: string,
    init: RequestInit,
    consume: (response: Response, signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMsecs)
    try {
      const response = await this.fetcher(url, {
        ...init,
        redirect: 'error',
        signal: controller.signal
      })
      return await consume(response, controller.signal)
    } finally {
      clearTimeout(timeout)
      controller.abort()
    }
  }

  private async readBoundedBody(response: Response, maximum: number, signal: AbortSignal): Promise<Uint8Array> {
    const contentLength = response.headers.get('content-length')
    if (contentLength != null) {
      if (!/^(0|[1-9]\d*)$/.test(contentLength)) {
        throw new Error('ChainTracks upstream returned an invalid Content-Length.')
      }
      const declared = Number(contentLength)
      if (!Number.isSafeInteger(declared) || declared > maximum) {
        throw new Error('ChainTracks upstream response exceeds the configured byte limit.')
      }
    }
    if (response.body == null) return new Uint8Array(0)

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      for (;;) {
        const { done, value } = await this.readStreamChunk(reader, signal)
        if (done) break
        if (!(value instanceof Uint8Array)) {
          throw new Error('ChainTracks upstream returned a non-byte response body.')
        }
        length += value.byteLength
        if (!Number.isSafeInteger(length) || length > maximum) {
          throw new Error('ChainTracks upstream response exceeds the configured byte limit.')
        }
        chunks.push(value)
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
    const result = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.byteLength
    }
    return result
  }

  private async readStreamChunk(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal: AbortSignal,
    idleTimeoutMsecs?: number
  ): Promise<ReadableStreamReadResult<Uint8Array>> {
    if (signal.aborted) throw this.abortError()
    return await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
      let settled = false
      let timeout: ReturnType<typeof setTimeout> | undefined
      const finish = (
        action: typeof resolve | typeof reject,
        value: ReadableStreamReadResult<Uint8Array> | Error
      ): void => {
        if (settled) return
        settled = true
        if (timeout != null) clearTimeout(timeout)
        signal.removeEventListener('abort', onAbort)
        ;(action as (value: never) => void)(value as never)
      }
      const onAbort = () => finish(reject, this.abortError())
      signal.addEventListener('abort', onAbort, { once: true })
      if (idleTimeoutMsecs != null) {
        timeout = setTimeout(
          () => finish(reject, new Error('ChainTracks upstream stream exceeded its idle timeout.')),
          idleTimeoutMsecs
        )
      }
      reader.read().then(
        result => finish(resolve, result),
        error => finish(reject, error instanceof Error ? error : new Error(String(error)))
      )
    })
  }

  private abortError(): Error {
    const error = new Error('ChainTracks upstream request exceeded its deadline.')
    error.name = 'AbortError'
    return error
  }

  private assertSseSize(value: string): void {
    if (new TextEncoder().encode(value).byteLength > this.maxSseEventBytes) {
      throw new Error('ChainTracks upstream SSE event exceeds the configured byte limit.')
    }
  }

  private validateHeight(value: unknown, name: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 0x7fffffff) {
      throw new Error(`${name} must be an integer between 0 and 2147483647.`)
    }
    return value as number
  }

  private validateRemoteHeader(value: unknown, name: string): BlockHeader {
    const baseKeys = ['version', 'previousHash', 'merkleRoot', 'time', 'bits', 'nonce', 'height', 'hash']
    const liveKeys = ['chainWork', 'isChainTip', 'isActive', 'headerId', 'previousHeaderId']
    const record = this.readExactRecord(value, [...baseKeys, ...liveKeys], name, liveKeys)
    const presentLiveKeys = liveKeys.filter(key => Object.hasOwn(record, key))
    if (
      (presentLiveKeys.length !== 0 && presentLiveKeys.length !== liveKeys.length) ||
      (record.chainWork !== undefined &&
        (typeof record.chainWork !== 'string' || !/^[0-9a-fA-F]{64}$/.test(record.chainWork))) ||
      (record.isChainTip !== undefined && typeof record.isChainTip !== 'boolean') ||
      (record.isActive !== undefined && typeof record.isActive !== 'boolean') ||
      (record.headerId !== undefined && (!Number.isSafeInteger(record.headerId) || (record.headerId as number) < 1)) ||
      (record.previousHeaderId !== undefined &&
        record.previousHeaderId !== null &&
        (!Number.isSafeInteger(record.previousHeaderId) || (record.previousHeaderId as number) < 1))
    ) {
      throw new Error(`ChainTracks upstream returned an invalid ${name}.`)
    }
    const header: BlockHeader = {
      version: record.version as number,
      previousHash: record.previousHash as string,
      merkleRoot: record.merkleRoot as string,
      time: record.time as number,
      bits: record.bits as number,
      nonce: record.nonce as number,
      height: record.height as number,
      hash: record.hash as string
    }
    try {
      validateHeaderFormat(header)
      validateHeaderProofOfWork(header)
    } catch (error) {
      throw new Error(`ChainTracks upstream returned an invalid ${name}: ${safeDiagnostic(error)}`)
    }
    const result: Record<string, unknown> = { ...header }
    for (const key of liveKeys) {
      if (record[key] !== undefined) result[key] = record[key]
    }
    return result as unknown as BlockHeader
  }

  private isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  }

  private readRecord(value: unknown, allowedKeys: readonly string[], name: string): Record<string, unknown> {
    if (!this.isPlainRecord(value)) throw new Error(`ChainTracks upstream returned an invalid ${name}.`)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (
      Object.keys(descriptors).some(
        key => !allowedKeys.includes(key) || descriptors[key]?.get != null || descriptors[key]?.set != null
      )
    ) {
      throw new Error(`ChainTracks upstream returned an invalid ${name}.`)
    }
    return value
  }

  private readExactRecord(
    value: unknown,
    allowedKeys: readonly string[],
    name: string,
    optionalKeys: readonly string[] = []
  ): Record<string, unknown> {
    const record = this.readRecord(value, allowedKeys, name)
    const requiredKeys = allowedKeys.filter(key => !optionalKeys.includes(key))
    if (!requiredKeys.every(key => Object.hasOwn(record, key))) {
      throw new Error(`ChainTracks upstream returned an invalid ${name}.`)
    }
    return record
  }

  private readPositiveOption(value: number | undefined, fallback: number, name: string, maximum: number): number {
    const resolved = value ?? fallback
    if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
      throw new Error(`${name} must be an integer between 1 and ${maximum}.`)
    }
    return resolved
  }

  private validateListener(listener: unknown): asserts listener is (...args: unknown[]) => void {
    if (typeof listener !== 'function') throw new Error('listener must be a function.')
  }

  private parseServiceUrl(serviceUrl: string): URL {
    let parsed: URL
    try {
      parsed = new URL(serviceUrl)
    } catch {
      throw new Error('serviceUrl must be an absolute HTTP(S) URL.')
    }
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      throw new Error('serviceUrl must be an HTTP(S) URL without credentials, query, or fragment.')
    }
    return parsed
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`
  }

  private normalizeChain(network: string): Chain {
    if (typeof network !== 'string' || network.length > 64 || containsControlCharacter(network)) {
      throw new Error('ChainTracks upstream returned an invalid network.')
    }
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
