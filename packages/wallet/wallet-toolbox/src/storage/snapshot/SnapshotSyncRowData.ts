import { SnapshotResourceLimitError } from './SnapshotResourceLimitError'
import type { SyncChunk } from '../../sdk/WalletStorage.interfaces'
import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'
import type { SyncMap } from '../schema/entities/EntityBase'
import { snapshotSyncPage } from '../sync/snapshotSyncPage'
import { snapshotSyncTables, type SnapshotSyncCheckpoint, type SnapshotSyncTable } from './SnapshotSync'
import type { WalletSnapshotPage } from './WalletReadSnapshot'
import { copySnapshotArchivePosition } from './SnapshotCursor'

const entities: Record<SnapshotSyncTable, keyof SyncMap> = {
  provenTxs: 'provenTx',
  outputBaskets: 'outputBasket',
  outputTags: 'outputTag',
  txLabels: 'txLabel',
  transactions: 'transaction',
  outputs: 'output',
  txLabelMaps: 'txLabelMap',
  outputTagMaps: 'outputTagMap',
  certificates: 'certificate',
  certificateFields: 'certificateField',
  commissions: 'commission',
  provenTxReqs: 'provenTxReq'
}
const ids: Record<string, keyof SyncMap> = {
  provenTxId: 'provenTx',
  basketId: 'outputBasket',
  outputTagId: 'outputTag',
  txLabelId: 'txLabel',
  transactionId: 'transaction',
  spentBy: 'transaction',
  outputId: 'output',
  certificateId: 'certificate',
  commissionId: 'commission',
  provenTxReqId: 'provenTxReq'
}
const keys: Record<SnapshotSyncTable, string[]> = {
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
}

function allocationCharge(value: unknown): number {
  if (typeof value === 'string') return 64 + value.length * 2
  if (value instanceof Uint8Array) return 64 + value.byteLength * 2
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new WERR_INVALID_PARAMETER('rows', 'finite numbers')
  } else if (value != null && typeof value !== 'boolean') {
    let time: number
    try {
      time = Date.prototype.getTime.call(value)
    } catch {
      throw new WERR_INVALID_PARAMETER('rows', 'packed bytes, dates and scalar values')
    }
    if (!Number.isFinite(time)) throw new WERR_INVALID_PARAMETER('rows', 'finite dates')
  }
  return 64
}

/** Recheck packed allocation before copying even when called without the built-in SQL reader. */
function validateAllocation(rows: unknown[], advertisedBytes: number): void {
  let charge = 0
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Object.keys(row).length > 64) {
      throw new WERR_INVALID_PARAMETER('rows', 'flat snapshot records with at most 64 columns')
    }
    for (const value of Object.values(row)) {
      charge += allocationCharge(value)
      if (charge > advertisedBytes)
        throw new WERR_INVALID_PARAMETER('payloadBytes', 'an allocation charge covering every row')
    }
  }
}

export function detachSnapshotSyncPage(
  checkpoint: SnapshotSyncCheckpoint,
  page: WalletSnapshotPage<SnapshotSyncTable>
): {
  chunk: SyncChunk
  nextCursor: string | null
  nextTable: number
} {
  const table = snapshotSyncTables[checkpoint.tableIndex]
  if (table === undefined || checkpoint.done) throw new WERR_INVALID_OPERATION('Snapshot sync is already complete')
  if (
    !Array.isArray(page.rows) ||
    page.rows.length > 1000 ||
    typeof page.done !== 'boolean' ||
    !Number.isSafeInteger(page.payloadBytes) ||
    page.payloadBytes < 0 ||
    page.payloadBytes > 16777216 ||
    (!page.done && page.rows.length === 0)
  ) {
    throw new WERR_INVALID_PARAMETER('page', 'a bounded snapshot page making progress')
  }
  validateAllocation(page.rows, page.payloadBytes)
  const cursor = page.cursor
  if (cursor?.archivePosition !== undefined) copySnapshotArchivePosition(cursor.archivePosition)
  if (page.rows.length > 0) {
    const last = page.rows.at(-1) as unknown as Record<string, unknown>
    if (
      cursor?.version !== 1 ||
      cursor.snapshotId !== checkpoint.snapshotId ||
      cursor.table !== table ||
      !Array.isArray(cursor.after) ||
      cursor.after.length !== keys[table].length ||
      cursor.after.some((value, index) => value !== last[keys[table][index]]) ||
      JSON.stringify(cursor) === JSON.stringify(checkpoint.cursor)
    ) {
      throw new WERR_INVALID_PARAMETER('page.cursor', 'the last row of this source view and table')
    }
  } else if (cursor !== undefined && JSON.stringify(cursor) !== JSON.stringify(checkpoint.cursor)) {
    throw new WERR_INVALID_PARAMETER('page.cursor', 'the unchanged empty-page position')
  }
  // Entity merges and SQL serializers accept typed byte buffers. Keep the legacy
  // public SyncChunk number[] declaration unchanged at this internal boundary.
  const chunk = snapshotSyncPage(
    {
      identityKey: checkpoint.identityKey,
      fromStorageIdentityKey: checkpoint.sourceStorageIdentityKey,
      toStorageIdentityKey: checkpoint.destinationStorageIdentityKey,
      offsets: [],
      maxItems: 1000,
      maxRoughSize: 16777216
    },
    {
      userIdentityKey: checkpoint.identityKey,
      fromStorageIdentityKey: checkpoint.sourceStorageIdentityKey,
      toStorageIdentityKey: checkpoint.destinationStorageIdentityKey,
      [table]: page.rows
    } as SyncChunk
  ).chunk
  return {
    chunk,
    nextCursor: page.done ? null : JSON.stringify(cursor),
    nextTable: checkpoint.tableIndex + Number(page.done)
  }
}

