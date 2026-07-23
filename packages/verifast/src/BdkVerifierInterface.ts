import type { Transaction } from '@bsv/sdk'

export interface BdkVerifyScriptsParams {
  tx: Transaction
  blockHeight: number
  consensus: boolean
  verifyFlags?: string | string[]
  memoryLimit?: number
}

/**
 * Local structural copy of `@bsv/sdk`'s `BdkVerifierInterface`.
 *
 * Kept structurally identical to the SDK contract so the optional verifier
 * package does not create a runtime dependency edge back into SDK internals.
 */
export default interface BdkVerifierInterface {
  shouldVerifyScripts?: (params: BdkVerifyScriptsParams) => boolean
  verifyScripts: (params: BdkVerifyScriptsParams) => Promise<boolean>
}
