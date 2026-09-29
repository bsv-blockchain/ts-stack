import { BlockHeadersService } from '@bsv/sdk'
import { toHex } from '@bsv/sdk/primitives/utils'
import { ChaintracksServiceClient, ChaintracksServiceClientOptions } from './chaintracks/ChaintracksServiceClient'
import {
  blockHash,
  serializeBaseBlockHeader,
  validateHeaderFormat,
  validateHeaderProofOfWork
} from './chaintracks/util/blockHeaderUtilities'
import {
  HeaderListener,
  ReorgListener,
  ChaintracksInfoApi,
  ChaintracksClientApi
} from './chaintracks/Api/ChaintracksClientApi'
import { Chain } from '../../sdk/types'
import { BaseBlockHeader, BlockHeader } from '../../sdk/WalletServices.interfaces'

interface BHSHeader {
  hash: string
  version: number
  prevBlockHash: string
  merkleRoot: string
  creationTimestamp: number
  difficultyTarget: number
  nonce: number
  work: string
}

export class BHServiceClient implements ChaintracksClientApi {
  /** HTTP polling client; callback event methods are legacy unsupported stubs. */
  readonly supportsReorgEvents = false
  private readonly fetcher: typeof fetch
  private readonly requestTimeoutMsecs: number
  private readonly maxResponseBytes: number
  bhs: BlockHeadersService
  cache: Record<number, string>
  chain: Chain
  serviceUrl: string
  options: ChaintracksServiceClientOptions
  apiKey: string

  constructor(chain: Chain, url: string, apiKey: string, options: ChaintracksServiceClientOptions = {}) {
    if (!['main', 'test', 'stn', 'ttn', 'tstn', 'mock'].includes(chain)) {
      throw new Error('chain must be a supported Chain value.')
    }
    if (typeof apiKey !== 'string' || apiKey.length > 8192 || /[\r\n]/.test(apiKey)) {
      throw new Error('apiKey must be a string without control lines and no longer than 8192 characters.')
    }
    this.serviceUrl = this.normalizeServiceUrl(url)
    this.options = { ...ChaintracksServiceClient.createChaintracksServiceClientOptions(), ...options }
    const fetchImpl = this.options.fetch ?? fetch
    // Call fetch with no receiver: browsers refuse it on anything but the window.
    this.fetcher = async (input, init) => await fetchImpl(input, init)
    this.requestTimeoutMsecs = this.positiveInteger(
      this.options.requestTimeoutMsecs ?? 30_000,
      'requestTimeoutMsecs',
      60 * 60 * 1000
    )
    this.maxResponseBytes = this.positiveInteger(
      this.options.maxResponseBytes ?? 4 * 1024 * 1024,
      'maxResponseBytes',
      512 * 1024 * 1024
    )
    this.bhs = new BlockHeadersService(this.serviceUrl, { apiKey })
    this.cache = {}
    this.chain = chain
    this.apiKey = apiKey
  }

  async currentHeight(): Promise<number> {
    const response = await this.getJson<unknown>('/api/v1/chain/tip/longest')
    const state = this.validateHeaderState(response, 'chain tip')
    return state.height
  }

  async isValidRootForHeight(root: string, height: number): Promise<boolean> {
    const header = await this.findHeaderForHeight(height)
    const merkleRoot = header?.merkleRoot
    if (typeof merkleRoot !== 'string' || merkleRoot.length === 0) return false
    // Diagnostic only: validity is always decided from a freshly read canonical header.
    this.cache[height] = merkleRoot
    return merkleRoot === root
  }

  async getPresentHeight(): Promise<number> {
    return await this.currentHeight()
  }

  async findHeaderForHeight(height: number): Promise<BlockHeader | undefined> {
    this.validateHeight(height, 'height')
    const response = await this.getJsonOrUndefined<unknown>(`/api/v1/chain/header/byHeight?height=${height}`)
    if (response === undefined) return undefined
    const headers = this.validateHeaderArray(response, height, 1)
    return headers[0]
  }

  async findHeaderForBlockHash(hash: string): Promise<BlockHeader | undefined> {
    const canonicalHash = this.validateHash(hash, 'hash')
    const response = await this.getJsonOrUndefined<unknown>(`/api/v1/chain/header/state/${canonicalHash}`)
    if (response === undefined) return undefined
    const state = this.validateHeaderState(response, 'header-by-hash response')
    if (state.header.hash !== canonicalHash)
      throw new Error('Block Headers Service returned a header for the wrong hash.')
    return state.header
  }

