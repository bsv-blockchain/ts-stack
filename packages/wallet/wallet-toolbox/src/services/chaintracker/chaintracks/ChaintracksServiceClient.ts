import { Chain } from '../../../sdk/types'
import { asArray, asString } from '../../../utility/utilityHelpers.noBuffer'
import { BaseBlockHeader, BlockHeader } from './Api/BlockHeaderApi'
import { ChaintracksClientApi, ChaintracksInfoApi, HeaderListener, ReorgListener } from './Api/ChaintracksClientApi'
import {
  deserializeBlockHeaders,
  validateBaseBlockHeaderFormat,
  validateHeaderFormat,
  validateHeaderProofOfWork
} from './util/blockHeaderUtilities'
import { containsControlCharacter, safeDiagnostic } from './util/safeDiagnostic'

interface FetchStatus<T> {
  status: 'success' | 'error'
  code?: string
  description?: string
  value?: T
}

export interface ChaintracksServiceClientOptions {
  /** Retained for compatibility with historical callers; this client does not use Authrite. */
  useAuthrite?: false
  fetch?: typeof fetch
  /** Whole-request deadline, including response-body consumption. Default: 30 seconds. */
  requestTimeoutMsecs?: number
  /** Maximum JSON response size. Default: 4 MiB. */
  maxResponseBytes?: number
  /** Maximum JSON request size. Default: 256 KiB. */
  maxRequestBytes?: number
}

/**
 * Connects to a ChaintracksService to implement 'ChaintracksClientApi'
 *
 */
export class ChaintracksServiceClient implements ChaintracksClientApi {
  /** HTTP polling client; callback event methods are legacy unsupported stubs. */
  readonly supportsReorgEvents = false
  private readonly fetcher: typeof fetch
  private readonly requestTimeoutMsecs: number
  private readonly maxResponseBytes: number
  private readonly maxRequestBytes: number

  static createChaintracksServiceClientOptions(): ChaintracksServiceClientOptions {
    const options: ChaintracksServiceClientOptions = {
      useAuthrite: false
    }
    return options
  }

  options: ChaintracksServiceClientOptions

  constructor(
    public chain: Chain,
    serviceUrl: string,
    options?: ChaintracksServiceClientOptions
  ) {
    if (typeof chain !== 'string' || this.normalizeChain(chain) !== chain) {
      throw new Error('chain must be a supported canonical ChainTracks network.')
    }
    const resolvedOptions = options || ChaintracksServiceClient.createChaintracksServiceClientOptions()
    if (resolvedOptions == null || typeof resolvedOptions !== 'object' || Array.isArray(resolvedOptions)) {
      throw new Error('options must be a plain data object.')
    }
    const descriptors = Object.getOwnPropertyDescriptors(resolvedOptions)
    if (Object.values(descriptors).some(descriptor => descriptor.get != null || descriptor.set != null)) {
      throw new Error('options must contain accessor-free data properties.')
    }
    this.options = Object.freeze({ ...resolvedOptions })
    this.serviceUrl = this.normalizeServiceUrl(serviceUrl)
    const fetchImpl = this.options.fetch ?? fetch
    if (typeof fetchImpl !== 'function') throw new Error('fetch must be a function.')
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
    this.maxRequestBytes = this.positiveInteger(
      this.options.maxRequestBytes ?? 256 * 1024,
      'maxRequestBytes',
      512 * 1024 * 1024
    )
  }

  readonly serviceUrl: string

  async subscribeHeaders(_listener: HeaderListener): Promise<string> {
    throw new Error('Method not implemented.')
  }

  async subscribeReorgs(_listener: ReorgListener): Promise<string> {
    throw new Error('Method not implemented.')
  }

  async unsubscribe(_subscriptionId: string): Promise<boolean> {
    throw new Error('Method not implemented.')
  }

  async currentHeight(): Promise<number> {
    return await this.getPresentHeight()
  }

