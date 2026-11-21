import { type ValidCreateActionArgs } from '@bsv/sdk/wallet/validationHelpers'
import type { XValidCreateActionInput } from '../storage/methods/createAction'

/**
 * Validated `createAction` arguments as the Wallet hands them to storage.
 *
 * `isAdminOriginator` is set by `Wallet.createAction` and only there: it is
 * true when the call's originator equals the originator the host gave
 * `Wallet.setAdminOriginator`. It is never read from caller-supplied action
 * fields, so an application cannot claim it.
 */
export type AdminValidCreateActionArgs = ValidCreateActionArgs & {
  isAdminOriginator?: boolean
}

/** True only for an action the Wallet authorized as its admin originator's. */
export function isAdminOriginatorAction(vargs: ValidCreateActionArgs): boolean {
  return (vargs as AdminValidCreateActionArgs).isAdminOriginator === true
}

/**
 * Optional host policy for each `createAction` input.
 *
 * Storage calls it after the input's source output is resolved, from
 * authenticated local storage (`input.output` is then set) or from verified
 * BEEF, so a caller cannot misstate the source locking script to pass a rule.
 * Throw to refuse the action. A host uses it, for example, to let only its
 * admin originator spend outputs that hold its own admin state.
 */
export type ValidateResolvedActionInput = (
  vargs: AdminValidCreateActionArgs,
  input: XValidCreateActionInput
) => Promise<void>
