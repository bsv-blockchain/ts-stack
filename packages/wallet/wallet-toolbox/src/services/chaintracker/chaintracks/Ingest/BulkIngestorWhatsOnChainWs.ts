import { Chain } from '../../../../sdk'
import { BlockHeader } from '../Api/BlockHeaderApi'
import { BulkIngestorBase } from './BulkIngestorBase'
import { HeightRange, HeightRanges } from '../util/HeightRange'
import { BulkIngestorWhatsOnChainOptions } from './BulkIngestorWhatsOnChainCdn'
import { StopListenerToken, WocHeadersBulkListener } from './WhatsOnChainIngestorWs'
import { EnqueueHandler, ErrorHandler, WhatsOnChainServices } from './WhatsOnChainServices'
import { safeDiagnostic } from '../util/safeDiagnostic'

export class BulkIngestorWhatsOnChainWs extends BulkIngestorBase {
  /**
   *
   * @param chain
   * @param localCachePath defaults to './data/ingest_whatsonchain_headers'
   * @returns
   */
  static createBulkIngestorWhatsOnChainOptions(chain: Chain): BulkIngestorWhatsOnChainOptions {
    const options: BulkIngestorWhatsOnChainOptions = {
      ...WhatsOnChainServices.createWhatsOnChainServicesOptions(chain),
      ...BulkIngestorBase.createBulkIngestorBaseOptions(chain),
      idleWait: 5000
    }
    return options
  }

  idleWait: number
  maxHeadersPerRequest: number
  woc: WhatsOnChainServices
  stopOldListenersToken: StopListenerToken = { stop: undefined }

  constructor(options: BulkIngestorWhatsOnChainOptions) {
    super(options)
    this.idleWait = options.idleWait ?? 5000
    this.maxHeadersPerRequest = options.maxHeadersPerRequest ?? 10000
    if (!Number.isSafeInteger(this.idleWait) || this.idleWait < 1 || this.idleWait > 60 * 60 * 1000) {
      throw new Error('idleWait must be a positive safe integer no greater than 3600000.')
    }
    if (
      !Number.isSafeInteger(this.maxHeadersPerRequest) ||
      this.maxHeadersPerRequest < 1 ||
      this.maxHeadersPerRequest > 100000
    ) {
      throw new Error('maxHeadersPerRequest must be a positive safe integer no greater than 100000.')
    }
    this.woc = new WhatsOnChainServices(options)
  }

  override async getPresentHeight(): Promise<number | undefined> {
    const presentHeight = await this.woc.getChainTipHeight()
    this.log(`presentHeight=${presentHeight}`)
    return presentHeight
  }

  async fetchHeaders(
    before: HeightRanges,
    fetchRange: HeightRange,
    bulkRange: HeightRange,
    priorLiveHeaders: BlockHeader[]
  ): Promise<BlockHeader[]> {
    let liveHeaders = priorLiveHeaders
    for (let fromHeight = fetchRange.minHeight; fromHeight <= fetchRange.maxHeight;) {
      const toHeight = Math.min(fetchRange.maxHeight, fromHeight + this.maxHeadersPerRequest - 1)
      const oldHeaders: BlockHeader[] = []
      const errors: Array<{ code: number; message: string; count: number }> = []
      const enqueue: EnqueueHandler = header => oldHeaders.push({ ...header })
      const error: ErrorHandler = (code, message) => {
        errors.push({ code, message, count: errors.length })
        return false
      }

      const ok = await WocHeadersBulkListener(
        fromHeight,
        toHeight,
        enqueue,
        error,
        this.stopOldListenersToken,
        this.chain,
        this.log,
        this.idleWait
      )

      if (!ok || errors.length > 0) {
        const errorMessages = errors
          .slice(0, 16)
          .map(e => `(${e.code}) ${this.safeProviderMessage(e.message)} (${e.count})`)
          .join('\n')
        this.log(`Errors during WhatsOnChain ingestion:\n${errorMessages || 'listener stopped before completion'}`)
        return liveHeaders
      }
      if (oldHeaders.length !== toHeight - fromHeight + 1) {
        throw new Error(`WhatsOnChain returned ${oldHeaders.length} headers for range ${fromHeight}-${toHeight}.`)
      }
      liveHeaders = await this.storage().addBulkHeaders(oldHeaders, bulkRange, liveHeaders)
      fromHeight = toHeight + 1
    }

    return liveHeaders
  }

  private safeProviderMessage(message: unknown): string {
    return safeDiagnostic(message)
  }
}
