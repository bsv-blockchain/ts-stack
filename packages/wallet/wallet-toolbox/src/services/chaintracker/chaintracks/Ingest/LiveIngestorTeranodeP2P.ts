import { BlockHeader, Chain } from '../../../../sdk'
import { LiveIngestorBase, LiveIngestorBaseOptions } from './LiveIngestorBase'


export interface LiveIngestorTeranodeP2POptions extends LiveIngestorBaseOptions {
  /**
   *
   */
  apiKey?: string
  /**
   * User-Agent header value for requests
   */
  userAgent?: string
}

export class LiveIngestorTeranodeP2P extends LiveIngestorBase {
  static createLiveIngestorTeranodeP2POptions (chain: Chain): LiveIngestorTeranodeP2POptions {
    const options: LiveIngestorTeranodeP2POptions = {
      ...LiveIngestorBase.createLiveIngestorBaseOptions(chain)
    }
    return options
  }

  constructor (options: LiveIngestorTeranodeP2POptions) {
    super(options)
  }

  async getHeaderByHash (hash: string): Promise<BlockHeader | undefined> {
    return undefined
  }

  async startListening (liveHeaders: BlockHeader[]): Promise<void> {
    const errors: Array<{ code: number, message: string, count: number }> = []

    for (;;) {
      const ok = true // await this.woc.listenForNewBlockHeaders(enqueue, error, this.idleWait)

      if (!ok || errors.length > 0) {
        console.log(`TeranodeP2P live ingestor ok=${ok} error count=${errors.length}`)
        for (const e of errors) console.log(`TeranodeP2P error code=${e.code} count=${e.count} message=${e.message}`)
      }

      if (ok) break

      errors.length = 0
    }
  }

  stopListening (): void {
    // this.woc?.stopNewListener()
  }
}
