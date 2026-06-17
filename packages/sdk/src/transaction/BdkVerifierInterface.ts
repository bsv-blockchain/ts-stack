import type Transaction from './Transaction.js'

/**
 * A pluggable backend that verifies ALL input scripts of a single transaction.
 *
 * Implementations (e.g. @bsv/verifast's BdkVerifier) typically delegate to a
 * native/WASM engine. The backend operates at whole-transaction granularity,
 * not per input.
 */
export default interface BdkVerifierInterface {
  /**
   * Verify all input scripts of `params.tx`.
   * @returns Promise resolving true if every input script is valid, false otherwise.
   * @throws If the backend itself fails (load error, marshalling error, unavailable).
   */
  verifyScripts: (params: {
    tx: Transaction
    blockHeight: number
    consensus: boolean
    verifyFlags?: string | string[]
  }) => Promise<boolean>
}