export interface SnapshotMapScope {
  userId: number
  sourceStorageIdentityKey: string
}

export interface SnapshotSyncPageReferences {
  wanted: Map<keyof SyncMap, Set<number>>
  required: Map<keyof SyncMap, Set<number>>
  count: number
}

function addReference(refs: SnapshotSyncPageReferences, entity: keyof SyncMap, id: unknown, parent: boolean): void {
  if (!Number.isSafeInteger(id) || (id as number) < 1) throw new WERR_INVALID_PARAMETER('row', 'positive safe IDs')
  const set = refs.wanted.get(entity) ?? new Set<number>()
  if (!set.has(id as number) && ++refs.count > 4096)
    throw new SnapshotResourceLimitError('Snapshot page exceeds 4096 distinct ID references')
  set.add(id as number)
  refs.wanted.set(entity, set)
  if (parent) {
    const parents = refs.required.get(entity) ?? new Set<number>()
    parents.add(id as number)
    refs.required.set(entity, parents)
  }
}

function collectNotifications(refs: SnapshotSyncPageReferences, row: Record<string, unknown>): void {
  const notify = JSON.parse(row.notify as string) as { transactionIds?: unknown[] }
  if (notify.transactionIds == null) return
  if (!Array.isArray(notify.transactionIds)) throw new WERR_INVALID_PARAMETER('notify', 'an array of transaction IDs')
  // Global request notification lists may also contain other profiles. Only
  // mappings established for this profile may survive the existing merge.
  for (const id of notify.transactionIds) addReference(refs, 'transaction', id, false)
}

export function collectSnapshotSyncReferences(
  sourceUserId: number,
  table: SnapshotSyncTable,
  chunk: SyncChunk
): SnapshotSyncPageReferences {
  const rows = chunk[table] as unknown as Array<Record<string, unknown>>
  const refs = collectSnapshotSyncFieldReferences(sourceUserId, table, rows)
  if (table === 'provenTxReqs') for (const row of rows) collectNotifications(refs, row)
  return refs
}

/** Scalar references from field metadata, without fabricating complete entity
 * DTOs or parsing an unbounded notification field. Notification mappings are
 * separately read in bounded batches by the structured projection. Returned
 * maps contain detached ID DATA only; the actual writer must freshly load and
 * inspect each mapped destination parent before accepting an effect. */
export function collectSnapshotSyncFieldReferences(
  sourceUserId: number,
  table: SnapshotSyncTable,
  rows: readonly Readonly<Record<string, unknown>>[]
): SnapshotSyncPageReferences {
  if (
    !Number.isSafeInteger(sourceUserId) ||
    sourceUserId < 1 ||
    !Object.hasOwn(entities, table) ||
    !Array.isArray(rows) ||
    rows.length > 1000
  )
    throw new WERR_INVALID_PARAMETER('rows', 'bounded snapshot field metadata and a positive source user')
  const refs: SnapshotSyncPageReferences = { wanted: new Map(), required: new Map(), count: 0 }
  const owned = !['provenTxs', 'provenTxReqs', 'txLabelMaps', 'outputTagMaps'].includes(table)
  for (const row of rows) {
    if (
      row === null ||
      typeof row !== 'object' ||
      Array.isArray(row) ||
      ![null, Object.prototype].includes(Object.getPrototypeOf(row))
    )
      throw new WERR_INVALID_PARAMETER('rows', 'plain field metadata')
    const scalar = (name: string): unknown => {
      const property = Object.getOwnPropertyDescriptor(row, name)
      if (property === undefined) return undefined
      if (!Object.hasOwn(property, 'value') || !property.enumerable)
        throw new WERR_INVALID_PARAMETER('rows', 'own scalar ID properties')
      return property.value
    }
    const userId = scalar('userId')
    if ((owned || userId !== undefined) && userId !== sourceUserId)
      throw new WERR_INVALID_OPERATION('Snapshot row belongs to another profile')
    for (const [field, entity] of Object.entries(ids)) {
      const value = scalar(field)
      if (value != null) addReference(refs, entity, value, entity !== entities[table])
    }
  }
  return refs
}
