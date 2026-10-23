import { Chain } from '../../../../sdk'
import { ChaintracksClientApi } from '../Api/ChaintracksClientApi'
import { BlockHeader } from '../Api/BlockHeaderApi'
import { validateHeaderFormat, validateHeaderProofOfWork } from '../util/blockHeaderUtilities'
import { LiveIngestorBase, LiveIngestorBaseOptions } from './LiveIngestorBase'
import { safeDiagnostic } from '../util/safeDiagnostic'

export interface LiveIngestorChaintracksSSEOptions extends LiveIngestorBaseOptions {
  chaintracks: ChaintracksClientApi
  /** Maximum number of remote events retained for local processing. Default: 4096. */
  maxQueuedHeaders?: number
}

/**
 * Adapts a remote Chaintracks event stream, such as Arcade/go-chaintracks
 * `/chaintracks/v2/tip/stream`, into the local Chaintracks live-ingestor API.
 */
export class LiveIngestorChaintracksSSE extends LiveIngestorBase {
  static createLiveIngestorChaintracksSSEOptions(
    chain: Chain,
    chaintracks: ChaintracksClientApi
  ): LiveIngestorChaintracksSSEOptions {
    return {
      ...LiveIngestorBase.createLiveIngestorBaseOptions(chain),
      chaintracks,
      maxQueuedHeaders: 4096
    }
  }

  private subscriptionId?: string
  private stopped = false
  private resolveStopped?: () => void
  private readonly maxQueuedHeaders: number
  private unsubscribePromise: Promise<void> = Promise.resolve()

  constructor(private readonly options: LiveIngestorChaintracksSSEOptions) {
    super(options)
    this.maxQueuedHeaders = options.maxQueuedHeaders ?? 4096
    if (!Number.isSafeInteger(this.maxQueuedHeaders) || this.maxQueuedHeaders < 1 || this.maxQueuedHeaders > 100_000) {
      throw new Error('maxQueuedHeaders must be an integer between 1 and 100000.')
    }
  }

  async getHeaderByHash(hash: string): Promise<BlockHeader | undefined> {
    if (!/^[0-9a-fA-F]{64}$/.test(hash)) throw new Error('Block hash must be 32 hex bytes.')
    const header = await this.options.chaintracks.findHeaderForBlockHash(hash)
    if (header == null) return undefined
    this.validateRemoteHeader(header)
    if (header.hash.toLowerCase() !== hash.toLowerCase()) {
      throw new Error('ChainTracks upstream returned a header for the wrong hash.')
    }
    return { ...header }
  }

  async startListening(liveHeaders: BlockHeader[]): Promise<void> {
    this.stopped = false
    const actual = await this.options.chaintracks.getChain()
    if (actual !== this.chain) {
      throw new Error(`ChainTracks upstream network '${actual}' does not match configured chain '${this.chain}'.`)
    }
    if (this.stopped) return
    const subscriptionId = await this.options.chaintracks.subscribeHeaders(header => {
      if (this.stopped) return
      try {
        this.validateRemoteHeader(header)
      } catch (error) {
        const message = safeDiagnostic(error)
        this.log(`Ignoring invalid ChainTracks upstream header: ${message}`)
        return
      }
      if (liveHeaders.length >= this.maxQueuedHeaders) {
        this.log(`Ignoring ChainTracks upstream header while the ${this.maxQueuedHeaders}-header queue is full.`)
        return
      }
      liveHeaders.push({ ...header })
    })
    if (typeof subscriptionId !== 'string' || subscriptionId.length === 0 || subscriptionId.length > 128) {
      throw new Error('ChainTracks upstream returned an invalid subscription id.')
    }
    if (this.stopped) {
      await this.options.chaintracks.unsubscribe(subscriptionId)
      return
    }
    this.subscriptionId = subscriptionId
    await new Promise<void>(resolve => {
      this.resolveStopped = resolve
      if (this.stopped) resolve()
    })
  }

  stopListening(): void {
    this.stopped = true
    const subscriptionId = this.subscriptionId
    this.subscriptionId = undefined
    if (subscriptionId != null) this.queueUnsubscribe(subscriptionId)
    const resolveStopped = this.resolveStopped
    this.resolveStopped = undefined
    resolveStopped?.()
  }

  override async shutdown(): Promise<void> {
    this.stopListening()
    await this.unsubscribePromise
  }

  private queueUnsubscribe(subscriptionId: string): void {
    this.unsubscribePromise = this.unsubscribePromise.then(async () => {
      try {
        await this.options.chaintracks.unsubscribe(subscriptionId)
      } catch (error) {
        const message = safeDiagnostic(error)
        this.log(`LiveIngestorChaintracksSSE unsubscribe failed: ${message}`)
      }
    })
  }

  private validateRemoteHeader(header: BlockHeader): void {
    validateHeaderFormat(header)
    validateHeaderProofOfWork(header, this.chain)
  }
}
