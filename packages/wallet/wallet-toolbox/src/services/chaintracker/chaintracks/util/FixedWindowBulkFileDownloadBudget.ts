import { WERR_INVALID_PARAMETER } from '../../../../sdk'
import type { BulkFileDownloadBudgetApi } from '../Api/BulkFileDataCacheApi'

export interface FixedWindowBulkFileDownloadBudgetOptions {
  maxBytes: number
  windowMsecs?: number
  now?: () => number
}

/**
 * Conservative process-local byte reservation budget for remote bulk-header
 * downloads. A reservation is retained even when the subsequent request
 * fails, preventing a failing upstream from bypassing the bound.
 *
 * @public
 */
export class FixedWindowBulkFileDownloadBudget implements BulkFileDownloadBudgetApi {
  private readonly maxBytes: number
  private readonly windowMsecs: number
  private readonly now: () => number
  private windowStartedAt: number
  private consumedBytes = 0

  constructor(options: FixedWindowBulkFileDownloadBudgetOptions) {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
      throw new WERR_INVALID_PARAMETER('maxBytes', 'a positive safe integer')
    }
    const windowMsecs = options.windowMsecs ?? 60 * 60 * 1000
    if (!Number.isSafeInteger(windowMsecs) || windowMsecs < 1) {
      throw new WERR_INVALID_PARAMETER('windowMsecs', 'a positive safe integer')
    }
    this.maxBytes = options.maxBytes
    this.windowMsecs = windowMsecs
    this.now = options.now ?? Date.now
    this.windowStartedAt = this.now()
  }

  consume(byteCount: number): void {
    if (!Number.isSafeInteger(byteCount) || byteCount < 1) {
      throw new WERR_INVALID_PARAMETER('byteCount', 'a positive safe integer')
    }
    const now = this.now()
    if (now - this.windowStartedAt >= this.windowMsecs) {
      this.windowStartedAt = now
      this.consumedBytes = 0
    }
    if (this.consumedBytes + byteCount > this.maxBytes) {
      throw new Error(
        `Bulk-header download budget exceeded: requested ${byteCount} bytes with ` +
          `${this.maxBytes - this.consumedBytes} bytes remaining in the current window.`
      )
    }
    this.consumedBytes += byteCount
  }

  snapshot(): {
    maxBytes: number
    consumedBytes: number
    remainingBytes: number
    windowStartedAt: number
    windowMsecs: number
  } {
    return {
      maxBytes: this.maxBytes,
      consumedBytes: this.consumedBytes,
      remainingBytes: this.maxBytes - this.consumedBytes,
      windowStartedAt: this.windowStartedAt,
      windowMsecs: this.windowMsecs
    }
  }
}
