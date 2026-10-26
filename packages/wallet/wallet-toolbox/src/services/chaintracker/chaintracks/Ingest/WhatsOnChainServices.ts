import { Chain } from '../../../../sdk/types'
import { BlockHeader } from '../../../../sdk/WalletServices.interfaces'
import { convertWocToBlockHeaderHex, WhatsOnChain, WocChainInfo, WocHeader } from '../../../providers/WhatsOnChain'
import { ChaintracksFetchApi } from '../Api/ChaintracksFetchApi'
import { ChaintracksFetch } from '../util/ChaintracksFetch'
import { HeightRange } from '../util/HeightRange'
import { wait } from '../../../../utility/utilityHelpers'
import { containsControlCharacter } from '../util/safeDiagnostic'

const MAX_BLOCK_HEIGHT = 0x7fffffff
const MAX_RESOURCE_LINKS = 1024
const MAX_RESOURCE_LINK_LENGTH = 4096
const MAX_RECENT_HEADERS = 128

function requirePlainDataRecord(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be a plain data object.`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${name} must be a plain data object.`)
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.keys(descriptors).length > 64 || Object.values(descriptors).some(d => d.get != null || d.set != null)) {
    throw new Error(`${name} must contain only bounded data properties.`)
  }
}

function requireInteger(value: unknown, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(`${name} must be a non-negative integer no greater than ${maximum}.`)
  }
  return value as number
}

function requireFiniteNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative number.`)
  }
  return value
}

function requireString(value: unknown, name: string, pattern?: RegExp): string {
  if (
    typeof value !== 'string' ||
    value.length > MAX_RESOURCE_LINK_LENGTH ||
    (pattern != null && !pattern.test(value))
  ) {
    throw new Error(`${name} is invalid.`)
  }
  return value
}

/**
 * return true to ignore error, false to close service connection
 */
export type ErrorHandler = (code: number, message: string) => boolean
export type EnqueueHandler = (header: BlockHeader) => void

export function parseFileLink(
  file: string
): { range: { fromHeight: number; toHeight: number } | 'latest'; sourceUrl: string; fileName: string } | undefined {
  if (typeof file !== 'string' || file.length === 0 || file.length > MAX_RESOURCE_LINK_LENGTH) return undefined
  let url: URL
  try {
    url = new URL(file)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return undefined
  }
  const parts = url.pathname.split('/')
  const fileName = parts.pop()
  if (!fileName) return undefined
  const sourceUrl = `${url.origin}${parts.join('/')}`
  if (fileName === 'latest') {
    return { range: 'latest', sourceUrl, fileName }
  }
  const match = /^([0-9]+)_([0-9]+)_headers(?:\.bin)?$/.exec(fileName)
  if (match == null) return undefined
  const fromHeight = Number(match[1])
  const toHeight = Number(match[2])
  if (
    Number.isSafeInteger(fromHeight) &&
    Number.isSafeInteger(toHeight) &&
    fromHeight >= 0 &&
    toHeight >= fromHeight &&
    toHeight <= MAX_BLOCK_HEIGHT
  )
    return { range: { fromHeight, toHeight }, sourceUrl, fileName }
  return undefined
}

type ParsedFileLink = NonNullable<ReturnType<typeof parseFileLink>>

async function resolveHeaderFileLink(
  parsed: ParsedFileLink,
  currentRange: HeightRange | undefined,
  neededRange: HeightRange,
  fetch: ChaintracksFetchApi,
  link: string
): Promise<{ range: HeightRange | undefined; result?: GetHeaderByteFileLinksResult }> {
  if (parsed.range !== 'latest') {
    const range = new HeightRange(parsed.range.fromHeight, parsed.range.toHeight)
    const result = neededRange.intersect(range).isEmpty
      ? undefined
      : {
          sourceUrl: parsed.sourceUrl,
          fileName: parsed.fileName,
          range,
          data: undefined,
          publicNetworkOnly: true as const
        }
    return { range, result }
  }
  if (currentRange == null) return { range: currentRange }
  const fromHeight = currentRange.maxHeight + 1
  if (neededRange.maxHeight < fromHeight) return { range: currentRange }
  const maxBytes = (neededRange.maxHeight - fromHeight + 1) * 80
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 80) throw new Error('WhatsOnChain latest header range is invalid.')
  const data = await fetch.download(link, maxBytes, { publicNetworkOnly: true })
  if (data.length === 0 || data.length % 80 !== 0) {
    throw new Error('WhatsOnChain latest header resource must contain a non-empty multiple of 80 bytes.')
  }
  const range = new HeightRange(fromHeight, fromHeight + data.length / 80 - 1)
  const result = neededRange.intersect(range).isEmpty
    ? undefined
    : { sourceUrl: parsed.sourceUrl, fileName: parsed.fileName, range, data, publicNetworkOnly: true as const }
  return { range, result }
}

export interface WhatsOnChainServicesOptions {
  /**
   * Which chain is being tracked. The public WhatsOnChain fallback is only
   * configured automatically for mainnet and testnet.
   */
  chain: Chain
  /**
   * Optional WhatsOnChain API key. ChainTracks works without one and limits
   * anonymous traffic to the documented public rate.
   * https://docs.whatsonchain.com/
   */
  apiKey?: string
  /**
   * Request timeout for GETs to https://api.whatsonchain.com/v1/bsv
   */
  timeout: number
  /**
   * User-Agent header value for requests to https://api.whatsonchain.com/v1/bsv
   */
  userAgent: string
  /**
   * Enable WhatsOnChain client cache option.
   */
  enableCache: boolean
  /**
   * How long chainInfo is considered still valid before updating (msecs).
   */
  chainInfoMsecs: number
  /** Minimum interval between keyless API request starts. Defaults below 3 requests/second. */
  minRequestIntervalMsecs?: number
}

export class WhatsOnChainServices {
  static createWhatsOnChainServicesOptions(chain: Chain): WhatsOnChainServicesOptions {
    const options: WhatsOnChainServicesOptions = {
      chain,
      apiKey: '',
      timeout: 30000,
      userAgent: 'BabbageWhatsOnChainServices',
      enableCache: true,
      chainInfoMsecs: 5000,
      minRequestIntervalMsecs: 350
    }
    return options
  }

  static readonly chainInfo: Array<WocChainInfo | undefined> = []
  static readonly chainInfoTime: Array<Date | undefined> = []
  static readonly chainInfoMsecs: number[] = []
  static readonly chainInfoPromise: Partial<Record<Chain, Promise<WocChainInfo>>> = {}
  private static requestTail: Promise<void> = Promise.resolve()
  private static nextRequestMsecs = 0

  chain: Chain
  woc: WhatsOnChain
  public readonly options: WhatsOnChainServicesOptions

  constructor(options: WhatsOnChainServicesOptions) {
    if (options == null || typeof options !== 'object' || Array.isArray(options)) {
      throw new Error('WhatsOnChain options must be a data object.')
    }
    const descriptors = Object.getOwnPropertyDescriptors(options)
    if (Object.keys(descriptors).length > 64 || Object.values(descriptors).some(d => d.get != null || d.set != null)) {
      throw new Error('WhatsOnChain options must contain only bounded data properties.')
    }
    if (!['main', 'test', 'stn', 'ttn', 'tstn'].includes(options.chain)) {
      throw new Error('WhatsOnChain chain must be a supported non-mock network.')
    }
    if (
      options.apiKey !== undefined &&
      (typeof options.apiKey !== 'string' || options.apiKey.length > 4096 || containsControlCharacter(options.apiKey))
    ) {
      throw new Error('WhatsOnChain apiKey must be a string without control characters and no longer than 4096.')
    }
    if (!Number.isSafeInteger(options.timeout) || options.timeout < 1 || options.timeout > 60 * 60 * 1000) {
      throw new Error('WhatsOnChain timeout must be an integer from 1 through 3600000.')
    }
    if (
      typeof options.userAgent !== 'string' ||
      options.userAgent.length === 0 ||
      options.userAgent.length > 256 ||
      containsControlCharacter(options.userAgent)
    ) {
      throw new Error('WhatsOnChain userAgent must contain 1 through 256 characters without control characters.')
    }
    if (typeof options.enableCache !== 'boolean') throw new Error('WhatsOnChain enableCache must be a boolean.')
    if (
      !Number.isSafeInteger(options.chainInfoMsecs) ||
      options.chainInfoMsecs < 0 ||
      options.chainInfoMsecs > 24 * 60 * 60 * 1000
    ) {
      throw new Error('WhatsOnChain chainInfoMsecs must be an integer from 0 through 86400000.')
    }
    const minRequestIntervalMsecs = options.minRequestIntervalMsecs ?? 350
    if (
      !Number.isSafeInteger(minRequestIntervalMsecs) ||
      minRequestIntervalMsecs < 0 ||
      minRequestIntervalMsecs > 60 * 1000
    ) {
      throw new Error('WhatsOnChain minRequestIntervalMsecs must be an integer from 0 through 60000.')
    }
    this.options = Object.freeze({ ...options, minRequestIntervalMsecs })
    const config = {
      apiKey: this.options.apiKey,
      timeout: this.options.timeout,
      userAgent: this.options.userAgent,
      enableCache: this.options.enableCache,
      requestGate: async () => await this.waitForRateLimit()
    }
    this.chain = this.options.chain
    const chainInfoMsecs = WhatsOnChainServices.chainInfoMsecs as unknown as Record<Chain, number>
    chainInfoMsecs[this.chain] = this.options.chainInfoMsecs
    this.woc = new WhatsOnChain(this.chain, config)
  }

  async getHeaderByHash(hash: string): Promise<BlockHeader | undefined> {
    const header = await this.woc.getBlockHeaderByHash(hash)
    return header
  }

  async getChainInfo(): Promise<WocChainInfo> {
    const chainInfo = WhatsOnChainServices.chainInfo as unknown as Partial<Record<Chain, WocChainInfo>>
    const chainInfoTime = WhatsOnChainServices.chainInfoTime as unknown as Partial<Record<Chain, Date>>
    const chainInfoMsecs = WhatsOnChainServices.chainInfoMsecs as unknown as Partial<Record<Chain, number>>
    const now = new Date()
    let update = chainInfo[this.chain] === undefined
    if (!update && chainInfoTime[this.chain] !== undefined) {
      const elapsed = now.getTime() - chainInfoTime[this.chain]!.getTime()
      update = elapsed > chainInfoMsecs[this.chain]!
    }
    if (update) {
      let pending = WhatsOnChainServices.chainInfoPromise[this.chain]
      if (pending == null) {
        pending = this.woc.getChainInfo()
        WhatsOnChainServices.chainInfoPromise[this.chain] = pending
      }
      try {
        chainInfo[this.chain] = { ...(await pending) }
      } finally {
        if (WhatsOnChainServices.chainInfoPromise[this.chain] === pending) {
          delete WhatsOnChainServices.chainInfoPromise[this.chain]
        }
      }
      chainInfoTime[this.chain] = now
    }
    if (!chainInfo[this.chain]) throw new Error('Unexpected failure to update chainInfo.')
    return { ...chainInfo[this.chain]! }
  }

  async getChainTipHeight(): Promise<number> {
    return (await this.getChainInfo()).blocks
  }

  async getChainTipHash(): Promise<string> {
    return (await this.getChainInfo()).bestblockhash
  }

  /**
   * @param fetch
   * @returns returns the last 10 block headers including height, size, chainwork...
   */
  async getHeaders(fetch?: ChaintracksFetchApi): Promise<WocGetHeadersHeader[]> {
    fetch ||= new ChaintracksFetch()
    await this.waitForRateLimit()
    const headers = await fetch.fetchJson<unknown>(`https://api.whatsonchain.com/v1/bsv/${this.chain}/block/headers`)
    if (
      !Array.isArray(headers) ||
      headers.length > MAX_RECENT_HEADERS ||
      Object.keys(headers).length !== headers.length
    ) {
      throw new Error(`WhatsOnChain headers must be a dense array of at most ${MAX_RECENT_HEADERS} items.`)
    }
    return headers.map((header, index) => sanitizeWocGetHeadersHeader(header, index))
  }

  async getHeaderByteFileLinks(
    neededRange: HeightRange,
    fetch?: ChaintracksFetchApi
  ): Promise<GetHeaderByteFileLinksResult[]> {
    if (neededRange.isEmpty) return []
    requireInteger(neededRange.minHeight, 'neededRange.minHeight', MAX_BLOCK_HEIGHT)
    requireInteger(neededRange.maxHeight, 'neededRange.maxHeight', MAX_BLOCK_HEIGHT)
    fetch ||= new ChaintracksFetch()
    await this.waitForRateLimit()
    const files = await fetch.fetchJson<unknown>(
      `https://api.whatsonchain.com/v1/bsv/${this.chain}/block/headers/resources`
    )
    requirePlainDataRecord(files, 'WhatsOnChain header resources')
    if (
      !Array.isArray(files.files) ||
      files.files.length > MAX_RESOURCE_LINKS ||
      Object.keys(files.files).length !== files.files.length
    ) {
      throw new Error(
        `WhatsOnChain header resources must contain a dense files array of at most ${MAX_RESOURCE_LINKS} links.`
      )
    }
    const r: GetHeaderByteFileLinksResult[] = []
    let range: HeightRange | undefined
    let sawLatest = false
    for (const link of files.files) {
      if (typeof link !== 'string' || link.length === 0 || link.length > MAX_RESOURCE_LINK_LENGTH) {
        throw new Error('WhatsOnChain returned an invalid header resource link.')
      }
      const parsed = parseFileLink(link)
      if (parsed === undefined) {
        let location = 'malformed URL'
        try {
          const rejected = new URL(link)
          location = `${rejected.origin}${rejected.pathname}`
        } catch {
          // Keep the non-sensitive generic location.
        }
        throw new Error(`WhatsOnChain returned an unsafe header resource link (${location}).`)
      }
      if (sawLatest) throw new Error('WhatsOnChain returned a resource after its latest resource.')
      if (parsed.range === 'latest') sawLatest = true
      else if (range != null && parsed.range.fromHeight !== range.maxHeight + 1) {
        throw new Error('WhatsOnChain returned non-contiguous or unordered header resources.')
      }
      const resolved = await resolveHeaderFileLink(parsed, range, neededRange, fetch, link)
      range = resolved.range
      if (resolved.result != null) r.push(resolved.result)
    }
    return r
  }

  private async waitForRateLimit(): Promise<void> {
    let release!: () => void
    const previous = WhatsOnChainServices.requestTail
    WhatsOnChainServices.requestTail = new Promise<void>(resolve => {
      release = resolve
    })
    await previous
    try {
      const delay = Math.max(0, WhatsOnChainServices.nextRequestMsecs - Date.now())
      if (delay > 0) await wait(delay)
      WhatsOnChainServices.nextRequestMsecs = Date.now() + this.options.minRequestIntervalMsecs!
    } finally {
      release()
    }
  }
}

