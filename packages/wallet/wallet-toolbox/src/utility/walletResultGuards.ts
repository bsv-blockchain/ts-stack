import { WERR_INTERNAL } from '../sdk/WERR_errors'

/** Reject runtime-negative or malformed results from local or remote wallet storage. */
export function assertInternalizeAccepted(result: { accepted?: unknown; isMerge?: unknown }): void {
  if (result.accepted !== true) {
    throw new WERR_INTERNAL('Wallet storage did not affirmatively accept the internalized action.')
  }
  if (result.isMerge !== undefined && typeof result.isMerge !== 'boolean') {
    throw new WERR_INTERNAL('Wallet storage returned an invalid internalization merge verdict.')
  }
}

/** Require a unique storage row to have been changed before reporting public success. */
export function assertStorageMutationSucceeded(result: unknown, operation: string): void {
  if (result !== 1) {
    throw new WERR_INTERNAL(`Wallet storage did not affirmatively complete ${operation}.`)
  }
}

/** Preserve a legitimate abort refusal while rejecting malformed remote storage results. */
export function assertAbortResult(result: { aborted?: unknown }): asserts result is { aborted: boolean } {
  if (typeof result.aborted !== 'boolean') {
    throw new WERR_INTERNAL('Wallet storage returned an invalid action-abort verdict.')
  }
}
