import type Transaction from './Transaction.js'

/** Parameters shared by script-verifier routing and execution. */
export interface BdkVerifyScriptsParams {
  tx: Transaction
  blockHeight: number
  consensus: boolean
  verifyFlags?: string | string[]
  memoryLimit?: number
}

/**
 * A pluggable backend that verifies ALL input scripts of a single transaction.
 *
 * Implementations (e.g. @bsv/verifast's BdkVerifier) typically delegate to a
 * native/WASM engine. The backend operates at whole-transaction granularity,
 * not per input.
 */
export default interface BdkVerifierInterface {
  /**
   * True only when this backend applies `params.memoryLimit` during script
   * execution. Backends that omit this capability are bypassed for calls with
   * an explicit memory limit.
   */
  supportsMemoryLimit?: boolean

  /**
   * Optionally decide whether this backend should handle the transaction now.
   * Returning false preserves the SDK's synchronous JavaScript interpreter path.
   * Implementations can use this to avoid waiting for a cold optional backend.
   */
  shouldVerifyScripts?: (params: BdkVerifyScriptsParams) => boolean

  /**
   * Verify all input scripts of `params.tx`.
   * @returns Promise resolving true if every input script is valid, false otherwise.
   * @throws If the backend itself fails (load error, marshalling error, unavailable).
   */
  verifyScripts: (params: BdkVerifyScriptsParams) => Promise<boolean>

  /**
   * Verify several independent transactions in one backend scheduling pass.
   * Implementations may use packed native calls and worker-level parallelism.
   */
  verifyScriptsBatch?: (
    params: readonly BdkVerifyScriptsParams[]
  ) => Promise<boolean[]>
}
