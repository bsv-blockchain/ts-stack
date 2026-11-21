import LookupResolver, { type LookupNetworkPreset } from '../overlay-tools/LookupResolver.js'
import { getHashFromURL, isValidURL, normalizeURL } from './StorageUtils.js'
import Transaction from '../transaction/Transaction.js'
import { sha256 } from '../primitives/Hash.js'
import { toHex } from '../primitives/utils.js'
import { createPublicHTTPSFetch } from './PublicHTTPSFetch.js'
import { decodeAndVerifyUHRPAdvertisement } from './UHRPAdvertisementValidation.js'

export const DEFAULT_STORAGE_DOWNLOAD_MAX_BYTES = 256 * 1024 * 1024
const MAX_UHRP_LOOKUP_RESULTS = 100
const MAX_UHRP_LOOKUP_BEEF_BYTES = 16 * 1024 * 1024

function boundedBEEF(value: unknown): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_UHRP_LOOKUP_BEEF_BYTES) {
    throw new Error('UHRP lookup BEEF must be a bounded byte array')
  }
  for (let index = 0; index < value.length; index++) {
    if (
      !Object.prototype.hasOwnProperty.call(value, index) ||
      !Number.isInteger(value[index]) ||
      value[index] < 0 ||
      value[index] > 255
    ) {
      throw new Error('UHRP lookup BEEF must be a bounded byte array')
    }
  }
  return value as number[]
}

export interface DownloaderConfig {
  networkPreset?: LookupNetworkPreset
  /** Maximum file bytes materialized in memory. Defaults to 256 MiB. */
  maxDownloadBytes?: number
  /** Explicit transport injection for controlled/test environments. */
  fetchClient?: typeof fetch
  /**
   * Deadline in milliseconds for each host (1 to 2147483647), covering the
   * request and the body. A host that misses it has its request aborted and
   * its body read cancelled, and the next host is tried. No deadline by default.
   */
  timeoutMs?: number
}

/** Why one advertised host did not yield the file. */
export type StorageDownloadFailureReason =
  /** The host answered a non-success HTTP status. */
  | 'http'
  /** The host missed the configured `timeoutMs`. */
  | 'timeout'
  /** The declared or actual size was malformed or exceeded `maxDownloadBytes`. */
  | 'size'
  /** The bytes did not hash to the UHRP URL. */
  | 'integrity'
  /** The response had no readable body. */
  | 'empty'
  /** The request or the body read failed (connection, TLS, refused redirect, reset). */
  | 'network'

/** The outcome of trying one advertised host. */
export interface StorageDownloadAttempt {
  url: string
  reason: StorageDownloadFailureReason
  /** The HTTP status, for `reason: 'http'`. */
  status?: number
}

/**
 * Thrown by {@link StorageDownloader.download} when no host yields the file.
 * The message is unchanged from earlier releases; `attempts` lists each
 * advertised host tried, in order, and is empty when no host advertises it.
 */
export class StorageDownloadError extends Error {
  readonly attempts: StorageDownloadAttempt[]

  constructor(message: string, attempts: StorageDownloadAttempt[]) {
    super(message)
    this.name = 'StorageDownloadError'
    this.attempts = attempts
  }
}

export interface DownloadResult {
  data: Uint8Array
  mimeType: string | null
}

export class StorageDownloader {
  readonly #networkPreset?: LookupNetworkPreset = 'mainnet'
  readonly #lookupResolver: LookupResolver
  readonly #maxDownloadBytes: number
  readonly #fetchClient: typeof fetch
  readonly #timeoutMs?: number

