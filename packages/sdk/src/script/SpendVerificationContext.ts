/**
 * Explicit chain context for script verification.
 *
 * Transaction version is script data, not a reliable signal for whether a
 * caller is asking for consensus or policy validation. Backends should use
 * this context when it is supplied and retain their compatibility behavior
 * only when it is omitted.
 */
export default interface SpendVerificationContext {
  /** `true` selects consensus rules; `false` permits policy validation. */
  consensus: boolean
  /** Height of the block against which the spend is evaluated. */
  blockHeight?: number
  /** Height at which the source output was mined. */
  utxoHeight?: number
  /** Optional backend-specific script verification flags. */
  verifyFlags?: string | string[]
}
