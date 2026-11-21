import type { Brc38ImportHistoryProjection } from './Brc38IdbRestoreMetadata'
import type { Knex } from 'knex'
import type { Brc38PreparedImportData } from './Brc38ImportPage'
import { loadBrc38ImportIdMap, type Brc38ImportMapScope } from './Brc38ImportIdMap'
import { createSyncMap, type SyncMap } from '../schema/entities/EntityBase'
import { canonicalPortableChunks } from './CanonicalPortableChunks'
import { runInSeries } from '../../utility/runInSeries'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

export type { Brc38ImportHistoryProjection } from './Brc38IdbRestoreMetadata'
interface Entry {
  entityName: string
  count: number
  idMap: Record<number, number>
  maxUpdated_at?: string
}
interface Budget {
  remaining: number
  maximum: number
  signal?: AbortSignal
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function parsed(json: string, budget: Budget): Record<string, unknown> {
  budget.signal?.throwIfAborted()
  if (typeof json !== 'string' || Buffer.byteLength(json) > budget.maximum)
    throw new SnapshotResourceLimitError('Private import history exceeds its fixed preparation budget')
  const value: unknown = JSON.parse(json)
  if (!object(value)) throw new Error('Private import history must be a prepared JSON object')
  return value
}
function encoded(value: unknown, budget: Budget): string {
  const decoder = new TextDecoder(),
    parts: string[] = []
  for (const chunk of canonicalPortableChunks(value, {
    maximumValueBytes: budget.maximum,
    maximumChunkBytes: 4096,
    signal: budget.signal
  })) {
    if (chunk.byteLength > budget.remaining)
      throw new SnapshotResourceLimitError('Private import history exceeds its fixed page byte budget')
    budget.remaining -= chunk.byteLength
    parts.push(decoder.decode(chunk, { stream: true }))
  }
  parts.push(decoder.decode())
  return parts.join('')
}
function* groups<T>(values: Iterable<T>): Generator<T[]> {
  let group: T[] = []
  for (const value of values) {
    group.push(value)
    if (group.length === 128) {
      yield group
      group = []
    }
  }
  if (group.length > 0) yield group
}
/** Each native map read is scoped to this admitted import/profile, and at most
 * 128 entries. No archive-wide map or reference list is retained. */
async function remapped(
  trx: Knex.Transaction,
  scope: Brc38ImportMapScope,
  entity: keyof SyncMap,
  values: Iterable<readonly [number, number]>,
  budget: Budget
): Promise<{ ids: Record<number, number>; missing: number }> {
  const ids: Record<number, number> = {}
  let missing = 0
  await runInSeries(groups(values), async group => {
    budget.signal?.throwIfAborted()
    const loaded = await loadBrc38ImportIdMap(
      trx,
      scope,
      group.map(([, incomingId]) => ({ entity, incomingId, required: false }))
    )
    for (const [key, incoming] of group) {
      const map = loaded.map[entity].idMap
      if (Object.hasOwn(map, incoming)) ids[key] = map[incoming]
      else missing++
    }
    // Preparation cannot call persist; it runs in a physically read-only pool.
  })
  return { ids, missing }
}
function* notifications(value: unknown): Generator<readonly [number, number]> {
  if (!Array.isArray(value)) return
  const seen = new Set<number>()
  for (const id of value) {
    if (typeof id === 'number' && Number.isInteger(id) && !seen.has(id)) {
      seen.add(id)
      yield [id, id]
    }
  }
}
async function notify(
  trx: Knex.Transaction,
  scope: Brc38ImportMapScope,
  originalJson: string,
  budget: Budget
): Promise<Brc38ImportHistoryProjection> {
  const source = parsed(originalJson, budget),
    { ids, missing } = await remapped(trx, scope, 'transaction', notifications(source.transactionIds), budget),
    transactionIds = [...new Set(Object.values(ids))].sort((a, b) => a - b)
  return Object.freeze({
    field: 'notify',
    originalJson,
    mappedJson: encoded({ ...source, transactionIds }, budget),
    unmappedIds: missing,
    activated: false
  })
}
function normalizedEntry(source: unknown, entity: keyof SyncMap): Entry {
  const entry: Entry = { entityName: entity, count: 0, idMap: {} }
  if (!object(source)) return entry
  if (typeof source.entityName === 'string') entry.entityName = source.entityName
  if (typeof source.count === 'number' && Number.isInteger(source.count)) entry.count = source.count
  if (typeof source.maxUpdated_at === 'string') {
    const when = new Date(source.maxUpdated_at)
    if (!Number.isNaN(when.getTime())) entry.maxUpdated_at = when.toISOString()
  }
  entry.idMap = normalizedIds(source.idMap)
  return entry
}
function normalizedIds(source: unknown): Record<number, number> {
  const target: Record<number, number> = {}
  if (!object(source)) return target
  for (const key in source) {
    if (!Object.hasOwn(source, key)) continue
    const remote = Number(key),
      local = source[key]
    if (Number.isInteger(remote) && typeof local === 'number' && Number.isInteger(local)) target[remote] = local
  }
  return target
}
function* ids(values: Readonly<Record<number, number>>): Generator<readonly [number, number]> {
  for (const key in values) if (Object.hasOwn(values, key)) yield [Number(key), values[Number(key)]]
}
async function syncMap(
  trx: Knex.Transaction,
  scope: Brc38ImportMapScope,
  originalJson: string,
  budget: Budget
): Promise<Brc38ImportHistoryProjection> {
  const source = parsed(originalJson, budget),
    target: Partial<Record<keyof SyncMap, Entry>> = {}
  let missing = 0
  await runInSeries(Object.keys(createSyncMap()) as Array<keyof SyncMap>, async entity => {
    const entry = normalizedEntry(source[entity], entity),
      mapped = await remapped(trx, scope, entity, ids(entry.idMap), budget)
    entry.idMap = mapped.ids
    target[entity] = entry
    missing += mapped.missing
  })
  return Object.freeze({
    field: 'syncMap',
    originalJson,
    mappedJson: encoded(target, budget),
    unmappedIds: missing,
    activated: false
  })
}
/** Prepare only bounded inactive operational projections. Original JSON remains
 * byte-identical and separately identifiable, including source counts/timestamps.
 * This does not write provenance, merge entities or authorize a checkpoint. */
export async function prepareBrc38ImportHistory(
  trx: Knex.Transaction,
  scope: Brc38ImportMapScope,
  data: Brc38PreparedImportData,
  maximumBytes: number,
  signal?: AbortSignal
): Promise<readonly Readonly<Brc38ImportHistoryProjection>[]> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 16777216)
    throw new RangeError('Invalid fixed private import history preparation budget')
  signal?.throwIfAborted()
  const budget: Budget = { maximum: maximumBytes, remaining: maximumBytes, signal },
    prepared: Brc38ImportHistoryProjection[] = []
  if (data.kind === 'table' && data.table === 'provenTxReqs')
    await runInSeries(data.rows, async row => {
      prepared.push(await notify(trx, scope, row.notify, budget))
    })
  if (data.kind === 'table' && data.table === 'syncStates')
    await runInSeries(data.rows, async row => {
      prepared.push(await syncMap(trx, scope, row.syncMap, budget))
    })
  signal?.throwIfAborted()
  return Object.freeze(prepared)
}
