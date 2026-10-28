import type { Brc38ImportMapScope } from './Brc38ImportJournalContract'
import type { Knex } from 'knex'
import { createSyncMap, type SyncMap } from '../schema/entities/EntityBase'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import { runInSeries } from '../../utility/runInSeries'

export type { Brc38ImportMapScope } from './Brc38ImportJournalContract'
export interface Brc38ImportIdReference {
  readonly entity: keyof SyncMap
  readonly incomingId: number
  readonly required: boolean
}
interface IdRow {
  incomingId: string
  localId: number
}
type MappingRow = Brc38ImportMapScope & IdRow & { entity: keyof SyncMap }
type References = Map<keyof SyncMap, Map<string, boolean>>

function invalid(): never {
  throw new Error('Private import ID mapping is invalid or inconsistent')
}
function destinationId(value: unknown): value is number {
  return Number.isSafeInteger(value)
}
/** Preserve the decoded-number identity used by the existing portable decoder.
 * TEXT storage avoids SQLite/native integer rounding and permits every integer
 * it accepts, including zero, negatives and exponent notation. -0 equals 0 in
 * the existing JSON/Record<number,...> semantics. This is not a wire encoding. */
export function brc38ImportIncomingId(value: unknown): string {
  if (!Number.isInteger(value)) invalid()
  return String(value)
}
function incomingNumber(value: unknown): number {
  if (typeof value !== 'string' || value.length === 0 || value.length > 32) invalid()
  const number = Number(value)
  if (!Number.isInteger(number) || String(number) !== value) invalid()
  return number
}
function scopeCopy(input: unknown): Readonly<Brc38ImportMapScope> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid()
  const scope = input as Partial<Brc38ImportMapScope>
  if (
    typeof scope.importId !== 'string' ||
    typeof scope.bindingSha256 !== 'string' ||
    typeof scope.archiveSha256 !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(scope.importId) ||
    !/^[0-9a-f]{64}$/.test(scope.bindingSha256) ||
    !/^[0-9a-f]{64}$/.test(scope.archiveSha256) ||
    !destinationId(scope.userId)
  )
    invalid()
  return Object.freeze({
    importId: scope.importId,
    bindingSha256: scope.bindingSha256,
    archiveSha256: scope.archiveSha256,
    userId: scope.userId
  })
}
function referencesCopy(refs: readonly Brc38ImportIdReference[], map: SyncMap): References {
  if (!Array.isArray(refs)) invalid()
  if (refs.length > 4096) throw new SnapshotResourceLimitError('Private import page exceeds 4096 ID references')
  const wanted: References = new Map()
  for (const ref of refs) {
    if (
      ref === null ||
      typeof ref !== 'object' ||
      typeof ref.entity !== 'string' ||
      !Object.hasOwn(map, ref.entity) ||
      !Number.isInteger(ref.incomingId) ||
      typeof ref.required !== 'boolean'
    )
      invalid()
    const incomingId = brc38ImportIncomingId(ref.incomingId),
      values = wanted.get(ref.entity) ?? new Map<string, boolean>()
    values.set(incomingId, ref.required || values.get(incomingId) === true)
    wanted.set(ref.entity, values)
  }
  return wanted
}
function* batches<T>(values: Iterable<T>): Generator<T[]> {
  let batch: T[] = []
  for (const value of values) {
    batch.push(value)
    if (batch.length === 128) {
      yield batch
      batch = []
    }
  }
  if (batch.length > 0) yield batch
}
function boundedSqlId(k: Knex.Transaction): Knex.Raw {
  const field = 'localId'
  // Corrupt text/blob values never cross the native-to-JS boundary.
  return k.raw('CASE WHEN typeof(??) = ? AND ?? BETWEEN ? AND ? THEN ?? ELSE NULL END AS ??', [
    field,
    'integer',
    field,
    -Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
    field,
    field
  ])
}
function boundedIncomingId(k: Knex.Transaction): Knex.Raw {
  return k.raw(
    "CASE WHEN typeof(incomingId) = 'text' AND length(CAST(incomingId AS BLOB)) BETWEEN 1 AND 32 THEN incomingId ELSE NULL END AS incomingId"
  )
}
function validateLoaded(row: IdRow, values: ReadonlyMap<string, boolean>): void {
  incomingNumber(row.incomingId)
  if (!destinationId(row.localId) || !values.has(row.incomingId)) invalid()
}
function validatePrepared(
  map: SyncMap,
  wanted: References,
  known: ReadonlyMap<keyof SyncMap, ReadonlyMap<string, number>>
): void {
  let count = 0
  for (const entity of Object.keys(map) as Array<keyof SyncMap>) {
    const selected = wanted.get(entity)
    for (const key in map[entity].idMap) {
      const id = Number(key),
        localId = map[entity].idMap[id],
        original = known.get(entity)?.get(key)
      if (
        ++count > 4096 ||
        !Object.hasOwn(map[entity].idMap, key) ||
        !Number.isInteger(id) ||
        String(id) !== key ||
        !selected?.has(key) ||
        !destinationId(localId) ||
        (original !== undefined && original !== localId)
      )
        invalid()
    }
  }
  for (const [entity, values] of known) {
    for (const [id, localId] of values) if (map[entity].idMap[Number(id)] !== localId) invalid()
  }
}
function* additions(
  scope: Readonly<Brc38ImportMapScope>,
  map: SyncMap,
  wanted: References,
  known: ReadonlyMap<keyof SyncMap, ReadonlyMap<string, number>>
): Generator<MappingRow> {
  for (const [entity, values] of wanted) {
    for (const incomingId of values.keys()) {
      const selected = map[entity].idMap,
        localId = Object.hasOwn(selected, incomingId) ? selected[Number(incomingId)] : undefined
      if (localId !== undefined && !known.get(entity)?.has(incomingId)) yield { ...scope, entity, incomingId, localId }
    }
  }
}

