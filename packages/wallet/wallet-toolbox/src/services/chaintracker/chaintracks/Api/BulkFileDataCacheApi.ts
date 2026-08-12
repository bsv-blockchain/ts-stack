import type { BulkHeaderFileInfo } from '../util/BulkHeaderFile'

/**
 * Persistent backing cache for immutable bulk-header objects.
 *
 * Implementations may read packaged checkpoint assets, application storage,
 * or a filesystem. The manager validates the byte length and SHA-256 digest
 * before using any returned value or persisting a downloaded value.
 *
 * @public
 */
export interface BulkFileDataCacheApi {
  get(file: Readonly<BulkHeaderFileInfo>): Promise<Uint8Array | undefined>
  set(file: Readonly<BulkHeaderFileInfo>, data: Uint8Array): Promise<void>
  /**
   * Preserve a rejected object outside the active cache namespace. The manager
   * calls this before attempting a replacement and never removes a last-good
   * object merely because a newer source is unavailable.
   */
  quarantine?(
    file: Readonly<BulkHeaderFileInfo>,
    reason: string,
    /** Exact rejected bytes, used to avoid quarantining a concurrent replacement. */
    rejectedData?: Uint8Array
  ): Promise<void>
  /**
   * Promote a validated legacy entry into the implementation's preferred
   * immutable namespace. Implementations should make this idempotent.
   */
  promoteValidated?(file: Readonly<BulkHeaderFileInfo>, data: Uint8Array): Promise<void>
  delete?(file: Readonly<BulkHeaderFileInfo>): Promise<void>
}

/**
 * A deployment-defined budget for remote bulk-header downloads.
 * Implementations should throw before the request when the requested byte
 * reservation would exceed the configured budget.
 *
 * @public
 */
export interface BulkFileDownloadBudgetApi {
  consume(byteCount: number): void | Promise<void>
  snapshot?(): BulkFileDownloadBudgetSnapshot
}

/** @public */
export interface BulkFileDownloadBudgetSnapshot {
  maxBytes: number
  consumedBytes: number
  remainingBytes: number
  windowStartedAt: number
  windowMsecs: number
}
