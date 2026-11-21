import type { TransactionMergeRow } from '../schema/entities/EntityTransaction'
import type { OutputMergeRow } from '../schema/entities/EntityOutput'
import type { WalletSnapshotFieldDescriptor } from './WalletReadSnapshot'

export type SnapshotSyncActionCell = string | Readonly<WalletSnapshotFieldDescriptor>
export type SnapshotSyncTransactionRow = TransactionMergeRow<
  Readonly<WalletSnapshotFieldDescriptor>,
  SnapshotSyncActionCell
>
export type SnapshotSyncOutputRow = OutputMergeRow<Readonly<WalletSnapshotFieldDescriptor>, SnapshotSyncActionCell>
type Extents = Readonly<Record<string, Readonly<WalletSnapshotFieldDescriptor>>>
function invalid(): never {
  throw new Error('Snapshot action metadata is incomplete or differs from its table contract')
}
function date(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(Date.prototype.getTime.call(value))) invalid()
  return new Date(Date.prototype.getTime.call(value))
}
function number(value: unknown, optional = false): number | undefined {
  if (optional && value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid()
  return value
}
function id(value: unknown, optional = false): number | undefined {
  const result = number(value, optional)
  if (result !== undefined && (!Number.isSafeInteger(result) || result < 1)) invalid()
  return result
}
function archiveId(value: unknown, optional = false): number | undefined {
  const result = number(value, optional)
  if (result !== undefined && !Number.isInteger(result)) invalid()
  return result
}
function text(value: unknown, optional = false): string | undefined {
  if (optional && value === undefined) return undefined
  if (typeof value !== 'string' || value.length > 4096) invalid()
  return value
}
function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid()
  return value
}
function choice<const T extends readonly string[]>(
  value: unknown,
  choices: T,
  optional = false
): T[number] | undefined {
  if (optional && value === undefined) return undefined
  if (typeof value !== 'string' || !choices.includes(value)) invalid()
  return value as T[number]
}
function cell(
  fields: Readonly<Record<string, unknown>>,
  extents: Extents,
  name: string,
  optional = false
): SnapshotSyncActionCell | undefined {
  const extent = extents[name]
  if (extent !== undefined) {
    if (extent.kind === 'binary' || fields[name] !== undefined) invalid()
    return extent
  }
  return text(fields[name], optional)
}
function binary(
  fields: Readonly<Record<string, unknown>>,
  extents: Extents,
  name: string
): Readonly<WalletSnapshotFieldDescriptor> | undefined {
  const extent = extents[name]
  if (extent !== undefined) {
    if (extent.kind !== 'binary' || fields[name] !== undefined) invalid()
    return extent
  }
  if (fields[name] !== undefined) invalid()
  return undefined
}
export const transactionPayloadFields = Object.freeze([
  'rawTx',
  'inputBEEF',
  'noSendExpiryReclaimRawTx',
  'description',
  'noSendExpiryReclaimDerivationPrefix',
  'noSendExpiryReclaimDerivationSuffix'
] as const)
export const outputPayloadFields = Object.freeze([
  'lockingScript',
  'outputDescription',
  'spendingDescription',
  'customInstructions',
  'derivationPrefix',
  'derivationSuffix',
  'type',
  'purpose'
] as const)
export const transactionScalarTextFields = Object.freeze([
  'status',
  'reference',
  'txid',
  'noSendExpiryMode',
  'noSendExpiryState',
  'noSendExpiryAnchorTxid',
  'noSendExpiryReclaimTxid'
] as const)
export const outputScalarTextFields = Object.freeze(['providedBy', 'txid', 'senderIdentityKey'] as const)
const transactionColumns = Object.freeze([
  'created_at',
  'updated_at',
  'transactionId',
  'userId',
  'provenTxId',
  'status',
  'reference',
  'isOutgoing',
  'satoshis',
  'version',
  'lockTime',
  'txid',
  'noSendExpiryMode',
  'noSendExpiryValue',
  'noSendExpiryDeadline',
  'noSendExpiryState',
  'noSendExpiryAnchorTxid',
  'noSendExpiryAnchorVout',
  'noSendExpiryReleasedAt',
  'noSendExpiryObservedAt',
  'noSendExpiryReclaimTxid',
  'noSendExpiryReclaimSatoshis',
  ...transactionPayloadFields
])
const outputColumns = Object.freeze([
  'created_at',
  'updated_at',
  'outputId',
  'userId',
  'transactionId',
  'basketId',
  'spendable',
  'change',
  'vout',
  'satoshis',
  'providedBy',
  'txid',
  'senderIdentityKey',
  'spentBy',
  'sequenceNumber',
  'scriptLength',
  'scriptOffset',
  ...outputPayloadFields
])
/** Fixed original column DATA shared by private scalar/marker writers. */
export function snapshotSyncActionColumns(table: 'transactions' | 'outputs'): readonly string[] {
  return table === 'transactions' ? transactionColumns : outputColumns
}
function columns(
  fields: Readonly<Record<string, unknown>>,
  extents: Extents,
  allowed: readonly string[],
  payload: readonly string[]
): void {
  if (
    Object.keys(fields).some(name => !allowed.includes(name)) ||
    Object.keys(extents).some(name => !payload.includes(name))
  )
    invalid()
}

/** Complete generic policy rows: every required property is validated and
 * payload descriptors remain DATA. These are never cast to wallet DTOs. */
