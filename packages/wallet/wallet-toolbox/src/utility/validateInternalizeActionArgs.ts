import type { InternalizeActionArgs } from '@bsv/sdk'
import {
  type ValidInternalizeActionArgs,
  validateInternalizeActionArgs as validateSdkInternalizeActionArgs
} from '@bsv/sdk/wallet/validationHelpers'
import { canonicalizeAtomicBeef } from './canonicalizeAtomicBeef'

const atomicFramingError = 'The tx parameter must be a complete, exactly framed Atomic BEEF transaction'

/** Validate ordinary internalization while retaining the legacy subject-closure normalization. */
export function validateInternalizeActionArgs(args: InternalizeActionArgs): ValidInternalizeActionArgs {
  try {
    return validateSdkInternalizeActionArgs(args)
  } catch (error) {
    // The SDK first validates byte/argument shapes. Only its exact Atomic
    // framing failure is eligible for the existing strict BEEF normalization;
    // other argument errors retain their original identity and ordering.
    if (
      !(error instanceof Error) ||
      !('parameter' in error) ||
      error.parameter !== 'tx' ||
      error.message !== atomicFramingError
    ) {
      throw error
    }
    try {
      const canonical = canonicalizeAtomicBeef(args.tx)
      const txid = canonical.atomicTxid
      if (txid == null || canonical.findTxid(txid)?.tx == null) throw error
      // Exact decoding rejects truncation/trailing bytes before pruning. The
      // SDK must then accept the complete declared subject and its dependencies.
      // Normal proof, Script, ownership and receipt validation still follow.
      return validateSdkInternalizeActionArgs({ ...args, tx: canonical.toBinaryAtomic(txid) })
    } catch {
      throw error
    }
  }
}
