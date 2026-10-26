import LookupResolver, { type LookupNetworkPreset } from '../overlay-tools/LookupResolver.js'
import { getHashFromURL, isValidURL, normalizeURL } from './StorageUtils.js'
import Transaction from '../transaction/Transaction.js'
import { SHA256 } from '../primitives/Hash.js'
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

  constructor(config?: DownloaderConfig) {
    this.#networkPreset = config?.networkPreset ?? 'mainnet'
    this.#lookupResolver = new LookupResolver({ networkPreset: this.#networkPreset })
    const maximum = config?.maxDownloadBytes ?? DEFAULT_STORAGE_DOWNLOAD_MAX_BYTES
    if (!Number.isSafeInteger(maximum) || maximum < 1) {
      throw new RangeError('maxDownloadBytes must be a positive safe integer')
    }
    this.#maxDownloadBytes = maximum
    this.#fetchClient = config?.fetchClient ?? createPublicHTTPSFetch()
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
   */
  public async download(uhrpUrl: string): Promise<DownloadResult> {
    if (!isValidURL(uhrpUrl)) {
      throw new Error('Invalid parameter UHRP url')
    }
    const hash = getHashFromURL(uhrpUrl)
    const expected = toHex(hash)
    const downloadURLs = await this.resolve(uhrpUrl)

    if (!Array.isArray(downloadURLs) || downloadURLs.length === 0) {
      throw new Error('No one currently hosts this file!')
    }

    for (const url of downloadURLs) {
      const result = await this.#tryDownload(url, expected)
      if (result !== undefined) return result
    }
    throw new Error(`Unable to download content from ${uhrpUrl}`)
  }

  async #tryDownload(url: string, expected: string): Promise<DownloadResult | undefined> {
    try {
      const result = await this.#fetchClient(url, { method: 'GET', redirect: 'error' })
      if (!result.ok || result.status >= 400 || result.body == null) return undefined

      const declaredLength = result.headers.get('Content-Length')
      if (declaredLength !== null) {
        if (!/^\d+$/.test(declaredLength)) return undefined
        const length = Number(declaredLength)
        if (!Number.isSafeInteger(length) || length > this.#maxDownloadBytes) return undefined
      }

      const data = await this.#readAndValidateBody(
        result.body.getReader(),
        expected,
        this.#maxDownloadBytes
      )
      return {
        data,
        mimeType: result.headers.get('Content-Type')
      }
    } catch {
      return undefined
    }
  }

  async #readAndValidateBody(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    expected: string,
    maximum: number
  ): Promise<Uint8Array> {
    const hashStream = new SHA256()
    const chunks: Uint8Array[] = []
    let totalLength = 0

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      hashStream.update(Array.from(value))
      chunks.push(value)
      totalLength += value.length
      if (!Number.isSafeInteger(totalLength) || totalLength > maximum) {
        await reader.cancel('Storage download exceeds the configured size limit')
        throw new Error('Storage download exceeds the configured size limit')
      }
    }

    const digest = toHex(hashStream.digest())
    if (digest !== expected) {
      throw new Error('Data integrity error: value of content does not match hash of the url given')
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