export interface WocGetHeaderByteFileLinks {
  files: string[]
}

export interface WocGetHeadersHeader {
  hash: string
  confirmations: number
  size: number
  height: number
  version: number
  versionHex: string
  merkleroot: string
  time: number
  mediantime: number
  nonce: number
  bits: string
  difficulty: number
  chainwork: string
  previousblockhash: string
  nextblockhash: string
  nTx: number
  num_tx: number
}

export function wocGetHeadersHeaderToBlockHeader(h: WocGetHeadersHeader): BlockHeader {
  return convertWocToBlockHeaderHex(h as unknown as WocHeader)
}

function sanitizeWocGetHeadersHeader(value: unknown, index: number): WocGetHeadersHeader {
  requirePlainDataRecord(value, `WhatsOnChain header ${index}`)
  const header = wocGetHeadersHeaderToBlockHeader(value as unknown as WocGetHeadersHeader)
  const nextblockhash =
    value.nextblockhash == null || value.nextblockhash === ''
      ? ''
      : requireString(
          value.nextblockhash,
          `WhatsOnChain header ${index} nextblockhash`,
          /^[0-9a-fA-F]{64}$/
        ).toLowerCase()
  return {
    hash: header.hash,
    confirmations: requireInteger(value.confirmations, `WhatsOnChain header ${index} confirmations`),
    size: requireInteger(value.size, `WhatsOnChain header ${index} size`),
    height: header.height,
    version: header.version,
    versionHex: requireString(value.versionHex, `WhatsOnChain header ${index} versionHex`, /^[0-9a-fA-F]{8}$/),
    merkleroot: header.merkleRoot,
    time: header.time,
    mediantime: requireInteger(value.mediantime, `WhatsOnChain header ${index} mediantime`, 0xffffffff),
    nonce: header.nonce,
    bits: header.bits.toString(16).padStart(8, '0'),
    difficulty: requireFiniteNumber(value.difficulty, `WhatsOnChain header ${index} difficulty`),
    chainwork: requireString(
      value.chainwork,
      `WhatsOnChain header ${index} chainwork`,
      /^[0-9a-fA-F]{64}$/
    ).toLowerCase(),
    previousblockhash: header.previousHash,
    nextblockhash,
    nTx: requireInteger(value.nTx, `WhatsOnChain header ${index} nTx`),
    num_tx: requireInteger(value.num_tx, `WhatsOnChain header ${index} num_tx`)
  }
}

export interface GetHeaderByteFileLinksResult {
  sourceUrl: string
  fileName: string
  range: HeightRange
  data: Uint8Array | undefined
  /** The URL came from a remote resource manifest and must remain public HTTPS. */
  publicNetworkOnly: true
}
