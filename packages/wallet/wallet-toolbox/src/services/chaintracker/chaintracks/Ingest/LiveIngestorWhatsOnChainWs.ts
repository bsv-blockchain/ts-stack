import { BlockHeader, Chain } from '../../../../sdk'
import { LiveIngestorBase } from './LiveIngestorBase'
import { LiveIngestorWhatsOnChainOptions } from './LiveIngestorWhatsOnChainPoll'
import { StopListenerToken, WocHeadersLiveListener } from './WhatsOnChainIngestorWs'
import { EnqueueHandler, ErrorHandler, WhatsOnChainServices } from './WhatsOnChainServices'
import { wait } from '../../../../utility/utilityHelpers'
import { safeDiagnostic } from '../util/safeDiagnostic'

export class LiveIngestorWhatsOnChainWs extends LiveIngestorBase {
  static createLiveIngestorWhatsOnChainOptions(chain: Chain): LiveIngestorWhatsOnChainOptions {
    const options: LiveIngestorWhatsOnChainOptions = {
      ...WhatsOnChainServices.createWhatsOnChainServicesOptions(chain),
      ...LiveIngestorBase.createLiveIngestorBaseOptions(chain),
      idleWait: 100000
    }
    return options
  }

  idleWait: number
  retryWait: number
  retryWaitMax: number
  maxQueuedHeaders: number
  woc: WhatsOnChainServices
  stopNewListenersToken: StopListenerToken = { stop: undefined }
  done = false

  constructor(options: LiveIngestorWhatsOnChainOptions) {
    super(options)
    this.idleWait = options.idleWait ?? 100000
    this.retryWait = options.retryWait ?? 5000
    this.retryWaitMax = options.retryWaitMax ?? 120000
    this.maxQueuedHeaders = options.maxQueuedHeaders ?? 4096
    this.validatePositiveOption(this.idleWait, 'idleWait', 60 * 60 * 1000)
    this.validatePositiveOption(this.retryWait, 'retryWait', 60 * 60 * 1000)
    this.validatePositiveOption(this.retryWaitMax, 'retryWaitMax', 24 * 60 * 60 * 1000)
    this.validatePositiveOption(this.maxQueuedHeaders, 'maxQueuedHeaders', 100000)
    this.woc = new WhatsOnChainServices(options)
  }

  async getHeaderByHash(hash: string): Promise<BlockHeader | undefined> {
    const header = await this.woc.getHeaderByHash(hash)
    return header
  }

  async startListening(liveHeaders: BlockHeader[]): Promise<void> {
    this.done = false
    const errors: Array<{ code: number; message: string; count: number }> = []
    const enqueue: EnqueueHandler = header => {
      if (liveHeaders.some(existing => existing.hash === header.hash)) return
      if (liveHeaders.length >= this.maxQueuedHeaders) {
        this.log(`LiveIngestorWhatsOnChainWs queue capacity ${this.maxQueuedHeaders} reached; dropping ${header.hash}`)
        return
      }
      liveHeaders.push({ ...header })
    }
    const error: ErrorHandler = (code, message) => {
      if (errors.length < 16) errors.push({ code, message: this.safeProviderMessage(message), count: errors.length })
      return false
    }

    let failureCount = 0
    while (!this.done) {
      const ok = await WocHeadersLiveListener(
        enqueue,
        error,
        this.stopNewListenersToken,
        this.chain,
        this.log,
        this.idleWait
      )

      if (!ok || errors.length > 0) {
        this.log(`WhatsOnChain live ingestor ok=${ok} error count=${errors.length}`)
        for (const e of errors) this.log(`WhatsOnChain error code=${e.code} count=${e.count} message=${e.message}`)
      }

      if (ok || this.done) break

      errors.length = 0
      failureCount++
      await this.waitUnlessStopped(Math.min(this.retryWait * 2 ** Math.min(failureCount - 1, 4), this.retryWaitMax))
    }
  }

  stopListening(): void {
    this.done = true
    this.stopNewListenersToken.stop?.()
  }

  override async shutdown(): Promise<void> {
    this.stopListening()
  }

  private validatePositiveOption(value: number, name: string, maximum: number): void {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new Error(`${name} must be a positive safe integer no greater than ${maximum}`)
    }
  }

  private async waitUnlessStopped(msecs: number): Promise<void> {
    let remaining = msecs
    while (remaining > 0 && !this.done) {
      const chunk = Math.min(1000, remaining)
      await wait(chunk)
      remaining -= chunk
    }
  }

  private safeProviderMessage(message: unknown): string {
    return safeDiagnostic(message)
  }
}
