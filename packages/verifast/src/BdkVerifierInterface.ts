import type { Transaction } from '@bsv/sdk'

/**
 * Local structural copy of `@bsv/sdk`'s `BdkVerifierInterface`.
 *
 * The published `@bsv/sdk` pinned by the monorepo (2.1.3) predates the interface's
 * addition, so it cannot be imported at build time. This copy is structurally
 * identical; `BdkVerifier implements` it, and it stays assignable to the SDK type
 * once a version exporting `BdkVerifierInterface` is published.
 */
export default interface BdkVerifierInterface {
  verifyScripts: (params: {
    tx: Transaction
    blockHeight: number
    consensus: boolean
    verifyFlags?: string | string[]
  }) => Promise<boolean>
}
