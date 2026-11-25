import type { BroadcastFailure, BroadcastResponse } from '@bsv/sdk'

export class AppCatalogBroadcastError extends Error {
  readonly code: string
  readonly txid?: string
  readonly details?: object

  constructor (failure: BroadcastFailure) {
    super(failure.description)
    this.name = 'AppCatalogBroadcastError'
    this.code = failure.code
    this.txid = failure.txid
    this.details = failure.more
  }
}

/**
 * Convert the SDK's resolved failure object into a thrown error so callers
 * cannot accidentally present a failed overlay submission as successful.
 */
export function requireAppCatalogBroadcastSuccess (
  result: BroadcastResponse | BroadcastFailure
): BroadcastResponse {
  if (result.status === 'error') throw new AppCatalogBroadcastError(result)
  return result
}
