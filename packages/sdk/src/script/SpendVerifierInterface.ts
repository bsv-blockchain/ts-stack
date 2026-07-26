import type Spend from './Spend.js'
import type SpendVerificationContext from './SpendVerificationContext.js'

/**
 * An asynchronous backend capable of validating a single Spend-shaped input.
 * Implementations may use native code or WebAssembly while the existing
 * synchronous {@link Spend.validate} interpreter remains unchanged.
 *
 * The optional {@link SpendVerificationContext} is authoritative when present.
 * Backends must not infer policy versus consensus validation from transaction
 * version.
 */
export default interface SpendVerifierInterface {
  /** Optional synchronous readiness signal for compatibility APIs. */
  isReady?: () => boolean

  /**
   * Optionally decide whether this backend should handle the Spend now.
   * Returning false preserves the existing synchronous JavaScript validator.
   */
  shouldVerifySpend?: (
    spend: Spend,
    context?: SpendVerificationContext
  ) => boolean

  verifySpend: (
    spend: Spend,
    context?: SpendVerificationContext
  ) => Promise<boolean>

  /**
   * Optional warm-only synchronous lane used by {@link Spend.validate}. It must
   * return an authoritative verdict and must never initiate asynchronous work.
   */
  verifySpendSync?: (
    spend: Spend,
    context?: SpendVerificationContext
  ) => boolean
}