  constructor(config?: DownloaderConfig) {
    this.#networkPreset = config?.networkPreset ?? 'mainnet'
    this.#lookupResolver = new LookupResolver({ networkPreset: this.#networkPreset })
    const maximum = config?.maxDownloadBytes ?? DEFAULT_STORAGE_DOWNLOAD_MAX_BYTES
    if (!Number.isSafeInteger(maximum) || maximum < 1) {
      throw new RangeError('maxDownloadBytes must be a positive safe integer')
    }
    this.#maxDownloadBytes = maximum
    this.#fetchClient = config?.fetchClient ?? createPublicHTTPSFetch()
    const timeoutMs = config?.timeoutMs
    // Timers treat a delay above 2^31-1 ms as about 1 ms, which would time out every host.
    if (
      timeoutMs !== undefined &&
      (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
    ) {
      throw new RangeError('timeoutMs must be an integer between 1 and 2147483647')
    }
    this.#timeoutMs = timeoutMs
  }

  /**
   * Resolves the UHRP URL to a list of HTTP URLs where content can be downloaded.
   * @param uhrpUrl The UHRP URL to resolve.
   * @returns A promise that resolves to an array of HTTP URLs.
   */
  public async resolve(uhrpUrl: string): Promise<string[]> {
    if (!isValidURL(uhrpUrl)) throw new Error('Invalid parameter UHRP url')
    const requestedHash = toHex(getHashFromURL(uhrpUrl))
    // Use UHRP lookup service
    const response = await this.#lookupResolver.query({
      service: 'ls_uhrp',
      query: {
        uhrpUrl: normalizeURL(uhrpUrl),
        limit: MAX_UHRP_LOOKUP_RESULTS,
        offset: 0
      }
    })
    if (response.type !== 'output-list') {
      throw new Error('Lookup answer must be an output list')
    }
    if (!Array.isArray(response.outputs) || response.outputs.length > MAX_UHRP_LOOKUP_RESULTS) {
      throw new Error('UHRP lookup returned too many outputs')
    }
    const decodedResults: string[] = []
    const seen = new Set<string>()
    const currentTime = Math.floor(Date.now() / 1000)
    for (const output of response.outputs) {
      try {
        if (
          output == null ||
          typeof output !== 'object' ||
          !Number.isSafeInteger(output.outputIndex) ||
          output.outputIndex < 0 ||
          output.outputIndex > 0xffffffff
        ) {
          continue
        }
        if (
          output.txid !== undefined &&
          (typeof output.txid !== 'string' || !/^[0-9a-f]{64}$/i.test(output.txid))
        ) {
          continue
        }
        // Lookup services historically return ordinary BEEF. When a txid hint
        // is present, select that exact transaction from the bundle; otherwise
        // retain the ordinary-BEEF convention that the final transaction is
        // the subject. The selected output and signed UHRP fields below remain
        // the security boundary, so callers do not need to migrate to Atomic
        // BEEF merely to resolve an advertisement.
        const tx = Transaction.fromBEEF(boundedBEEF(output.beef), output.txid)
        const txid = tx.id('hex').toLowerCase()
        if (output.txid !== undefined) {
          if (output.txid.toLowerCase() !== txid) continue
        }
        const selectedOutput = tx.outputs[output.outputIndex]
        if (selectedOutput == null) continue
        const token = await decodeAndVerifyUHRPAdvertisement(selectedOutput.lockingScript)
        if (toHex(token.hash) !== requestedHash || token.expiryTime < currentTime) continue
        if (seen.has(token.hostedFileLocation)) continue
        seen.add(token.hostedFileLocation)
        decodedResults.push(token.hostedFileLocation)
      } catch {
        // One hostile or malformed overlay result must not suppress valid hosts.
      }
    }
    return decodedResults
  }

  /**
   * Downloads the content from the UHRP URL after validating the hash for integrity.
   * @param uhrpUrl The UHRP URL to download.
   * @returns A promise that resolves to the downloaded content.
   * @throws {StorageDownloadError} When no advertised host yields the file.
   */
  public async download(uhrpUrl: string): Promise<DownloadResult> {
    if (!isValidURL(uhrpUrl)) {
      throw new Error('Invalid parameter UHRP url')
    }
    const hash = getHashFromURL(uhrpUrl)
    const expected = toHex(hash)
    const downloadURLs = await this.resolve(uhrpUrl)

    if (!Array.isArray(downloadURLs) || downloadURLs.length === 0) {
      throw new StorageDownloadError('No one currently hosts this file!', [])
    }

    const attempts: StorageDownloadAttempt[] = []
    for (const url of downloadURLs) {
      const result = await this.#tryDownload(url, expected)
      if (!('reason' in result)) return result
      attempts.push(result)
    }
    throw new StorageDownloadError(`Unable to download content from ${uhrpUrl}`, attempts)
  }

  async #tryDownload(
    url: string,
    expected: string
  ): Promise<DownloadResult | StorageDownloadAttempt> {
    const timeoutMs = this.#timeoutMs
    if (timeoutMs === undefined) return await this.#fetchAndValidate(url, expected)
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    // The race also covers a fetch client that ignores the abort signal.
    const deadline = new Promise<StorageDownloadAttempt>(resolve => {
      timer = setTimeout(() => {
        // Settle first so a read the abort ends early cannot win the race.
        resolve({ url, reason: 'timeout' })
        controller.abort()
      }, timeoutMs)
    })
    try {
      return await Promise.race([
        this.#fetchAndValidate(url, expected, controller.signal),
        deadline
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  /** Never rejects: every failure becomes an attempt record. */
  async #fetchAndValidate(
    url: string,
    expected: string,
    signal?: AbortSignal
  ): Promise<DownloadResult | StorageDownloadAttempt> {
    let result: Response
    try {
      const init: RequestInit = { method: 'GET', redirect: 'error' }
      if (signal !== undefined) init.signal = signal
      result = await this.#fetchClient(url, init)
    } catch {
      return { url, reason: 'network' }
    }
    try {
      if (!result.ok || result.status >= 400) {
        const attempt: StorageDownloadAttempt = { url, reason: 'http' }
        if (Number.isSafeInteger(result.status)) attempt.status = result.status
        return attempt
      }

      const declaredLength = result.headers.get('Content-Length')
      if (declaredLength !== null) {
        if (!/^\d+$/.test(declaredLength)) return { url, reason: 'size' }
        const length = Number(declaredLength)
        if (!Number.isSafeInteger(length) || length > this.#maxDownloadBytes) {
          return { url, reason: 'size' }
        }
      }

      let data: Uint8Array
      if (result.body != null) {
        const reader = result.body.getReader()
        // Some transports (the default Node one included) stop honouring the
        // request signal once headers arrive, so the deadline cancels the read.
        const cancel = (): void => {
          reader.cancel().catch(() => {})
        }
        if (signal?.aborted === true) cancel()
        signal?.addEventListener('abort', cancel, { once: true })
        const body = await this.#readBody(reader, this.#maxDownloadBytes)
        if (body === undefined) return { url, reason: 'size' }
        data = body
      } else if (typeof result.arrayBuffer === 'function') {
        // Compatibility for fetch implementations without a WHATWG body stream
        // (such as React Native's). The declared length was checked above, but
        // the body is only measured once it has been read.
        data = new Uint8Array(await result.arrayBuffer())
        if (data.byteLength > this.#maxDownloadBytes) return { url, reason: 'size' }
      } else {
        return { url, reason: 'empty' }
      }
      if (toHex(sha256(data)) !== expected) return { url, reason: 'integrity' }
      return {
        data,
        mimeType: result.headers.get('Content-Type')
      }
    } catch {
      return { url, reason: signal?.aborted === true ? 'timeout' : 'network' }
    }
  }

  async #readBody(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    maximum: number
  ): Promise<Uint8Array | undefined> {
    const chunks: Uint8Array[] = []
    let totalLength = 0

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      totalLength += value.length
      if (!Number.isSafeInteger(totalLength) || totalLength > maximum) {
        await reader.cancel('Storage download exceeds the configured size limit')
        return undefined
      }
    }

    const data = new Uint8Array(totalLength)
    let offset = 0
    for (const chunk of chunks) {
      data.set(chunk, offset)
      offset += chunk.length
    }
    return data
  }
}
