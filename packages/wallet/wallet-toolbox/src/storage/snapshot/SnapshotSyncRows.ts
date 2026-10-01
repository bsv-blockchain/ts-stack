import { SnapshotResourceLimitError } from './SnapshotResourceLimitError'
import type { Knex } from 'knex'
import type { SyncChunk } from '../../sdk/WalletStorage.interfaces'
import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'
import { createSyncMap, type SyncMap } from '../schema/entities/EntityBase'
import { snapshotSyncPage } from '../sync/snapshotSyncPage'
import { snapshotSyncTables, type SnapshotSyncCheckpoint, type SnapshotSyncTable } from './SnapshotSync'
import type { WalletSnapshotPage } from './WalletReadSnapshot'
import { runInSeries } from '../../utility/runInSeries'
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

interface IdRow {
  entity: keyof SyncMap
  incomingId: number
  localId: number
}
export interface SnapshotMapScope {
  userId: number
  sourceStorageIdentityKey: string
}

interface PageReferences {
  wanted: Map<keyof SyncMap, Set<number>>
  required: Map<keyof SyncMap, Set<number>>
  count: number
}

function addReference(refs: PageReferences, entity: keyof SyncMap, id: unknown, parent: boolean): void {
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

function collectNotifications(refs: PageReferences, row: Record<string, unknown>): void {
  const notify = JSON.parse(row.notify as string) as { transactionIds?: unknown[] }
  if (notify.transactionIds == null) return
  if (!Array.isArray(notify.transactionIds)) throw new WERR_INVALID_PARAMETER('notify', 'an array of transaction IDs')
  // Global request notification lists may also contain other profiles. Only
  // mappings established for this profile may survive the existing merge.
  for (const id of notify.transactionIds) addReference(refs, 'transaction', id, false)
}

function collectReferences(sourceUserId: number, table: SnapshotSyncTable, chunk: SyncChunk): PageReferences {
  const refs: PageReferences = { wanted: new Map(), required: new Map(), count: 0 }
  const rows = chunk[table] as unknown as Array<Record<string, unknown>>
  const owned = !['provenTxs', 'provenTxReqs', 'txLabelMaps', 'outputTagMaps'].includes(table)
  for (const row of rows) {
    if ((owned || row.userId !== undefined) && row.userId !== sourceUserId)
      throw new WERR_INVALID_OPERATION('Snapshot row belongs to another profile')
    for (const [field, entity] of Object.entries(ids)) {
      if (row[field] != null) addReference(refs, entity, row[field], entity !== entities[table])
    }
    if (table === 'provenTxReqs') collectNotifications(refs, row)
  }
  return refs
}

/** Produce one SQL parameter batch at a time without creating an eager query queue. */
function* idBatches<T>(values: T[]): Generator<T[]> {
  for (let offset = 0; offset < values.length; offset += 128) yield values.slice(offset, offset + 128)
}

/** Load only incoming IDs and their parent references; never parse or overwrite the legacy JSON map. */
export async function loadSnapshotIdMap(
  k: Knex,
  scope: SnapshotMapScope,
  sourceUserId: number,
  table: SnapshotSyncTable,
  chunk: SyncChunk
): Promise<{ map: SyncMap; persist: () => Promise<void> }> {
  const { wanted, required } = collectReferences(sourceUserId, table, chunk)
  const map = createSyncMap()
  const known = new Map<keyof SyncMap, Set<number>>()
  await runInSeries(wanted, async ([entity, values]) => {
    await runInSeries(idBatches([...values]), async batch => {
      const found: IdRow[] = await k('snapshot_sync_ids')
        .select('incomingId', 'localId')
        .where({ ...scope, entity })
        .whereIn('incomingId', batch)
      for (const row of found) map[entity].idMap[row.incomingId] = row.localId
    })
    known.set(entity, new Set(Object.keys(map[entity].idMap).map(Number)))
  })
  for (const [entity, values] of required) {
    for (const id of values) {
      if (map[entity].idMap[id] === undefined)
        throw new WERR_INVALID_OPERATION('Snapshot parent mapping is missing; restart from the durable source view')
    }
  }
  return {
    map,
    async persist() {
      const additions: Array<IdRow & SnapshotMapScope> = []
      for (const [entity, values] of wanted) {
        for (const id of values) {
          const localId = map[entity].idMap[id]
          if (localId !== undefined && !known.get(entity)?.has(id))
            additions.push({ ...scope, entity, incomingId: id, localId })
        }
      }
      await runInSeries(idBatches(additions), async batch => {
        await k('snapshot_sync_ids').insert(batch)
      })
    }
  }
}
