import type { BdkVerifierInterface, DigestVerification, SpendVerifierInterface } from '@bsv/sdk'

/** Optional digest acceleration for the wallet's exact canonical P2PKH lane. */
export interface WalletDigestBatchVerifier {
  isReady?: () => boolean
  supportsCrypto?: (operation: 'verifyDigestBatch') => boolean
  verifyDigestBatch: (items: readonly DigestVerification[]) => Promise<boolean[]>
}

/**
 * A wallet verifier can implement per-input verification, whole-transaction
 * verification, or both. Digest acceleration is optional. Whole-only backends
 * retain the JavaScript interpreter for per-input fallback and diagnostics.
 */
export type WalletScriptVerifier = (SpendVerifierInterface | BdkVerifierInterface) &
  Partial<SpendVerifierInterface & BdkVerifierInterface & WalletDigestBatchVerifier>
