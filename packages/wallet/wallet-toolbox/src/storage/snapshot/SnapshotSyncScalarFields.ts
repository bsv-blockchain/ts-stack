import type { SyncChunk } from '../../sdk/WalletStorage.interfaces'
import { packedIdbPositive } from '../idbPackedFields'
import type { SnapshotSyncCheckpoint, SnapshotSyncTable } from './SnapshotSync'
import { snapshotSyncTables } from './SnapshotSync'
import type { DetachedSnapshotSyncFieldRow } from './SnapshotSyncFieldRows'
import type { WalletSnapshotPage } from './WalletReadSnapshot'

function invalid(): never {
  throw new Error('Scalar snapshot metadata must contain complete original scalar entity fields')
}
function time(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(Date.prototype.getTime.call(value))) invalid()
  return new Date(Date.prototype.getTime.call(value))
}
function text(value: unknown): string {
  if (typeof value !== 'string') invalid()
  return value
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid()
  return value
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid()
  return value
}

/** Reconstruct only genuinely complete, payload-free scalar tables. This is
 * not a cast of partial field metadata into an entity DTO. Missing/extra
 * fields, extents and unknown tables refuse before any provider await. The
 * actual existing entity methods still own merge/tombstone/default semantics. */
export function snapshotSyncScalarChunk(
  checkpoint: SnapshotSyncCheckpoint,
  rows: readonly Readonly<DetachedSnapshotSyncFieldRow>[]
): SyncChunk {
  const table = snapshotSyncTables[checkpoint.tableIndex],
    chunk: SyncChunk = {
      userIdentityKey: checkpoint.identityKey,
      fromStorageIdentityKey: checkpoint.sourceStorageIdentityKey,
      toStorageIdentityKey: checkpoint.destinationStorageIdentityKey
    }
  const data = rows.map(row => {
    if (Object.keys(row.extents).length !== 0) invalid()
    const fields = row.fields,
      common = {
        created_at: time(fields.created_at),
        updated_at: time(fields.updated_at),
        isDeleted: boolean(fields.isDeleted)
      }
    const selected: Record<string, unknown> = { ...common }
    switch (table) {
      case 'outputBaskets':
        Object.assign(selected, {
          userId: packedIdbPositive(fields.userId),
          basketId: packedIdbPositive(fields.basketId),
          name: text(fields.name),
          numberOfDesiredUTXOs: number(fields.numberOfDesiredUTXOs),
          minimumDesiredUTXOValue: number(fields.minimumDesiredUTXOValue)
        })
        break
      case 'outputTags':
        Object.assign(selected, {
          userId: packedIdbPositive(fields.userId),
          outputTagId: packedIdbPositive(fields.outputTagId),
          tag: text(fields.tag)
        })
        break
      case 'txLabels':
        Object.assign(selected, {
          userId: packedIdbPositive(fields.userId),
          txLabelId: packedIdbPositive(fields.txLabelId),
          label: text(fields.label)
        })
        break
      case 'txLabelMaps':
        Object.assign(selected, {
          txLabelId: packedIdbPositive(fields.txLabelId),
          transactionId: packedIdbPositive(fields.transactionId)
        })
        break
      case 'outputTagMaps':
        Object.assign(selected, {
          outputTagId: packedIdbPositive(fields.outputTagId),
          outputId: packedIdbPositive(fields.outputId)
        })
        break
      default:
        invalid()
    }
    if (JSON.stringify(Object.keys(fields).sort()) !== JSON.stringify(Object.keys(selected).sort())) invalid()
    return selected
  })
  // Explicit complete row construction retains the original public contracts.
  // The intermediate detached records are DATA, never prepared verdicts.
  switch (table) {
    case 'outputBaskets':
      chunk.outputBaskets = data.map(row => ({
        created_at: time(row.created_at),
        updated_at: time(row.updated_at),
        isDeleted: boolean(row.isDeleted),
        userId: packedIdbPositive(row.userId),
        basketId: packedIdbPositive(row.basketId),
        name: text(row.name),
        numberOfDesiredUTXOs: number(row.numberOfDesiredUTXOs),
        minimumDesiredUTXOValue: number(row.minimumDesiredUTXOValue)
      }))
      break
    case 'outputTags':
      chunk.outputTags = data.map(row => ({
        created_at: time(row.created_at),
        updated_at: time(row.updated_at),
        isDeleted: boolean(row.isDeleted),
        userId: packedIdbPositive(row.userId),
        outputTagId: packedIdbPositive(row.outputTagId),
        tag: text(row.tag)
      }))
      break
    case 'txLabels':
      chunk.txLabels = data.map(row => ({
        created_at: time(row.created_at),
        updated_at: time(row.updated_at),
        isDeleted: boolean(row.isDeleted),
        userId: packedIdbPositive(row.userId),
        txLabelId: packedIdbPositive(row.txLabelId),
        label: text(row.label)
      }))
      break
    case 'txLabelMaps':
      chunk.txLabelMaps = data.map(row => ({
        created_at: time(row.created_at),
        updated_at: time(row.updated_at),
        isDeleted: boolean(row.isDeleted),
        txLabelId: packedIdbPositive(row.txLabelId),
        transactionId: packedIdbPositive(row.transactionId)
      }))
      break
    case 'outputTagMaps':
      chunk.outputTagMaps = data.map(row => ({
        created_at: time(row.created_at),
        updated_at: time(row.updated_at),
        isDeleted: boolean(row.isDeleted),
        outputTagId: packedIdbPositive(row.outputTagId),
        outputId: packedIdbPositive(row.outputId)
      }))
      break
    default:
      invalid()
  }
  return chunk
}
export function snapshotSyncScalarPage(
  checkpoint: SnapshotSyncCheckpoint,
  chunk: SyncChunk,
  payloadBytes: number,
  done: boolean,
  cursor: WalletSnapshotPage<SnapshotSyncTable>['cursor']
): WalletSnapshotPage<SnapshotSyncTable> {
  const table = snapshotSyncTables[checkpoint.tableIndex]
  switch (table) {
    case 'outputBaskets':
      if (chunk.outputBaskets === undefined) invalid()
      return { rows: chunk.outputBaskets, payloadBytes, done, cursor }
    case 'outputTags':
      if (chunk.outputTags === undefined) invalid()
      return { rows: chunk.outputTags, payloadBytes, done, cursor }
    case 'txLabels':
      if (chunk.txLabels === undefined) invalid()
      return { rows: chunk.txLabels, payloadBytes, done, cursor }
    case 'txLabelMaps':
      if (chunk.txLabelMaps === undefined) invalid()
      return { rows: chunk.txLabelMaps, payloadBytes, done, cursor }
    case 'outputTagMaps':
      if (chunk.outputTagMaps === undefined) invalid()
      return { rows: chunk.outputTagMaps, payloadBytes, done, cursor }
    default:
      invalid()
  }
}
