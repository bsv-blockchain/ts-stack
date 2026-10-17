import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'
import { copySnapshotCursor } from './SnapshotCursor'
import { snapshotSyncTables, type SnapshotSyncCheckpoint, type SnapshotSyncTable } from './SnapshotSync'
import type {
  WalletSnapshotCursor,
  WalletSnapshotFieldDescriptor,
  WalletSnapshotFieldMetadataPage
} from './WalletReadSnapshot'
import { SnapshotResourceLimitError } from './SnapshotResourceLimitError'

const dateGetTime = Date.prototype.getTime

const keys: Readonly<Record<SnapshotSyncTable, readonly string[]>> = Object.freeze({
  provenTxs: ['provenTxId'],
  outputBaskets: ['basketId'],
  outputTags: ['outputTagId'],
  txLabels: ['txLabelId'],
  transactions: ['transactionId'],
  outputs: ['outputId'],
  txLabelMaps: ['txLabelId', 'transactionId'],
  outputTagMaps: ['outputTagId', 'outputId'],
  certificates: ['certificateId'],
  certificateFields: ['fieldName', 'certificateId'],
  commissions: ['commissionId'],
  provenTxReqs: ['provenTxReqId']
})
function invalid(): never {
  throw new WERR_INVALID_PARAMETER('page', 'detached bounded snapshot field metadata and exact source coordinates')
}
function own(value: unknown, maximum: number): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(value)) ||
    Object.getOwnPropertySymbols(value).length !== 0
  )
    invalid()
  const result: Record<string, unknown> = Object.create(null),
    names = Object.getOwnPropertyNames(value)
  if (names.length > maximum) invalid()
  for (const name of names) {
    const property = Object.getOwnPropertyDescriptor(value, name)
    if (
      name.length < 1 ||
      name.length > 128 ||
      ['__proto__', 'constructor', 'prototype'].includes(name) ||
      property === undefined ||
      !Object.hasOwn(property, 'value') ||
      !property.enumerable
    )
      invalid()
    result[name] = property.value
  }
  return result
}
function position(
  selected: unknown,
  checkpoint: SnapshotSyncCheckpoint,
  table: SnapshotSyncTable
): WalletSnapshotCursor {
  const data = own(selected, 5),
    after = data.after
  if (
    data.version !== 1 ||
    data.snapshotId !== checkpoint.snapshotId ||
    data.table !== table ||
    Object.keys(data).some(name => !['version', 'snapshotId', 'table', 'after', 'archivePosition'].includes(name)) ||
    !Array.isArray(after) ||
    after.length !== keys[table].length ||
    Object.getOwnPropertySymbols(after).length !== 0
  )
    invalid()
  const values: Array<string | number> = []
  for (let index = 0; index < after.length; index++) {
    const property = Object.getOwnPropertyDescriptor(after, String(index))
    if (property === undefined || !Object.hasOwn(property, 'value') || !property.enumerable) invalid()
    const value: unknown = property.value
    if (
      typeof value === 'number'
        ? !Number.isSafeInteger(value) || value < 1
        : typeof value !== 'string' || value.length < 1 || value.length > 4096
    )
      invalid()
    values.push(value as number | string)
  }
  // Archive coordinates are also detached DATA; this does not authenticate a
  // remote source or introduce a version-one wire capability.
  return copySnapshotCursor({
    version: 1,
    snapshotId: checkpoint.snapshotId,
    table,
    after: values,
    ...(data.archivePosition === undefined
      ? {}
      : { archivePosition: own(data.archivePosition, 4) as unknown as WalletSnapshotCursor['archivePosition'] })
  })!
}

export interface DetachedSnapshotSyncFieldRow {
  readonly fields: Readonly<Record<string, unknown>>
  readonly extents: Readonly<Record<string, Readonly<WalletSnapshotFieldDescriptor>>>
  readonly cursor: WalletSnapshotCursor
}
/** Detach before any source/provider await. No complete payload/JSON is read,
 * copied or fabricated. Allocation and descriptor bytes are independent DATA
 * ceilings; the actual field reader must compare every requested extent. */
