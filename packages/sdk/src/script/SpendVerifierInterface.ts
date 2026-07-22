import type Spend from './Spend.js'

/**
 * An asynchronous backend capable of validating a single Spend-shaped input.
 * Implementations may use native code or WebAssembly while the existing
 * synchronous {@link Spend.validate} interpreter remains unchanged.
 */
export default interface SpendVerifierInterface {
  verifySpend: (spend: Spend) => Promise<boolean>
}