  async getHeaders(height: number, count: number): Promise<string> {
    this.validateHeight(height, 'height')
    if (!Number.isSafeInteger(count) || count < 1 || count > Math.floor(this.maxResponseBytes / 160)) {
      throw new Error('count exceeds the configured header response limit.')
    }
    if (height + count - 1 > 0x7fffffff) throw new Error('requested header range exceeds the supported height.')
    const response = await this.getJsonOrUndefined<unknown>(
      `/api/v1/chain/header/byHeight?height=${height}&count=${count}`
    )
    if (response == null) return ''
    const remoteHeaders = this.validateHeaderArray(response, height, count)
    if (remoteHeaders.length < count) throw new Error('Cannot retrieve enough headers')
    const headers = remoteHeaders.map(response => {
      const header: BaseBlockHeader = {
        version: response.version,
        previousHash: response.previousHash,
        merkleRoot: response.merkleRoot,
        time: response.time,
        bits: response.bits,
        nonce: response.nonce
      }
      return serializeBaseBlockHeader(header)
    })
    return headers.reduce((str: string, arr: number[]) => str + toHex(arr), '')
  }

  async findChainWorkForBlockHash(_hash: string): Promise<string | undefined> {
    throw new Error('Not implemented')
  }

  async findChainTipHeader(): Promise<BlockHeader> {
    const response = await this.getJson<unknown>('/api/v1/chain/tip/longest')
    return this.validateHeaderState(response, 'chain tip').header
  }

  async getJsonOrUndefined<T>(path: string): Promise<T | undefined> {
    let e: Error | undefined
    for (let retry = 0; retry < 3; retry++) {
      try {
        const value = await this.requestJson(path)
        if (value === undefined) return undefined
        return value as T
      } catch (error_: unknown) {
        e = error_ instanceof Error ? error_ : new Error(String(error_))
      }
      if (e && e.name !== 'ECONNRESET' && (e as Error & { code?: unknown }).code !== 'ECONNRESET') break
    }
    if (e != null) throw e
  }

  async getJson<T>(path: string): Promise<T> {
    const r = await this.getJsonOrUndefined<T>(path)
    if (r === undefined) throw new Error('Value was undefined. Requested object may not exist.')
    return r
  }

  private async requestJson(path: string): Promise<unknown | undefined> {
    if (!path.startsWith('/') || path.startsWith('//') || /[\\\r\n#]/.test(path)) {
      throw new Error('Block Headers Service request path must be an absolute local path.')
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMsecs)
    try {
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (this.apiKey !== '') headers.Authorization = `Bearer ${this.apiKey}`
      const response = await this.fetcher(`${this.serviceUrl}${path}`, {
        headers,
        redirect: 'error',
        signal: controller.signal
      })
      if (response.status === 404) {
        await response.body?.cancel().catch(() => {})
        return undefined
      }
      const bytes = await this.readBoundedBody(response, controller.signal)
      if (!response.ok) throw new Error(`Block Headers Service request failed with HTTP ${response.status}.`)
      try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
      } catch {
        throw new Error('Block Headers Service returned invalid JSON.')
      }
    } finally {
      clearTimeout(timeout)
      controller.abort()
    }
  }

  private async readBoundedBody(response: Response, signal: AbortSignal): Promise<Uint8Array> {
    const contentLength = response.headers.get('content-length')
    if (contentLength != null) {
      if (!/^(0|[1-9]\d*)$/.test(contentLength)) {
        throw new Error('Block Headers Service returned an invalid Content-Length.')
      }
      const declared = Number(contentLength)
      if (!Number.isSafeInteger(declared) || declared > this.maxResponseBytes) {
        throw new Error('Block Headers Service response exceeds the configured byte limit.')
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
        length += value.byteLength
        if (!Number.isSafeInteger(length) || length > this.maxResponseBytes) {
          throw new Error('Block Headers Service response exceeds the configured byte limit.')
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
    signal: AbortSignal
  ): Promise<ReadableStreamReadResult<Uint8Array>> {
    if (signal.aborted) throw this.abortError()
    return await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
      let settled = false
      const finish = (callback: (value: never) => void, value: ReadableStreamReadResult<Uint8Array> | Error): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        callback(value as never)
      }
      const onAbort = () => finish(reject, this.abortError())
      signal.addEventListener('abort', onAbort, { once: true })
      reader.read().then(
        value => finish(resolve, value),
        error => finish(reject, error instanceof Error ? error : new Error(String(error)))
      )
    })
  }

  private abortError(): Error {
    const error = new Error('Block Headers Service request exceeded its deadline.')
    error.name = 'AbortError'
    return error
  }

