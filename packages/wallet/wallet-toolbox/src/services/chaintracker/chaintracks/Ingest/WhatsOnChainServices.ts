import { Chain } from '../../../../sdk/types'
import { BlockHeader } from '../../../../sdk/WalletServices.interfaces'
import { WhatsOnChain, WocChainInfo } from '../../../providers/WhatsOnChain'
import { ChaintracksFetchApi } from '../Api/ChaintracksFetchApi'
import { ChaintracksFetch } from '../util/ChaintracksFetch'
import { HeightRange } from '../util/HeightRange'

/**
 * return true to ignore error, false to close service connection
 */
export type ErrorHandler = (code: number, message: string) => boolean
export type EnqueueHandler = (header: BlockHeader) => void

export function parseFileLink (
  file: string
): { range: { fromHeight: number, toHeight: number } | 'latest', sourceUrl: string, fileName: string } | undefined {
  const url = new URL(file)
  const parts = url.pathname.split('/')
  const fileName = parts.pop()
  if (!fileName) return undefined
  const sourceUrl = `${url.protocol}//${url.hostname}${parts.join('/')}`
  const bits = fileName.split('_')
  if (bits.length === 1 && bits[0] === 'latest') {
    return { range: 'latest', sourceUrl, fileName }
  }
  if (bits.length === 3) {
    const fromHeight = Number.parseInt(bits[0], 10)
    const toHeight = Number.parseInt(bits[1], 10)
    if (Number.isInteger(fromHeight) && Number.isInteger(toHeight)) {
      return { range: { fromHeight, toHeight }, sourceUrl, fileName }
    }
  }
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
      : { sourceUrl: parsed.sourceUrl, fileName: parsed.fileName, range, data: undefined }
    return { range, result }
  }
  if (currentRange == null) return { range: currentRange }
  const fromHeight = currentRange.maxHeight + 1
  if (neededRange.maxHeight < fromHeight) return { range: currentRange }
  const data = await fetch.download(link)
  const range = new HeightRange(fromHeight, fromHeight + data.length / 80 - 1)
  const result = neededRange.intersect(range).isEmpty
    ? undefined
    : { sourceUrl: parsed.sourceUrl, fileName: parsed.fileName, range, data }
  return { range, result }
}

export interface WhatsOnChainServicesOptions {
  /**
   * Which chain is being tracked: main, test, or stn.
   */
  chain: Chain
  /**
   * WhatsOnChain.com API Key
   * https://docs.taal.com/introduction/get-an-api-key
   * If unknown or empty, maximum request rate is limited.
   * https://developers.whatsonchain.com/#rate-limits
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
}

export class WhatsOnChainServices {
  static createWhatsOnChainServicesOptions (chain: Chain): WhatsOnChainServicesOptions {
    const options: WhatsOnChainServicesOptions = {
      chain,
      apiKey: '',
      timeout: 30000,
      userAgent: 'BabbageWhatsOnChainServices',
      enableCache: true,
      chainInfoMsecs: 5000
    }
    return options
  }

  static readonly chainInfo: Array<WocChainInfo | undefined> = []
  static readonly chainInfoTime: Array<Date | undefined> = []
  static readonly chainInfoMsecs: number[] = []

  chain: Chain
  woc: WhatsOnChain

  constructor (public options: WhatsOnChainServicesOptions) {
    const config = {
      apiKey: this.options.apiKey,
      timeout: this.options.timeout,
      userAgent: this.options.userAgent,
      enableCache: this.options.enableCache
    }
    this.chain = options.chain
    WhatsOnChainServices.chainInfoMsecs[this.chain] = options.chainInfoMsecs
    this.woc = new WhatsOnChain(this.chain, config)
  }

  async getHeaderByHash (hash: string): Promise<BlockHeader | undefined> {
    const header = await this.woc.getBlockHeaderByHash(hash)
    return header
  }

  async getChainInfo (): Promise<WocChainInfo> {
    const now = new Date()
    let update = WhatsOnChainServices.chainInfo[this.chain] === undefined
    if (!update && WhatsOnChainServices.chainInfoTime[this.chain] !== undefined) {
      const elapsed = now.getTime() - WhatsOnChainServices.chainInfoTime[this.chain].getTime()
      update = elapsed > WhatsOnChainServices.chainInfoMsecs[this.chain]
    }
    if (update) {
      WhatsOnChainServices.chainInfo[this.chain] = await this.woc.getChainInfo()
      WhatsOnChainServices.chainInfoTime[this.chain] = now
    }
    if (!WhatsOnChainServices.chainInfo[this.chain]) throw new Error('Unexpected failure to update chainInfo.')
    return WhatsOnChainServices.chainInfo[this.chain]
  }

  async getChainTipHeight (): Promise<number> {
    return (await this.getChainInfo()).blocks
  }

  async getChainTipHash (): Promise<string> {
    return (await this.getChainInfo()).bestblockhash
  }

  /**
   * @param fetch
   * @returns returns the last 10 block headers including height, size, chainwork...
   */
  async getHeaders (fetch?: ChaintracksFetchApi): Promise<WocGetHeadersHeader[]> {
    fetch ||= new ChaintracksFetch()
    const headers = await fetch.fetchJson<WocGetHeadersHeader[]>(
      `https://api.whatsonchain.com/v1/bsv/${this.chain}/block/headers`
    )
    return headers
  }

  async getHeaderByteFileLinks (
    neededRange: HeightRange,
    fetch?: ChaintracksFetchApi
  ): Promise<GetHeaderByteFileLinksResult[]> {
    fetch ||= new ChaintracksFetch()
    const files = await fetch.fetchJson<WocGetHeaderByteFileLinks>(
      `https://api.whatsonchain.com/v1/bsv/${this.chain}/block/headers/resources`
    )
    const r: GetHeaderByteFileLinksResult[] = []
    let range: HeightRange | undefined
    for (const link of files.files) {
      const parsed = parseFileLink(link)
      if (parsed === undefined) continue // parse error, return empty result
      const resolved = await resolveHeaderFileLink(parsed, range, neededRange, fetch, link)
      range = resolved.range
      if (resolved.result != null) r.push(resolved.result)
    }
    return r
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

export function wocGetHeadersHeaderToBlockHeader (h: WocGetHeadersHeader): BlockHeader {
  const bits: number = typeof h.bits === 'string' ? Number.parseInt(h.bits, 16) : h.bits
  if (!h.previousblockhash) {
    h.previousblockhash = '0000000000000000000000000000000000000000000000000000000000000000' // genesis
  }
  const bh: BlockHeader = {
    height: h.height,
    hash: h.hash,
    version: h.version,
    previousHash: h.previousblockhash,
    merkleRoot: h.merkleroot,
    time: h.time,
    bits,
    nonce: h.nonce
  }

  return bh
}

export interface GetHeaderByteFileLinksResult {
  sourceUrl: string
  fileName: string
  range: HeightRange
  data: Uint8Array | undefined
}
