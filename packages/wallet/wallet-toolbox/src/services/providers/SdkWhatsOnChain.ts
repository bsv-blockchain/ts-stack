import {
  ChainTracker,
  defaultHttpClient,
  HttpClient,
  HttpClientRequestOptions,
  HttpClientResponse,
  WhatsOnChainConfig
} from '@bsv/sdk'

interface WhatsOnChainBlockHeader {
  merkleroot: string
}

const HEX_32_BYTES = /^[0-9a-fA-F]{64}$/
const MAX_BLOCK_HEIGHT = 0x7fffffff
const DEFAULT_REQUEST_TIMEOUT_MSECS = 30_000
const MAX_REQUEST_TIMEOUT_MSECS = 60 * 60 * 1000

type LocalWhatsOnChainConfig = WhatsOnChainConfig & { requestTimeoutMsecs?: number }

function plainDataProperties(value: unknown, name: string): Record<string, PropertyDescriptor> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an accessor-free plain data object.`)
  }
  const prototype = Object.getPrototypeOf(value)
  const properties = Object.getOwnPropertyDescriptors(value)
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(properties).length > 64 ||
    Object.values(properties).some(property => property.get != null || property.set != null)
  ) {
    throw new Error(`${name} must be an accessor-free plain data object.`)
  }
  return properties
}

function firstHeaderHeight(value: unknown): number {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2_000) {
    throw new Error('WhatsOnChain block headers must be a bounded dense array.')
  }
  const properties = Object.getOwnPropertyDescriptors(value)
  const expected = new Set(['length', ...Array.from({ length: value.length }, (_, index) => String(index))])
  if (
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(properties).length !== expected.size ||
    Object.keys(properties).some(key => !expected.has(key)) ||
    Object.values(properties).some(property => property.get != null || property.set != null)
  ) {
    throw new Error('WhatsOnChain block headers must be a bounded dense array.')
  }
  const header = plainDataProperties(properties['0'].value, 'WhatsOnChain block header')
  const height = header.height?.value
  if (!Number.isSafeInteger(height) || (height as number) < 0 || (height as number) > MAX_BLOCK_HEIGHT) {
    throw new Error('WhatsOnChain returned an invalid block height.')
  }
  return height as number
}

/**
 * Represents a chain tracker based on What's On Chain .
 */
export default class SdkWhatsOnChain implements ChainTracker {
  readonly network: string
  readonly apiKey: string
  protected readonly URL: string
  protected readonly httpClient: HttpClient
  protected readonly requestTimeoutMsecs: number

  /**
   * Constructs an instance of the WhatsOnChain ChainTracker.
   *
   * @param {'main' | 'test' | 'stn'} network - The BSV network to use when calling the WhatsOnChain API.
   * @param {WhatsOnChainConfig} config - Configuration options for the WhatsOnChain ChainTracker.
   */
  constructor(
    network: 'main' | 'test' | 'stn' | 'ttn' | 'tstn' | 'regtest' = 'main',
    config: LocalWhatsOnChainConfig = {}
  ) {
    if (!['main', 'test', 'stn', 'ttn', 'tstn', 'regtest'].includes(network)) {
      throw new Error('WhatsOnChain network is invalid.')
    }
    const properties = plainDataProperties(config, 'WhatsOnChain config')
    const apiKey = properties.apiKey?.value
    const httpClient = properties.httpClient?.value
    const requestTimeoutMsecs = properties.requestTimeoutMsecs?.value ?? DEFAULT_REQUEST_TIMEOUT_MSECS
    if (
      apiKey !== undefined &&
      (typeof apiKey !== 'string' || apiKey.length > 4_096 || /\p{Cc}/u.test(apiKey))
    ) {
      throw new Error('WhatsOnChain API key is invalid.')
    }
    if (httpClient !== undefined && (httpClient == null || typeof httpClient.request !== 'function')) {
      throw new Error('WhatsOnChain HTTP client is invalid.')
    }
    if (
      !Number.isSafeInteger(requestTimeoutMsecs) ||
      (requestTimeoutMsecs as number) < 1 ||
      (requestTimeoutMsecs as number) > MAX_REQUEST_TIMEOUT_MSECS
    ) {
      throw new Error(`WhatsOnChain request timeout must be an integer from 1 through ${MAX_REQUEST_TIMEOUT_MSECS}.`)
    }
    this.network = network
    if (network === 'ttn') {
      this.URL = 'https://api.woc-ttn.bsvblockchain.tech/v1/bsv/test'
    } else if (network === 'tstn' || network === 'regtest') {
      // tstn and regtest have no WhatsOnChain / explorer service. The instance is constructed for
      // interface completeness but is not registered as a Services provider, so this URL
      // is never used for requests.
      this.URL = ''
    } else {
      this.URL = `https://api.whatsonchain.com/v1/bsv/${network}`
    }
    this.httpClient = httpClient ?? defaultHttpClient()
    this.apiKey = apiKey ?? ''
    this.requestTimeoutMsecs = requestTimeoutMsecs as number
  }

  protected async request<T, Data = unknown>(
    url: string,
    options: HttpClientRequestOptions<Data>
  ): Promise<HttpClientResponse<T>> {
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMsecs)
    const signal = options.signal == null ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal])
    return await this.httpClient.request<T, Data>(url, { ...options, signal })
  }

  async isValidRootForHeight(root: string, height: number): Promise<boolean> {
    if (typeof root !== 'string' || !HEX_32_BYTES.test(root)) {
      throw new Error('WhatsOnChain Merkle root must be 32 hex bytes.')
    }
    if (!Number.isSafeInteger(height) || height < 0 || height > MAX_BLOCK_HEIGHT) {
      throw new Error(`WhatsOnChain height must be an integer from 0 through ${MAX_BLOCK_HEIGHT}.`)
    }
    root = root.toLowerCase()
    const requestOptions = {
      method: 'GET',
      headers: this.getHttpHeaders()
    }

    const response = await this.request<WhatsOnChainBlockHeader>(
      `${this.URL}/block/${height}/header`,
      requestOptions
    )
    if (response.ok) {
      const properties = plainDataProperties(response.data, 'WhatsOnChain block header')
      const merkleRoot = properties.merkleroot?.value
      if (typeof merkleRoot !== 'string' || !HEX_32_BYTES.test(merkleRoot)) {
        throw new Error('WhatsOnChain returned an invalid Merkle root.')
      }
      return merkleRoot.toLowerCase() === root
    } else if (response.status === 404) {
      return false
    } else {
      throw new Error('Failed to verify Merkle root with WhatsOnChain.')
    }
  }

  async currentHeight(): Promise<number> {
    try {
      const requestOptions = {
        method: 'GET',
        headers: this.getHttpHeaders()
      }

      const response = await this.request<Array<{ height: number }>>(
        `${this.URL}/block/headers`,
        requestOptions
      )
      if (response.ok) {
        return firstHeaderHeight(response.data)
      } else {
        throw new Error('Failed to get current height from WhatsOnChain.')
      }
    } catch {
      throw new Error('Failed to get current height from WhatsOnChain.')
    }
  }

  protected getHttpHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json'
    }

    if (typeof this.apiKey === 'string' && this.apiKey.trim() !== '') {
      headers.Authorization = this.apiKey
    }

    return headers
  }
}