export function detachSnapshotSyncFieldPage(
  checkpoint: SnapshotSyncCheckpoint,
  selected: WalletSnapshotFieldMetadataPage<SnapshotSyncTable>,
  maximumMetadataBytes = 262144
): Readonly<{
  rows: readonly Readonly<DetachedSnapshotSyncFieldRow>[]
  nextCursor: string | null
  nextTable: number
  allocationBytes: number
}> {
  const table = snapshotSyncTables[checkpoint.tableIndex]
  if (table === undefined || checkpoint.done) throw new WERR_INVALID_OPERATION('Snapshot sync is already complete')
  const page = own(selected, 4),
    input = page.rows
  if (
    !Array.isArray(input) ||
    input.length > 1000 ||
    typeof page.done !== 'boolean' ||
    !Number.isSafeInteger(maximumMetadataBytes) ||
    maximumMetadataBytes < 1 ||
    maximumMetadataBytes > 16777216 ||
    typeof page.payloadBytes !== 'number' ||
    !Number.isSafeInteger(page.payloadBytes) ||
    page.payloadBytes < 0 ||
    page.payloadBytes > maximumMetadataBytes ||
    (!page.done && input.length === 0) ||
    Object.keys(page).some(name => !['rows', 'payloadBytes', 'done', 'cursor'].includes(name))
  )
    invalid()
  const advertisedBytes = page.payloadBytes as number
  let allocationBytes = 0
  const take = (bytes: number): void => {
      allocationBytes += bytes
      if (allocationBytes > advertisedBytes || allocationBytes > maximumMetadataBytes)
        throw new SnapshotResourceLimitError('Snapshot field metadata exceeds its original advertised allocation')
    },
    rows: Array<Readonly<DetachedSnapshotSyncFieldRow>> = [],
    seen = new Set<string>()
  for (let index = 0; index < input.length; index++) {
    const property = Object.getOwnPropertyDescriptor(input, String(index))
    if (property === undefined || !Object.hasOwn(property, 'value') || !property.enumerable) invalid()
    const data = own(property.value, 3)
    if (
      Object.keys(data).length !== 3 ||
      !Object.hasOwn(data, 'fields') ||
      !Object.hasOwn(data, 'extents') ||
      !Object.hasOwn(data, 'cursor')
    )
      invalid()
    const selectedFields = own(data.fields, 64),
      fields: Record<string, unknown> = Object.create(null),
      selectedExtents = own(data.extents, 64),
      extents: Record<string, Readonly<WalletSnapshotFieldDescriptor>> = Object.create(null)
    if (Object.keys(selectedFields).length + Object.keys(selectedExtents).length > 64) invalid()
    for (const [name, value] of Object.entries(selectedFields)) {
      if (value !== null && typeof value === 'object') {
        // The Date internal slot accepts genuine values from another realm,
        // while copied prototypes, proxies and arbitrary objects still refuse.
        let time: number
        try {
          time = dateGetTime.call(value)
        } catch {
          invalid()
        }
        if (!Number.isFinite(time)) invalid()
        take(64)
        fields[name] = new Date(time)
      } else {
        if (
          (value != null && !['string', 'number', 'boolean'].includes(typeof value)) ||
          (typeof value === 'number' && !Number.isFinite(value))
        )
          invalid()
        take(typeof value === 'string' ? 64 + 2 * value.length : 64)
        fields[name] = value
      }
    }
    for (const [name, value] of Object.entries(selectedExtents)) {
      const descriptor = own(value, 3)
      if (
        Object.hasOwn(fields, name) ||
        !['binary', 'utf8', 'utf16le'].includes(descriptor.kind as string) ||
        typeof descriptor.bytes !== 'number' ||
        !Number.isSafeInteger(descriptor.bytes) ||
        descriptor.bytes < 0 ||
        descriptor.bytes > 1000000000 ||
        (descriptor.kind === 'utf16le' && descriptor.bytes % 2 !== 0) ||
        (descriptor.sha256 !== undefined &&
          (typeof descriptor.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(descriptor.sha256))) ||
        Object.keys(descriptor).some(key => !['kind', 'bytes', 'sha256'].includes(key))
      )
        invalid()
      take(256)
      extents[name] = Object.freeze({
        kind: descriptor.kind as WalletSnapshotFieldDescriptor['kind'],
        bytes: descriptor.bytes,
        ...(descriptor.sha256 === undefined ? {} : { sha256: descriptor.sha256 as string })
      })
    }
    const cursor = position(data.cursor, checkpoint, table),
      encoded = JSON.stringify(cursor)
    if (
      keys[table].some((name, keyIndex) => fields[name] !== cursor.after[keyIndex]) ||
      encoded === JSON.stringify(checkpoint.cursor) ||
      seen.has(encoded)
    )
      invalid()
    seen.add(encoded)
    rows.push(Object.freeze({ fields: Object.freeze(fields), extents: Object.freeze(extents), cursor }))
  }
  const cursor = page.cursor === undefined ? undefined : position(page.cursor, checkpoint, table)
  if (
    rows.length > 0
      ? JSON.stringify(cursor) !== JSON.stringify(rows[rows.length - 1].cursor)
      : cursor !== undefined && JSON.stringify(cursor) !== JSON.stringify(checkpoint.cursor)
  )
    invalid()
  return Object.freeze({
    rows: Object.freeze(rows),
    allocationBytes,
    nextCursor: page.done ? null : JSON.stringify(cursor),
    nextTable: checkpoint.tableIndex + Number(page.done)
  })
}
