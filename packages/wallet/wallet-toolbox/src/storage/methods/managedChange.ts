import { TableOutput } from '../schema/tables/TableOutput'

/**
 * Fields that identify an output as wallet-managed BRC-29 change.
 *
 * `type: 'P2PKH'` is historical terminology. In this storage model it does
 * not merely describe the locking script. It selects the wallet's BRC-29
 * unlocking path, so the accompanying derivation fields are also required.
 */
export const managedChangeOutputFields = {
  type: 'P2PKH',
  change: true,
  providedBy: 'storage',
  purpose: 'change'
} as const

function isNonEmptyString (value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * True when an output has all metadata required to use the wallet-managed
 * BRC-29 signing path. `senderIdentityKey` is optional: wallet-created change
 * uses the client's change public key when it is absent, while received
 * BRC-29 payments record the sender's identity key.
 */
export function isManagedChangeOutput (output: TableOutput | undefined): output is TableOutput {
  return output?.type === managedChangeOutputFields.type &&
    output.change === managedChangeOutputFields.change &&
    output.providedBy === managedChangeOutputFields.providedBy &&
    output.purpose === managedChangeOutputFields.purpose &&
    isNonEmptyString(output.derivationPrefix) &&
    isNonEmptyString(output.derivationSuffix)
}

/**
 * True when managed change is currently eligible for automatic allocation.
 */
export function isAutoSpendableChangeOutput (output: TableOutput | undefined): output is TableOutput {
  return isManagedChangeOutput(output) && output.spendable && output.spentBy == null
}
