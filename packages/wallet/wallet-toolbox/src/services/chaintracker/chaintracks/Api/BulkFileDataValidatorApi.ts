import type { Chain } from '../../../../sdk/types'

/**
 * Identifies deterministic rejection of the supplied immutable bytes.
 * Operational failures such as worker crashes and queue saturation deliberately
 * use ordinary errors so callers preserve the cache entry and avoid downloading
 * a replacement that cannot be validated.
 *
 * @public
 */
export class BulkFileDataValidationError extends Error {
  constructor(
    message: string,
    public readonly data?: Uint8Array
  ) {
    super(message)
    this.name = 'BulkFileDataValidationError'
  }
}

/**
 * Complete immutable bulk-header object supplied to a validator.
 *
 * Implementations must validate the exact byte length and digest as well as
 * every header's linkage, chain work, genesis, and proof of work.
 *
 * @public
 */
export interface BulkFileDataValidationRequest {
  fileName: string
  data: Uint8Array
  count: number
  /** Expected base64 SHA-256 digest. Omit only while producing a new export. */
  fileHash?: string
  firstHeight: number
  prevHash: string
  prevChainWork: string
  lastHash?: string | null
  lastChainWork?: string | null
  chain?: Chain
}

/** @public */
export interface BulkFileDataValidationResult {
  /** The validated bytes. Worker implementations may transfer ownership. */
  data: Uint8Array
  fileHash: string
  lastHeaderHash: string
  lastChainWork: string
}

/** @public */
export interface BulkFileDataValidatorStats {
  submitted: number
  completed: number
  failed: number
  rejected: number
  workerRestarts: number
  inFlight: number
  queued: number
  maxQueueDepth: number
  totalValidationMsecs: number
  maxValidationMsecs: number
}

/**
 * Asynchronous validation boundary for immutable bulk-header objects.
 *
 * Portable runtimes may validate in-process. Node services can inject a
 * worker-backed implementation so proof-of-work validation never blocks the
 * request event loop.
 *
 * @public
 */
export interface BulkFileDataValidatorApi {
  validate(request: BulkFileDataValidationRequest): Promise<BulkFileDataValidationResult>
  getStats?(): BulkFileDataValidatorStats
  destroy?(): Promise<void>
}