  async isValidRootForHeight(root: string, height: number): Promise<boolean> {
    const r = await this.findHeaderForHeight(height)
    if (r == null) return false
    const isValid = root === asString(r.merkleRoot)
    return isValid
  }

  async getJsonOrUndefined<T>(path: string): Promise<T | undefined> {
    let e: Error | undefined
    for (let retry = 0; retry < 3; retry++) {
      try {
        const r = await this.requestJson(path)
        if (r === undefined) return undefined
        const v = this.parseEnvelope<T>(r)
        if (v.status === 'success') return v.value
        // Some deployed chaintracks services report a missing resource as an
        // error payload instead of a success with an undefined value. That is
        // this method's "or undefined" case, not an exception: callers such as
        // findHeaderForBlockHash are typed to return undefined on a miss, and
        // Services.hashToHeader relies on that to reach its WhatsOnChain
        // fallback. Genuine service errors still throw below.
        else if (v.code === 'ERR_NOT_FOUND') return undefined
        else e = this.serviceError(v)
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

  async postJsonVoid<T>(path: string, params: T): Promise<void> {
    const headers = { 'Content-Type': 'application/json' }
    const body = JSON.stringify(params)
    if (typeof body !== 'string') throw new Error('ChainTracks request must be JSON serializable.')
    if (new TextEncoder().encode(body).byteLength > this.maxRequestBytes) {
      throw new Error('ChainTracks request exceeds the configured byte limit.')
    }
    const value = await this.requestJson(path, {
      body,
      method: 'POST',
      headers
    })
    const result = this.parseEnvelope<void>(value)
    if (result.status === 'success') return
    throw this.serviceError(result)
  }

  //
  // HTTP API FUNCTIONS
  //

  async addHeader(header: BaseBlockHeader): Promise<void> {
    validateBaseBlockHeaderFormat(header)
    const r = await this.postJsonVoid('/addHeaderHex', {
      version: header.version,
      previousHash: header.previousHash,
      merkleRoot: header.merkleRoot,
      time: header.time,
      bits: header.bits,
      nonce: header.nonce
    })
    if (typeof r === 'string') throw new Error(r)
  }

  async startListening(): Promise<void> {
    await this.getPresentHeight()
  }

  async listening(): Promise<void> {
    await this.getPresentHeight()
  }

  async getChain(): Promise<Chain> {
    const value = await this.getJson<unknown>('/getChain')
    if (typeof value !== 'string' || value.length > 64 || containsControlCharacter(value)) {
      throw new Error('ChainTracks service returned an invalid chain.')
    }
    const actual = this.normalizeChain(value)
    if (actual !== this.chain) {
      throw new Error(`ChainTracks service chain '${actual}' does not match configured chain '${this.chain}'.`)
    }
    return actual
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

  async getPresentHeight(): Promise<number> {
    return this.validateHeight(await this.getJson('/getPresentHeight'), 'service height')
  }

  async getInfo(): Promise<ChaintracksInfoApi> {
    const value = await this.getJson<unknown>('/getInfo')
    if (!this.isPlainRecord(value) || this.normalizeChainValue(value.chain) !== this.chain) {
      throw new Error('ChainTracks service returned invalid or mismatched service information.')
    }
    this.validateInfoHeight(value.heightBulk, 'bulk height')
    this.validateInfoHeight(value.heightLive, 'live height')
    return value as unknown as ChaintracksInfoApi
  }

  async findChainTipHeader(): Promise<BlockHeader> {
    return this.validateRemoteHeader(await this.getJson('/findChainTipHeaderHex'), 'chain tip')
  }

  async findChainTipHash(): Promise<string> {
    const hash = await this.getJson<unknown>('/findChainTipHashHex')
    if (typeof hash !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hash)) {
      throw new Error('ChainTracks service returned an invalid chain-tip hash.')
    }
    return hash
  }

  async getHeaders(height: number, count: number): Promise<string> {
    this.validateHeight(height, 'height')
    if (!Number.isSafeInteger(count) || count < 1 || count > Math.floor(this.maxResponseBytes / 160)) {
      throw new Error('count exceeds the configured header response limit.')
    }
    const hex = await this.getJson<unknown>(`/getHeaders?height=${height}&count=${count}`)
    if (typeof hex !== 'string' || hex.length % 160 !== 0 || hex.length > count * 160 || !/^[0-9a-fA-F]*$/.test(hex)) {
      throw new Error('ChainTracks service returned a non-canonical header batch.')
    }
    const headers = deserializeBlockHeaders(height, asArray(hex, 'hex'))
    for (const [index, header] of headers.entries()) {
      this.validateRemoteHeader(header, `header batch item ${index}`)
      if (index > 0 && header.previousHash !== headers[index - 1]?.hash) {
        throw new Error('ChainTracks service returned an unlinked header batch.')
      }
    }
    return hex
  }

  async findHeaderForHeight(height: number): Promise<BlockHeader | undefined> {
    this.validateHeight(height, 'height')
    const value = await this.getJsonOrUndefined<unknown>(`/findHeaderHexForHeight?height=${height}`)
    if (value === undefined) return undefined
    const header = this.validateRemoteHeader(value, 'header-by-height response')
    if (header.height !== height) throw new Error('ChainTracks service returned a header for the wrong height.')
    return header
  }

  async findHeaderForBlockHash(hash: string): Promise<BlockHeader | undefined> {
    if (!/^[0-9a-fA-F]{64}$/.test(hash)) throw new Error('hash must be exactly 32 hexadecimal bytes.')
    const value = await this.getJsonOrUndefined<unknown>(`/findHeaderHexForBlockHash?hash=${hash}`)
    if (value === undefined) return undefined
    const header = this.validateRemoteHeader(value, 'header-by-hash response')
    if (header.hash.toLowerCase() !== hash.toLowerCase()) {
      throw new Error('ChainTracks service returned a header for the wrong hash.')
    }
    return header
  }

  private async requestJson(path: string, init: RequestInit = {}): Promise<unknown | undefined> {
    if (!path.startsWith('/') || path.startsWith('//') || /[\\\r\n#]/.test(path)) {
      throw new Error('ChainTracks request path must be an absolute local path.')
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMsecs)
    try {
      const response = await this.fetcher(`${this.serviceUrl}${path}`, {
        ...init,
        redirect: 'error',
        signal: controller.signal
      })
      if (response.status === 404) {
        await response.body?.cancel().catch(() => {})
        return undefined
      }
      const bytes = await this.readBoundedBody(response, controller.signal)
      let value: unknown
      try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      } catch {
        throw new Error('ChainTracks service returned invalid JSON.')
      }
      if (!response.ok && !this.isPlainRecord(value)) {
        throw new Error(`ChainTracks request failed with HTTP ${response.status}.`)
      }
      return value
    } finally {
      clearTimeout(timeout)
      controller.abort()
    }
  }

  private async readBoundedBody(response: Response, signal: AbortSignal): Promise<Uint8Array> {
    const contentLength = response.headers.get('content-length')
    if (contentLength != null) {
      if (!/^(0|[1-9]\d*)$/.test(contentLength)) {
        throw new Error('ChainTracks service returned an invalid Content-Length.')
      }
      const declared = Number(contentLength)
      if (!Number.isSafeInteger(declared) || declared > this.maxResponseBytes) {
        throw new Error('ChainTracks response exceeds the configured byte limit.')
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
          throw new Error('ChainTracks response exceeds the configured byte limit.')
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
    const error = new Error('ChainTracks request exceeded its deadline.')
    error.name = 'AbortError'
    return error
  }

  private parseEnvelope<T>(value: unknown): FetchStatus<T> {
    if (!this.isPlainRecord(value)) throw new Error('ChainTracks service returned an invalid envelope.')
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const allowed = ['status', 'code', 'description', 'value']
    if (
      Object.keys(descriptors).some(
        key => !allowed.includes(key) || descriptors[key]?.get != null || descriptors[key]?.set != null
      ) ||
      (value.status !== 'success' && value.status !== 'error') ||
      (value.code !== undefined && (typeof value.code !== 'string' || value.code.length > 128)) ||
      (value.description !== undefined && (typeof value.description !== 'string' || value.description.length > 4096))
    ) {
      throw new Error('ChainTracks service returned an invalid envelope.')
    }
    return value as unknown as FetchStatus<T>
  }

  private serviceError(value: FetchStatus<unknown>): Error {
    const code =
      typeof value.code === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value.code) ? value.code : 'ERR_CHAINTRACKS'
    const description =
      typeof value.description === 'string' ? safeDiagnostic(value.description) : 'ChainTracks service request failed.'
    return new Error(`${code}: ${description}`)
  }

  private validateRemoteHeader(value: unknown, name: string): BlockHeader {
    if (!this.isPlainRecord(value)) {
      throw new Error(`ChainTracks service returned an invalid ${name}.`)
    }
    const baseKeys = ['version', 'previousHash', 'merkleRoot', 'time', 'bits', 'nonce', 'height', 'hash']
    const liveKeys = ['chainWork', 'isChainTip', 'isActive', 'headerId', 'previousHeaderId']
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const presentLiveKeys = liveKeys.filter(key => Object.hasOwn(value, key))
    if (
      !baseKeys.every(key => Object.hasOwn(value, key)) ||
      (presentLiveKeys.length !== 0 && presentLiveKeys.length !== liveKeys.length) ||
      Object.keys(descriptors).some(
        key =>
          ![...baseKeys, ...liveKeys].includes(key) || descriptors[key]?.get != null || descriptors[key]?.set != null
      ) ||
      (value.chainWork !== undefined &&
        (typeof value.chainWork !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value.chainWork))) ||
      (value.isChainTip !== undefined && typeof value.isChainTip !== 'boolean') ||
      (value.isActive !== undefined && typeof value.isActive !== 'boolean') ||
      (value.headerId !== undefined && (!Number.isSafeInteger(value.headerId) || (value.headerId as number) < 1)) ||
      (value.previousHeaderId !== undefined &&
        value.previousHeaderId !== null &&
        (!Number.isSafeInteger(value.previousHeaderId) || (value.previousHeaderId as number) < 1))
    ) {
      throw new Error(`ChainTracks service returned an invalid ${name}.`)
    }
    const header: BlockHeader = {
      version: value.version as number,
      previousHash: value.previousHash as string,
      merkleRoot: value.merkleRoot as string,
      time: value.time as number,
      bits: value.bits as number,
      nonce: value.nonce as number,
      height: value.height as number,
      hash: value.hash as string
    }
    try {
      validateHeaderFormat(header)
      validateHeaderProofOfWork(header)
    } catch (error) {
      throw new Error(`ChainTracks service returned an invalid ${name}: ${safeDiagnostic(error)}`)
    }
    const result: Record<string, unknown> = { ...header }
    for (const key of liveKeys) {
      if (value[key] !== undefined) result[key] = value[key]
    }
    return result as unknown as BlockHeader
  }

  private validateHeight(value: unknown, name: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 0x7fffffff) {
      throw new Error(`${name} must be an integer between 0 and 2147483647.`)
    }
    return value as number
  }

  private validateInfoHeight(value: unknown, name: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < -1 || (value as number) > 0x7fffffff) {
      throw new Error(`${name} must be an integer between -1 and 2147483647.`)
    }
    return value as number
  }

  private isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
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

  private normalizeChainValue(value: unknown): Chain {
    if (typeof value !== 'string' || value.length > 64 || containsControlCharacter(value)) {
      throw new Error('ChainTracks service returned an invalid chain.')
    }
    return this.normalizeChain(value)
  }

  private normalizeChain(value: string): Chain {
    switch (value.trim().toLowerCase()) {
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
      case 'mock':
        return 'mock'
      default:
        throw new Error(`Unsupported ChainTracks service chain '${value}'.`)
    }
  }
}
