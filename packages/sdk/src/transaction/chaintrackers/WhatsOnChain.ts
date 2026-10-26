import ChainTracker from '../ChainTracker.js'
import { HttpClient } from '../http/HttpClient.js'
import { defaultHttpClient } from '../http/DefaultHttpClient.js'
import { hasControlCharacter, utf8ByteLength } from '../../primitives/UTF8.js'
import { lockConfiguration } from '../http/ConfigurationLock.js'

/** Configuration options for the WhatsOnChain ChainTracker. */
export interface WhatsOnChainConfig {
  /** Authentication token for the WhatsOnChain API */
  apiKey?: string
  /** The HTTP client used to make requests to the API. */
  httpClient?: HttpClient
}

interface WhatsOnChainBlockHeader {
  merkleroot: string
}

const HASH = /^[0-9a-f]{64}$/i
const MAX_BLOCK_HEIGHT = 0x7fffffff
const MAX_HEADER_RESULTS = 256
const MAX_HEADER_PROPERTIES = 64

function boundedText(value: unknown, label: string, maximumBytes: number): string {
  if (
    typeof value !== 'string' ||
    utf8ByteLength(value) > maximumBytes ||
    hasControlCharacter(value)
  ) {
    throw new TypeError(`${label} must be bounded text without control characters.`)
  }
  return value
}

function ownDataProperties(
  value: unknown,
  label: string,
  maximumProperties: number
): Record<string, PropertyDescriptor> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an accessor-free plain data object.`)
  }
  const prototype = Object.getPrototypeOf(value)
  const properties = Object.getOwnPropertyDescriptors(value)
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(properties).length > maximumProperties ||
    Object.values(properties).some(property => property.get != null || property.set != null)
  ) {
    throw new TypeError(`${label} must be an accessor-free plain data object.`)
  }
  return properties
}

function normalizeNetwork(value: unknown): 'main' | 'test' | 'stn' {
  if (value !== 'main' && value !== 'test' && value !== 'stn') {
    throw new TypeError("What's On Chain network must be 'main', 'test', or 'stn'.")
  }
  return value
}

function normalizeHttpClient(value: unknown): HttpClient {
  const client = value ?? defaultHttpClient()
  if (
    client == null ||
    typeof client !== 'object' ||
    typeof (client as HttpClient).request !== 'function'
  ) {
    throw new TypeError("What's On Chain httpClient must provide request().")
  }
  return client as HttpClient
}

function normalizeConfig(config: unknown): { apiKey: string; httpClient: HttpClient } {
  const properties = ownDataProperties(config, "What's On Chain config", 8)
  return {
    apiKey:
      properties.apiKey?.value === undefined
        ? ''
        : boundedText(properties.apiKey.value, "What's On Chain API key", 16 * 1024),
    httpClient: normalizeHttpClient(properties.httpClient?.value)
  }
}

function normalizeQuery(root: unknown, height: unknown): { root: string; height: number } {
  if (typeof root !== 'string' || !HASH.test(root)) {
    throw new TypeError('Merkle root must be a 64-character hexadecimal string.')
  }
  if (
    !Number.isSafeInteger(height) ||
    (height as number) < 0 ||
    (height as number) > MAX_BLOCK_HEIGHT
  ) {
    throw new TypeError('Block height must be a nonnegative bounded integer.')
  }
  return { root: root.toLowerCase(), height: height as number }
}

function responseMerkleRoot(value: unknown): string | undefined {
  try {
    const properties = ownDataProperties(
      value,
      "What's On Chain block header",
      MAX_HEADER_PROPERTIES
    )
    const root = properties.merkleroot?.value
    return typeof root === 'string' && HASH.test(root) ? root.toLowerCase() : undefined
  } catch {
    return undefined
  }
}

function responseCurrentHeight(value: unknown): number | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_HEADER_RESULTS)
    return undefined
  const arrayProperties = Object.getOwnPropertyDescriptors(value)
  const expectedKeys = new Set([
    'length',
    ...Array.from({ length: value.length }, (_, index) => String(index))
  ])
  if (
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(arrayProperties).length !== expectedKeys.size ||
    Object.keys(arrayProperties).some(key => !expectedKeys.has(key)) ||
    Object.values(arrayProperties).some(property => property.get != null || property.set != null)
  ) {
    return undefined
  }
  try {
    const first = ownDataProperties(
      arrayProperties[0]?.value,
      "What's On Chain height response",
      MAX_HEADER_PROPERTIES
    )
    const height = first.height?.value
    return Number.isSafeInteger(height) &&
      (height as number) >= 0 &&
      (height as number) <= MAX_BLOCK_HEIGHT
      ? (height as number)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Represents a chain tracker based on What's On Chain .
 */
export default class WhatsOnChain implements ChainTracker {
  readonly network: string
  readonly apiKey: string
  protected readonly URL: string
  protected readonly httpClient: HttpClient

  /**
   * Constructs an instance of the WhatsOnChain ChainTracker.
   *
   * @param {'main' | 'test' | 'stn'} network - The BSV network to use when calling the WhatsOnChain API.
   * @param {WhatsOnChainConfig} config - Configuration options for the WhatsOnChain ChainTracker.
   */
  constructor(network: 'main' | 'test' | 'stn' = 'main', config: WhatsOnChainConfig = {}) {
    this.network = normalizeNetwork(network)
    this.URL = `https://api.whatsonchain.com/v1/bsv/${this.network}`
    const normalized = normalizeConfig(config)
    this.httpClient = normalized.httpClient
    this.apiKey = normalized.apiKey
    lockConfiguration(this, ['network', 'URL', 'httpClient', 'apiKey'])
  }

  async isValidRootForHeight(root: string, height: number): Promise<boolean> {
    const query = normalizeQuery(root, height)
    const requestOptions = {
      method: 'GET',
      headers: this.getHttpHeaders()
    }

    try {
      const response = await this.httpClient.request<WhatsOnChainBlockHeader>(
        `${this.URL}/block/${query.height}/header`,
        requestOptions
      )
      if (response.ok) {
        return responseMerkleRoot(response.data) === query.root
      } else if (response.status === 404) {
        return false
      }
      throw new Error('provider request failed')
    } catch {
      throw new Error(`Failed to verify merkleroot for height ${query.height}.`)
    }
  }

  async currentHeight(): Promise<number> {
    try {
      const requestOptions = {
        method: 'GET',
        headers: this.getHttpHeaders()
      }

      const response = await this.httpClient.request<Array<{ height: number }>>(
        `${this.URL}/block/headers`,
        requestOptions
      )
      if (response.ok) {
        const height = responseCurrentHeight(response.data)
        if (height !== undefined) return height
      }
      throw new Error('provider response was invalid')
    } catch {
      throw new Error("Failed to get current height from What's On Chain.")
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
