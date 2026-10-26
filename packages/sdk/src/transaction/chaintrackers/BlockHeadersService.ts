import ChainTracker from '../ChainTracker.js'
import { HttpClient } from '../http/HttpClient.js'
import { defaultHttpClient } from '../http/DefaultHttpClient.js'
import { hasControlCharacter, utf8ByteLength } from '../../primitives/UTF8.js'
import { lockConfiguration } from '../http/ConfigurationLock.js'

/** Configuration options for the BlockHeadersService ChainTracker. */
export interface BlockHeadersServiceConfig {
  /** The HTTP client used to make requests to the API. */
  httpClient?: HttpClient

  /** The API key used to authenticate requests to the BlockHeadersService API. */
  apiKey?: string
}

interface MerkleRootVerificationRequest {
  blockHeight: number
  merkleRoot: string
}

interface MerkleRootConfirmation {
  blockHash: string
  blockHeight: number
  merkleRoot: string
  confirmation: 'CONFIRMED' | 'UNCONFIRMED'
}

interface MerkleRootVerificationResponse {
  confirmationState: 'CONFIRMED' | 'UNCONFIRMED'
  confirmations: MerkleRootConfirmation[]
}

const HASH = /^[0-9a-f]{64}$/i
const MAX_BLOCK_HEIGHT = 0x7fffffff
const MAX_CONFIRMATIONS = 1024

function boundedText(
  value: unknown,
  label: string,
  maximumBytes: number,
  allowEmpty = true
): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
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

function normalizeHttpClient(value: unknown): HttpClient {
  const client = value ?? defaultHttpClient()
  if (
    client == null ||
    typeof client !== 'object' ||
    typeof (client as HttpClient).request !== 'function'
  ) {
    throw new TypeError('Block Headers Service httpClient must provide request().')
  }
  return client as HttpClient
}

function normalizeConfig(config: unknown): { apiKey: string; httpClient: HttpClient } {
  const properties = ownDataProperties(config, 'Block Headers Service config', 8)
  return {
    apiKey:
      properties.apiKey?.value === undefined
        ? ''
        : boundedText(properties.apiKey.value, 'Block Headers Service API key', 16 * 1024),
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

function denseArrayProperties(value: unknown): Record<string, PropertyDescriptor> | undefined {
  if (!Array.isArray(value) || value.length > MAX_CONFIRMATIONS) return undefined
  const properties = Object.getOwnPropertyDescriptors(value)
  const expectedKeys = new Set([
    'length',
    ...Array.from({ length: value.length }, (_, index) => String(index))
  ])
  if (
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(properties).length !== expectedKeys.size ||
    Object.keys(properties).some(key => !expectedKeys.has(key)) ||
    Object.values(properties).some(property => property.get != null || property.set != null)
  ) {
    return undefined
  }
  return properties
}

function isConfirmedResponse(value: unknown, root: string, height: number): boolean {
  let properties: Record<string, PropertyDescriptor>
  try {
    properties = ownDataProperties(value, 'Block Headers Service response', 16)
  } catch {
    return false
  }
  if (properties.confirmationState?.value !== 'CONFIRMED') return false
  const confirmations = denseArrayProperties(properties.confirmations?.value)
  if (confirmations === undefined) return false
  for (let index = 0; index < (properties.confirmations.value as unknown[]).length; index++) {
    let confirmation: Record<string, PropertyDescriptor>
    try {
      confirmation = ownDataProperties(
        confirmations[index]?.value,
        'Block Headers Service confirmation',
        16
      )
    } catch {
      return false
    }
    const blockHash = confirmation.blockHash?.value
    const blockHeight = confirmation.blockHeight?.value
    const merkleRoot = confirmation.merkleRoot?.value
    const state = confirmation.confirmation?.value
    if (
      typeof blockHash !== 'string' ||
      !HASH.test(blockHash) ||
      !Number.isSafeInteger(blockHeight) ||
      (blockHeight as number) < 0 ||
      (blockHeight as number) > MAX_BLOCK_HEIGHT ||
      typeof merkleRoot !== 'string' ||
      !HASH.test(merkleRoot) ||
      (state !== 'CONFIRMED' && state !== 'UNCONFIRMED')
    ) {
      return false
    }
    if (state === 'CONFIRMED' && blockHeight === height && merkleRoot.toLowerCase() === root) {
      return true
    }
  }
  return false
}

function currentHeightResponse(value: unknown): number | undefined {
  try {
    const properties = ownDataProperties(value, 'Block Headers Service response', 16)
    const height = properties.height?.value
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
 * Represents a chain tracker based on a BlockHeadersService API.
 *
 * @example
 * ```typescript
 * const chainTracker = new BlockHeadersService('https://headers.spv.money', {
 *   apiKey: '17JxRHcJerGBEbusx56W8o1m8Js73TFGo'
 * })
 * ```
 */
export class BlockHeadersService implements ChainTracker {
  protected readonly baseUrl: string
  protected readonly httpClient: HttpClient
  protected readonly apiKey: string

  /**
   * Constructs an instance of the BlockHeadersService ChainTracker.
   *
   * @param {string} baseUrl - The base URL for the BlockHeadersService API (e.g. https://headers.spv.money)
   * @param {BlockHeadersServiceConfig} config - Configuration options for the BlockHeadersService ChainTracker.
   */
  constructor(baseUrl: string, config: BlockHeadersServiceConfig = {}) {
    this.baseUrl = boundedText(baseUrl, 'Block Headers Service base URL', 2048, false)
    const normalized = normalizeConfig(config)
    this.httpClient = normalized.httpClient
    this.apiKey = normalized.apiKey
    lockConfiguration(this, ['baseUrl', 'httpClient', 'apiKey'])
  }

  /**
   * Verifies if a given merkle root is valid for a specific block height.
   *
   * @param {string} root - The merkle root to verify.
   * @param {number} height - The block height to check against.
   * @returns {Promise<boolean>} - A promise that resolves to true if the merkle root is valid for the specified block height, false otherwise.
   */
  async isValidRootForHeight(root: string, height: number): Promise<boolean> {
    const query = normalizeQuery(root, height)
    const requestOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      data: [
        {
          blockHeight: query.height,
          merkleRoot: query.root
        }
      ] as MerkleRootVerificationRequest[]
    }

    try {
      const response = await this.httpClient.request<MerkleRootVerificationResponse>(
        `${this.baseUrl}/api/v1/chain/merkleroot/verify`,
        requestOptions
      )

      if (response.ok) {
        return isConfirmedResponse(response.data, query.root, query.height)
      } else {
        throw new Error('provider request failed')
      }
    } catch {
      throw new Error(`Failed to verify merkleroot for height ${query.height}.`)
    }
  }

  /**
   * Gets the current block height from the BlockHeadersService API.
   *
   * @returns {Promise<number>} - A promise that resolves to the current block height.
   */
  async currentHeight(): Promise<number> {
    const requestOptions = {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      }
    }

    try {
      const response = await this.httpClient.request<{ height: number }>(
        `${this.baseUrl}/api/v1/chain/tip/longest`,
        requestOptions
      )

      if (response.ok) {
        const height = currentHeightResponse(response.data)
        if (height !== undefined) return height
      }
      throw new Error('provider response was invalid')
    } catch {
      throw new Error('Failed to get current height from Block Headers Service.')
    }
  }
}
