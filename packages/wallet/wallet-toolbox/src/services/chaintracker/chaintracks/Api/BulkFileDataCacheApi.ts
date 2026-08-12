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
}
