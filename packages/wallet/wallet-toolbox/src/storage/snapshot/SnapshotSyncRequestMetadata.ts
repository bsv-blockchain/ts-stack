import type { ProvenTxReqMergeRow } from '../schema/entities/EntityProvenTxReq'
import type { WalletSnapshotFieldDescriptor } from './WalletReadSnapshot'

export type SnapshotSyncRequestText = string | Readonly<WalletSnapshotFieldDescriptor>
export type SnapshotSyncRequestRow = ProvenTxReqMergeRow<
  Readonly<WalletSnapshotFieldDescriptor>,
  SnapshotSyncRequestText
>
const columns = Object.freeze([
  'created_at',
  'updated_at',
  'provenTxReqId',
  'provenTxId',
  'status',
  'attempts',
  'notified',
  'txid',
  'batch',
  'history',
  'notify',
  'rawTx',
  'inputBEEF',
  'wasBroadcast',
  'rebroadcastAttempts'
])
export function snapshotSyncRequestColumns(): readonly string[] {
  return columns
}
const statuses = Object.freeze([
  'sending',
  'unsent',
  'nosend',
  'unknown',
  'nonfinal',
  'unprocessed',
  'unmined',
  'callback',
  'unconfirmed',
  'completed',
  'invalid',
  'doubleSpend',
  'unfail'
] as const)
function invalid(): never {
  throw new Error('Snapshot request metadata is incomplete or differs from its table contract')
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
  if (typeof value !== 'string' || value.length > 131072) invalid()
  return value
}
function flag(value: unknown, optional = false): boolean | undefined {
  if (optional && value === undefined) return undefined
  if (typeof value !== 'boolean') invalid()
  return value
}
/** Complete generic policy metadata. Descriptors are payload DATA, never a
 * partly populated TableProvenTxReq or permission to use a native pointer. */
export function snapshotSyncRequestMetadata(
  fields: Readonly<Record<string, unknown>>,
  extents: Readonly<Record<string, Readonly<WalletSnapshotFieldDescriptor>>>
): SnapshotSyncRequestRow {
  return requestMetadata(fields, extents, id)
}
/** Accepted archive identities stay original DATA until an actual merge
 * resolves their natural keys and commits fresh local mappings. */
export function brc38ImportRequestMetadata(
  fields: Readonly<Record<string, unknown>>,
  extents: Readonly<Record<string, Readonly<WalletSnapshotFieldDescriptor>>>
): SnapshotSyncRequestRow {
  return requestMetadata(fields, extents, archiveId)
}
function requestMetadata(
  fields: Readonly<Record<string, unknown>>,
  extents: Readonly<Record<string, Readonly<WalletSnapshotFieldDescriptor>>>,
  selectedId: typeof id
): SnapshotSyncRequestRow {
  if (
    Object.keys(fields).some(name => !columns.includes(name)) ||
    Object.keys(extents).some(name => !['rawTx', 'inputBEEF', 'history', 'notify'].includes(name)) ||
    typeof fields.status !== 'string' ||
    !statuses.includes(fields.status as (typeof statuses)[number])
  )
    invalid()
  const binary = (name: string, optional = false): Readonly<WalletSnapshotFieldDescriptor> | undefined => {
      const extent = extents[name]
      if (extent === undefined) {
        if (!optional || fields[name] !== undefined) invalid()
        return undefined
      }
      if (extent.kind !== 'binary' || fields[name] !== undefined) invalid()
      return extent
    },
    cell = (name: string): SnapshotSyncRequestText => {
      const extent = extents[name]
      if (extent !== undefined) {
        if (extent.kind === 'binary' || fields[name] !== undefined) invalid()
        return extent
      }
      return text(fields[name])!
    }
  const txid = text(fields.txid)!,
    batch = text(fields.batch, true)
  if (txid.length < 1 || txid.length > 4096 || (batch !== undefined && batch.length > 4096)) invalid()
  return {
    created_at: date(fields.created_at),
    updated_at: date(fields.updated_at),
    provenTxReqId: selectedId(fields.provenTxReqId)!,
    provenTxId: selectedId(fields.provenTxId, true),
    status: fields.status as (typeof statuses)[number],
    attempts: number(fields.attempts)!,
    notified: flag(fields.notified)!,
    txid,
    batch,
    history: cell('history'),
    notify: cell('notify'),
    rawTx: binary('rawTx')!,
    inputBEEF: binary('inputBEEF', true),
    wasBroadcast: flag(fields.wasBroadcast, true),
    rebroadcastAttempts: number(fields.rebroadcastAttempts, true)
  }
}

/** Preserve the archived key spelling for the existing exact indexed lookup.
 * Cryptographic comparisons and same-page alias detection normalize separately. */
export function brc38ImportRequestIdentity<Row extends { readonly txid: string }>(row: Row): Readonly<Row> {
  return Object.freeze({ ...row })
}
