import { Beef } from '@bsv/sdk'
import type { ValidCreateActionArgs } from '@bsv/sdk/wallet/validationHelpers'
import type { StorageCreateActionResult, TrxToken } from '../../sdk/WalletStorage.interfaces'
import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
import type { StorageProvider } from '../StorageProvider'
import { hasBrc177NoSendExpiryLabel } from '../../utility/brc177NoSendExpiry'

/** Public derivation descriptors and evidence only; never private signing material. */
export interface ActionRecoveryPlan {
  result: StorageCreateActionResult
  /** Exact allocated wallet funding roots; proof completion may not select new inputs. */
  fundingTxids: string[]
}

export interface RetainedActionRecoveryPlan {
  plan: ActionRecoveryPlan
  /** The first completed result is immutable, including its original evidence bytes. */
  completed?: StorageCreateActionResult
}

/**
 * Explicit local capability bound to one authenticated wallet, operation and
 * immutable request. Claim and retain MUST share the allocation transaction.
 * No BRC-100 wire method or automatic storage-provider capability is implied.
 */
export interface ActionRecoveryConstruction {
  readonly protocol: 'wallet-action-recovery-v1'
  read(): Promise<RetainedActionRecoveryPlan | undefined>
  /** Return an existing plan, or claim the operation within this transaction. */
  claim(trx: TrxToken): Promise<RetainedActionRecoveryPlan | undefined>
  retain(plan: ActionRecoveryPlan, trx: TrxToken): Promise<void>
  /** Compare-and-set the first complete result; a retry returns those same bytes. */
  complete(result: StorageCreateActionResult): Promise<StorageCreateActionResult>
}

export function validateRecoveryConstruction(args: ValidCreateActionArgs): void {
  if (
    !args.isNewTx || !args.isSignAction || !args.isNoSend || args.isSendWith ||
    args.options.signAndProcess !== false || args.options.randomizeOutputs !== false ||
    args.options.returnTXIDOnly || args.options.sendWith.length > 0 ||
    (args.options.knownTxids?.length ?? 0) > 0 || args.options.trustSelf != null ||
    hasBrc177NoSendExpiryLabel(args.labels)
  ) {
    throw new WERR_INVALID_OPERATION('Action recovery requires full-evidence, fixed-layout, two-phase noSend construction')
  }
}

/** Finish only the saved evidence, without re-running funding selection or claims. */
export async function resumeActionRecoveryPlan(
  storage: StorageProvider,
  recovery: ActionRecoveryConstruction,
  retained: RetainedActionRecoveryPlan
): Promise<StorageCreateActionResult> {
  if (retained.completed != null) return retained.completed
  const { result, fundingTxids } = retained.plan
  if (result.inputBeef == null) throw new WERR_INVALID_OPERATION('Retained action evidence is missing')
  const beef = Beef.fromBinaryStrict(result.inputBeef)
  if (fundingTxids.length > 0) {
    const funding = await storage.getBeefForTransactions(fundingTxids, {
      trustSelf: undefined,
      knownTxids: [],
      ignoreStorage: false,
      ignoreServices: true,
      ignoreNewProven: false
    })
    beef.mergeBeef(funding)
  }
  return await recovery.complete({ ...result, inputBeef: Uint8Array.from(beef.toBinary()) })
}
