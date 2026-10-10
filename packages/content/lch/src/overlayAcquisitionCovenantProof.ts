import { outputHex32 } from '@bsv/sdk'
import { lchAssert } from './errors.js'

/** Returned only after the installed domain has executed complete purchase
 * verification. A packet digest or a seller's claimed value is insufficient.
 */
export interface LCHOverlayVerifiedCovenantPurchase {
  purchaseCommitment: string
  checkCurrent(): void
}

/** Snapshot the complete digest and pin the installed synchronous assessment.
 * This boundary validates a local verifier's result; it does not execute Script.
 */
export function retainLCHCovenantPurchaseAssessment(
  input: LCHOverlayVerifiedCovenantPurchase
): LCHOverlayVerifiedCovenantPurchase {
  const commitment = Object.getOwnPropertyDescriptor(input, 'purchaseCommitment'),
    guard = Object.getOwnPropertyDescriptor(input, 'checkCurrent')?.value as unknown
  lchAssert(
    commitment?.enumerable && 'value' in commitment,
    'ERR_LCH_PAYMENT',
    'Verified purchase commitment must be an owned data field'
  )
  const purchaseCommitment = outputHex32(commitment.value)
  lchAssert(
    typeof guard === 'function' && guard.constructor.name !== 'AsyncFunction',
    'ERR_LCH_LICENSE',
    'Purchase verification guard must be synchronous'
  )
  return {
    purchaseCommitment,
    checkCurrent: () => {
      const result: unknown = guard.call(input)
      if (result instanceof Promise) void result.catch(() => undefined)
      lchAssert(
        result === undefined &&
          Object.getOwnPropertyDescriptor(input, 'checkCurrent')?.value === guard &&
          Object.getOwnPropertyDescriptor(input, 'purchaseCommitment')?.value ===
            purchaseCommitment,
        'ERR_LCH_LICENSE',
        'Purchase verification guard or commitment changed or did not finish'
      )
    }
  }
}