export function snapshotSyncTransactionMetadata(
  fields: Readonly<Record<string, unknown>>,
  extents: Extents
): SnapshotSyncTransactionRow {
  return transactionMetadata(fields, extents, id)
}
/** Original accepted archive IDs may be zero or negative. This complete DATA
 * form neither admits an archive nor changes native producer ID contracts. */
export function brc38ImportTransactionMetadata(
  fields: Readonly<Record<string, unknown>>,
  extents: Extents
): SnapshotSyncTransactionRow {
  return transactionMetadata(fields, extents, archiveId)
}
function transactionMetadata(
  fields: Readonly<Record<string, unknown>>,
  extents: Extents,
  selectedId: typeof id
): SnapshotSyncTransactionRow {
  columns(fields, extents, transactionColumns, transactionPayloadFields)
  return {
    created_at: date(fields.created_at),
    updated_at: date(fields.updated_at),
    transactionId: selectedId(fields.transactionId)!,
    userId: selectedId(fields.userId)!,
    provenTxId: selectedId(fields.provenTxId, true),
    status: choice(fields.status, [
      'completed',
      'failed',
      'unprocessed',
      'sending',
      'unproven',
      'unsigned',
      'nosend',
      'nonfinal',
      'unfail'
    ] as const)!,
    reference: text(fields.reference)!,
    isOutgoing: flag(fields.isOutgoing),
    satoshis: number(fields.satoshis)!,
    description: cell(fields, extents, 'description')!,
    version: number(fields.version, true),
    lockTime: number(fields.lockTime, true),
    txid: text(fields.txid, true),
    rawTx: binary(fields, extents, 'rawTx'),
    inputBEEF: binary(fields, extents, 'inputBEEF'),
    noSendExpiryMode: choice(fields.noSendExpiryMode, ['seconds', 'timestamp', 'blockheight'] as const, true),
    noSendExpiryState: choice(
      fields.noSendExpiryState,
      [
        'preparing',
        'unsigned',
        'signed',
        'revocation-requested',
        'broadcast',
        'reclaiming',
        'reclaimed',
        'target-won',
        'conflicted',
        'cancelled'
      ] as const,
      true
    ),
    noSendExpiryValue: number(fields.noSendExpiryValue, true),
    noSendExpiryDeadline: number(fields.noSendExpiryDeadline, true),
    noSendExpiryAnchorTxid: text(fields.noSendExpiryAnchorTxid, true),
    noSendExpiryAnchorVout: number(fields.noSendExpiryAnchorVout, true),
    noSendExpiryReleasedAt: number(fields.noSendExpiryReleasedAt, true),
    noSendExpiryObservedAt: number(fields.noSendExpiryObservedAt, true),
    noSendExpiryReclaimTxid: text(fields.noSendExpiryReclaimTxid, true),
    noSendExpiryReclaimRawTx: binary(fields, extents, 'noSendExpiryReclaimRawTx'),
    noSendExpiryReclaimDerivationPrefix: cell(fields, extents, 'noSendExpiryReclaimDerivationPrefix', true),
    noSendExpiryReclaimDerivationSuffix: cell(fields, extents, 'noSendExpiryReclaimDerivationSuffix', true),
    noSendExpiryReclaimSatoshis: number(fields.noSendExpiryReclaimSatoshis, true)
  }
}
export function snapshotSyncOutputMetadata(
  fields: Readonly<Record<string, unknown>>,
  extents: Extents
): SnapshotSyncOutputRow {
  return outputMetadata(fields, extents, id)
}
/** Separate complete archive form; actual mapped destination IDs remain
 * positive and are freshly checked by the enclosing original merge policy. */
export function brc38ImportOutputMetadata(
  fields: Readonly<Record<string, unknown>>,
  extents: Extents
): SnapshotSyncOutputRow {
  return outputMetadata(fields, extents, archiveId)
}
function outputMetadata(
  fields: Readonly<Record<string, unknown>>,
  extents: Extents,
  selectedId: typeof id
): SnapshotSyncOutputRow {
  columns(fields, extents, outputColumns, outputPayloadFields)
  const vout = number(fields.vout)!
  if (!Number.isSafeInteger(vout) || vout < 0) invalid()
  return {
    created_at: date(fields.created_at),
    updated_at: date(fields.updated_at),
    outputId: selectedId(fields.outputId)!,
    userId: selectedId(fields.userId)!,
    transactionId: selectedId(fields.transactionId)!,
    basketId: selectedId(fields.basketId, true),
    spentBy: selectedId(fields.spentBy, true),
    vout,
    spendable: flag(fields.spendable),
    change: flag(fields.change),
    satoshis: number(fields.satoshis)!,
    providedBy: choice(fields.providedBy, ['you', 'storage', 'you-and-storage'] as const)!,
    txid: text(fields.txid, true),
    senderIdentityKey: text(fields.senderIdentityKey, true),
    outputDescription: cell(fields, extents, 'outputDescription')!,
    spendingDescription: cell(fields, extents, 'spendingDescription', true),
    customInstructions: cell(fields, extents, 'customInstructions', true),
    derivationPrefix: cell(fields, extents, 'derivationPrefix', true),
    derivationSuffix: cell(fields, extents, 'derivationSuffix', true),
    type: cell(fields, extents, 'type')!,
    purpose: cell(fields, extents, 'purpose')!,
    sequenceNumber: number(fields.sequenceNumber, true),
    scriptLength: number(fields.scriptLength, true),
    scriptOffset: number(fields.scriptOffset, true),
    lockingScript: binary(fields, extents, 'lockingScript')
  }
}