  private validateHeaderArray(value: unknown, firstHeight: number, maximum: number): BlockHeader[] {
    if (!Array.isArray(value) || value.length > maximum) {
      throw new Error('Block Headers Service returned an invalid header array.')
    }
    const headers: BlockHeader[] = []
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) throw new Error('Block Headers Service returned a sparse header array.')
      const header = this.validateRemoteHeader(value[index], firstHeight + index, `header ${index}`)
      if (index > 0 && header.previousHash !== headers[index - 1]?.hash) {
        throw new Error('Block Headers Service returned an unlinked header array.')
      }
      headers.push(header)
    }
    return headers
  }

  private validateHeaderState(value: unknown, name: string): { header: BlockHeader; height: number } {
    const state = this.requirePlainRecord(value, name)
    const height = this.validateHeight(state.height, `${name} height`)
    if (state.state !== undefined && (typeof state.state !== 'string' || state.state.length > 128)) {
      throw new Error(`Block Headers Service returned an invalid ${name} state.`)
    }
    if (
      state.chainWork !== undefined &&
      (typeof state.chainWork !== 'string' || !/^[0-9a-fA-F]{64}$/.test(state.chainWork))
    ) {
      throw new Error(`Block Headers Service returned invalid ${name} chain work.`)
    }
    return { header: this.validateRemoteHeader(state.header, height, name), height }
  }

  private validateRemoteHeader(value: unknown, height: number, name: string): BlockHeader {
    const raw = this.requirePlainRecord(value, name) as unknown as Partial<BHSHeader>
    const header: BlockHeader = {
      version: raw.version as number,
      previousHash: raw.prevBlockHash as string,
      merkleRoot: raw.merkleRoot as string,
      time: raw.creationTimestamp as number,
      bits: raw.difficultyTarget as number,
      nonce: raw.nonce as number,
      height,
      hash: raw.hash as string
    }
    try {
      validateHeaderFormat(header)
      if (blockHash(header) !== header.hash.toLowerCase()) {
        throw new Error('computed hash does not match the supplied hash')
      }
      validateHeaderProofOfWork(header)
    } catch (error) {
      throw new Error(
        `Block Headers Service returned an invalid ${name}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    return {
      ...header,
      previousHash: header.previousHash.toLowerCase(),
      merkleRoot: header.merkleRoot.toLowerCase(),
      hash: header.hash.toLowerCase()
    }
  }

  private requirePlainRecord(value: unknown, name: string): Record<string, unknown> {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Block Headers Service returned an invalid ${name}.`)
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`Block Headers Service returned an invalid ${name}.`)
    }
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.values(descriptors).some(descriptor => descriptor.get != null || descriptor.set != null)) {
      throw new Error(`Block Headers Service returned an invalid ${name}.`)
    }
    return value as Record<string, unknown>
  }

  private validateHash(value: unknown, name: string): string {
    if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value)) {
      throw new Error(`${name} must be exactly 32 hexadecimal bytes.`)
    }
    return value.toLowerCase()
  }

  private validateHeight(value: unknown, name: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 0x7fffffff) {
      throw new Error(`${name} must be an integer between 0 and 2147483647.`)
    }
    return value as number
  }

  private normalizeServiceUrl(value: string): string {
    let parsed: URL
    try {
      parsed = new URL(value)
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
    let normalized = parsed.toString()
    while (normalized.endsWith('/')) normalized = normalized.slice(0, -1)
    return normalized
  }

  private positiveInteger(value: number, name: string, maximum: number): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new Error(`${name} must be an integer between 1 and ${maximum}.`)
    }
    return value
  }

  /*
    Please note that all methods hereafter are included only to match the interface of ChaintracksServiceClient.
  */

  async postJsonVoid<T>(_path: string, _params: T): Promise<void> {
    throw new Error('Not implemented')
  }

  async addHeader(_header: any): Promise<void> {
    throw new Error('Not implemented')
  }

  async findHeaderForMerkleRoot(_merkleRoot: string, _height?: number): Promise<undefined> {
    throw new Error('Not implemented')
  }

  async startListening(): Promise<void> {
    throw new Error('Not implemented')
  }

  async listening(): Promise<void> {
    throw new Error('Not implemented')
  }

  async isSynchronized(): Promise<boolean> {
    throw new Error('Not implemented')
  }

  async getChain(): Promise<Chain> {
    return this.chain
  }

  async isListening(): Promise<boolean> {
    throw new Error('Not implemented')
  }

  async getChainTipHeader(): Promise<BlockHeader> {
    return await this.findChainTipHeader()
  }

  async findChainTipHash(): Promise<string> {
    return (await this.findChainTipHeader()).hash
  }

  async subscribeHeaders(_listener: HeaderListener): Promise<string> {
    throw new Error('Method not implemented.')
  }

  async subscribeReorgs(_listener: ReorgListener): Promise<string> {
    throw new Error('Method not implemented.')
  }

  async unsubscribe(_subscriptionId: string): Promise<boolean> {
    throw new Error('Method not implemented.')
  }

  async getInfo(): Promise<ChaintracksInfoApi> {
    throw new Error('Method not implemented.')
  }
}
