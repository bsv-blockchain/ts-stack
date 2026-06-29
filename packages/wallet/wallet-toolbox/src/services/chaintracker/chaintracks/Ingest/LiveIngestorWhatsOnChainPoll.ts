import { BlockHeader, Chain } from '../../../../sdk'
import { wait } from '../../../../utility/utilityHelpers'
import { LiveIngestorBase, LiveIngestorBaseOptions } from './LiveIngestorBase'
import {
  WhatsOnChainServices,
  WhatsOnChainServicesOptions,
  WocGetHeadersHeader,
  wocGetHeadersHeaderToBlockHeader
} from './WhatsOnChainServices'
import { ChaintracksFetchError } from '../util/ChaintracksFetch'

export interface LiveIngestorWhatsOnChainOptions extends LiveIngestorBaseOptions, WhatsOnChainServicesOptions {
  /**
   * Maximum msces of "normal" time with no ping received from connected WoC service.
   */
  idleWait: number | undefined
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
  /**
   * Initial delay before retrying a failed polling request.
   */
  retryWait?: number
  /**
   * Maximum delay before retrying repeated failed polling requests.
   */
  retryWaitMax?: number
}

/**
 * Reports new headers by polling periodically.
 */
export class LiveIngestorWhatsOnChainPoll extends LiveIngestorBase {
  static createLiveIngestorWhatsOnChainOptions (chain: Chain): LiveIngestorWhatsOnChainOptions {
    const options: LiveIngestorWhatsOnChainOptions = {
      ...WhatsOnChainServices.createWhatsOnChainServicesOptions(chain),
      ...LiveIngestorBase.createLiveIngestorBaseOptions(chain),
      idleWait: 100000,
      retryWait: 5000,
      retryWaitMax: 120000
    }
    return options
  }

  idleWait: number
  retryWait: number
  retryWaitMax: number
  woc: WhatsOnChainServices
  done: boolean = false

  constructor (options: LiveIngestorWhatsOnChainOptions) {
    super(options)
    this.idleWait = options.idleWait ?? 100000
    this.retryWait = options.retryWait ?? 5000
    this.retryWaitMax = options.retryWaitMax ?? 120000
    this.woc = new WhatsOnChainServices(options)
  }

  async getHeaderByHash (hash: string): Promise<BlockHeader | undefined> {
    const header = await this.woc.getHeaderByHash(hash)
    return header
  }

  async startListening (liveHeaders: BlockHeader[]): Promise<void> {
    this.done = false
    let lastHeaders: WocGetHeadersHeader[] = []
    let failureCount = 0

    while (!this.done) {
      let headers: WocGetHeadersHeader[]
      try {
        headers = await this.woc.getHeaders()
        failureCount = 0
      } catch (error: unknown) {
        failureCount++
        const retryMsecs = this.getRetryWaitMsecs(error, failureCount)
        this.log(`LiveIngestorWhatsOnChainPoll getHeaders failed attempt=${failureCount} retryMsecs=${retryMsecs} error=${this.errorMessage(error)}`)
        await this.waitUnlessStopped(retryMsecs)
        continue
      }

      const newHeaders = headers.filter(h => !lastHeaders.some(lh => lh.hash === h.hash))

      for (const h of newHeaders) {
        const bh = wocGetHeadersHeaderToBlockHeader(h)
        liveHeaders.unshift(bh)
      }

      lastHeaders = headers

      await this.waitUnlessStopped(60 * 1000)
    }
    this.log('LiveIngestorWhatsOnChainPoll stopped')
  }

  private getRetryWaitMsecs (error: unknown, failureCount: number): number {
    if (error instanceof ChaintracksFetchError && error.retryAfterMsecs != null) {
      return Math.min(Math.max(error.retryAfterMsecs, 0), this.retryWaitMax)
    }
    const multiplier = Math.min(2 ** (failureCount - 1), 16)
    return Math.min(this.retryWait * multiplier, this.retryWaitMax)
  }

  private errorMessage (error: unknown): string {
    if (error instanceof ChaintracksFetchError) return `${error.status} ${error.statusText}: ${error.message}`
    if (error instanceof Error) return error.message
    return String(error)
  }

  private async waitUnlessStopped (msecs: number): Promise<void> {
    let remaining = msecs
    while (remaining > 0 && !this.done) {
      const chunk = Math.min(1000, remaining)
      await wait(chunk)
      remaining -= chunk
    }
  }

  stopListening (): void {
    this.done = true
  }

  override async shutdown (): Promise<void> {
    this.stopListening()
  }
}