function requireTransaction(value: unknown): void {
  if (typeof value !== 'function' || !('isTransaction' in value) || value.isTransaction !== true) invalid()
}

/** Internal bounded mapper for one already authenticated/locked import journal.
 * The caller supplies the actual destination transaction and commits rows,
 * mappings and the next cursor together. This helper does not install a schema,
 * authorize activation, merge a user, or modify legacy snapshot_sync_ids/maps.
 * References must be collected/deduplicated during bounded preparation before
 * writer ownership; at most 4096 are retained and SQL batches contain at most 128. */
export async function loadBrc38ImportIdMap(
  k: Knex.Transaction,
  scope: Brc38ImportMapScope,
  refs: readonly Brc38ImportIdReference[]
): Promise<{ map: SyncMap; persist: () => Promise<void> }> {
  requireTransaction(k)
  const owned = scopeCopy(scope),
    map = createSyncMap(),
    wanted = referencesCopy(refs, map),
    known = new Map<keyof SyncMap, Map<string, number>>()
  await runInSeries(wanted, async ([entity, values]) => {
    const found = new Map<string, number>()
    await runInSeries(batches(values.keys()), async batch => {
      const rows: IdRow[] = await k('brc38_import_ids')
        .select(boundedIncomingId(k), boundedSqlId(k))
        .where({ ...owned, entity })
        .whereIn('incomingId', batch)
      for (const row of rows) {
        validateLoaded(row, values)
        if (found.has(row.incomingId)) invalid()
        found.set(row.incomingId, row.localId)
        map[entity].idMap[Number(row.incomingId)] = row.localId
      }
    })
    for (const [id, required] of values) {
      if (required && !found.has(id))
        throw new Error('Private import parent mapping is missing from its durable checkpoint')
    }
    known.set(entity, found)
  })
  let consumed = false
  return {
    map,
    async persist() {
      if (consumed) throw new Error('Prepared private import mappings are already consumed')
      consumed = true
      validatePrepared(map, wanted, known)
      await runInSeries(batches(additions(owned, map, wanted, known)), async batch => {
        await k('brc38_import_ids').insert(batch)
      })
    }
  }
}
