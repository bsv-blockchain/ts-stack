import type { Knex } from 'knex'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import type { Brc38NativeLocalBaselineRow } from './Brc38NativeLocalBaselineSourceNode'
import { brc38WorkingAllocation, type Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { brc38NativeLocalBaselineTables } from './Brc38NativeLocalBaselineTables'

function invalid(): never {
  throw new Error('Private local unique-key comparison differs from actual bounded schema or complete metadata')
}
/** Relationship storage preflight only. Inspect actual SQLite unique indexes,
 * their real collations and complete source metadata; matching keys do not
 * admit fields, source identity or candidate semantics. The caller retains
 * the genuine source row and rechecks its private writer before mutation. */
export async function brc38PrivateLocalUniqueConflict(
  store: KnexBrc38StagingStore,
  k: Knex.Transaction,
  row: Readonly<Pick<Brc38NativeLocalBaselineRow, 'table' | 'rowId' | 'metadata'>>,
  selected: Readonly<{ workingAllocation: Brc38WorkingAllocation; expiresAt: number; signal?: AbortSignal }>,
  writer = false
): Promise<boolean> {
  const working = brc38WorkingAllocation(selected.workingAllocation),
    expiresAt = selected.expiresAt,
    signal = selected.signal,
    deadline = performance.now() + Math.max(0, expiresAt - Date.now())
  if (
    working === undefined ||
    working.maximum > store.limits.maximumRowAllocationBytes ||
    expiresAt !== store.operationExpiresAt
  )
    invalid()
  const check = (): void => {
    signal?.throwIfAborted()
    if (Date.now() >= expiresAt || performance.now() >= deadline) invalid()
    if (writer) store.assertPrivateNativeWriteTransaction(k)
    else store.assertPrivateNativeReadTransaction(k)
  }
  check()
  if (!brc38NativeLocalBaselineTables.includes(row.table) || !Number.isSafeInteger(row.rowId)) invalid()
  let bytes = 0
  for (const value of Object.values(row.metadata)) {
    if (typeof value === 'string') bytes += Buffer.byteLength(value)
    else if (value instanceof Uint8Array) bytes += value.byteLength
    else bytes += 8
    if (bytes > 131072) invalid()
  }
  const charge = working.claim(1048576 + 32 * bytes)
  try {
    const indexes = (await k.raw(
      `SELECT CASE WHEN length(CAST(name AS BLOB))<=128 THEN name END AS name,
      "unique" AS isUnique,partial FROM pragma_index_list(?) WHERE "unique"=1 LIMIT 65`,
      [row.table]
    )) as Array<{ name: string | null; isUnique: number; partial: number }>
    if (indexes.length > 64) invalid()
    for (const index of indexes) {
      if (
        typeof index.name !== 'string' ||
        !/^[A-Za-z0-9_]+$/.test(index.name) ||
        index.isUnique !== 1 ||
        index.partial !== 0
      )
        invalid()
      const columns = (await k.raw(
        `SELECT seqno,cid,CASE WHEN length(CAST(name AS BLOB))<=128 THEN name END AS name,
        CASE WHEN length(CAST(coll AS BLOB))<=16 THEN coll END AS coll FROM pragma_index_xinfo(?) WHERE key=1 ORDER BY seqno LIMIT 129`,
        [index.name]
      )) as Array<{ seqno: number; cid: number; name: string | null; coll: string | null }>
      if (
        columns.length < 1 ||
        columns.length > 128 ||
        columns.some(
          (column, ordinal) =>
            column.seqno !== ordinal ||
            column.cid < 0 ||
            typeof column.name !== 'string' ||
            !/^[A-Za-z][A-Za-z0-9_]*$/.test(column.name) ||
            !['BINARY', 'NOCASE', 'RTRIM'].includes(column.coll ?? '') ||
            !Object.hasOwn(row.metadata, column.name)
        )
      )
        invalid()
      // SQLite permits multiple UNIQUE entries whenever a key component is NULL.
      if (columns.some(column => row.metadata[column.name!] === null)) continue
      const query = k(row.table).whereRaw('rowid<>CAST(? AS INTEGER)', [BigInt(row.rowId).toString()])
      for (const column of columns) {
        const value = row.metadata[column.name!]
        if (
          typeof value !== 'string' &&
          typeof value !== 'bigint' &&
          !(value instanceof Uint8Array) &&
          (typeof value !== 'number' || !Number.isFinite(value))
        )
          invalid()
        query.whereRaw(
          '?? COLLATE ' + column.coll! + ' = ' + (typeof value === 'bigint' ? 'CAST(? AS INTEGER)' : '?'),
          [
            column.name!,
            typeof value === 'bigint'
              ? value.toString()
              : value instanceof Uint8Array
                ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
                : value
          ]
        )
      }
      const matches = (await query.select(k.raw('CAST(rowid AS TEXT) AS physical')).limit(2)) as Array<{
        physical: string
      }>
      if (
        matches.length > 1 ||
        matches.some(
          match =>
            !/^-?(?:0|[1-9]\d{0,15})$/.test(match.physical) ||
            BigInt(match.physical) < -9007199254740991n ||
            BigInt(match.physical) > 9007199254740991n
        )
      )
        invalid()
      if (matches.length === 1) return true
      check()
    }
    check()
    return false
  } finally {
    charge.close()
  }
}
