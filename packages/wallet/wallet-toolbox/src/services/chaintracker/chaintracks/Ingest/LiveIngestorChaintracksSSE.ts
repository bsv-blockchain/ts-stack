import { Chain } from '../../../../sdk'
import { ChaintracksClientApi } from '../Api/ChaintracksClientApi'
import { BlockHeader } from '../Api/BlockHeaderApi'
import { LiveIngestorBase, LiveIngestorBaseOptions } from './LiveIngestorBase'

export interface LiveIngestorChaintracksSSEOptions extends LiveIngestorBaseOptions {
  chaintracks: ChaintracksClientApi
}

/**
 * Adapts a remote Chaintracks event stream, such as Arcade/go-chaintracks
 * `/chaintracks/v2/tip/stream`, into the local Chaintracks live-ingestor API.
 */
export class LiveIngestorChaintracksSSE extends LiveIngestorBase {
  static createLiveIngestorChaintracksSSEOptions (
    chain: Chain,
    chaintracks: ChaintracksClientApi
  ): LiveIngestorChaintracksSSEOptions {
    return {
      ...LiveIngestorBase.createLiveIngestorBaseOptions(chain),
      chaintracks
    }
  }

  private subscriptionId?: string
  private stopped = false
  private resolveStopped?: () => void

  constructor (private readonly options: LiveIngestorChaintracksSSEOptions) {
    super(options)
  }

  async getHeaderByHash (hash: string): Promise<BlockHeader | undefined> {
    return await this.options.chaintracks.findHeaderForBlockHash(hash)
  }

  async startListening (liveHeaders: BlockHeader[]): Promise<void> {
    this.stopped = false
    this.subscriptionId = await this.options.chaintracks.subscribeHeaders(header => {
      if (!this.stopped) liveHeaders.push(header)
    })
    await new Promise<void>(resolve => {
      this.resolveStopped = resolve
      if (this.stopped) resolve()
    })
  }

  stopListening (): void {
    this.stopped = true
    const subscriptionId = this.subscriptionId
    this.subscriptionId = undefined
    if (subscriptionId != null) {
      this.options.chaintracks.unsubscribe(subscriptionId).catch(e => {
        this.log(`LiveIngestorChaintracksSSE unsubscribe failed: ${e}`)
      })
    }
    this.resolveStopped?.()
  }

  override async shutdown (): Promise<void> {
    this.stopListening()
  }
}
