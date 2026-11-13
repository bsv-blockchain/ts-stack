import type { Knex } from 'knex'
import { isOwnedNativeSqlite } from '../../schema/ownedNativeSqliteRuntimeNode'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'

type Family = 'binary' | 'text'
const coordinates = {
  binary: [
    [0, 0, 'transactions', 'transactionId'],
    [1, 8, 'proven_txs', 'provenTxId'],
    [2, 9, 'proven_tx_reqs', 'provenTxReqId'],
    [3, 1, 'outputs', 'outputId'],
    [4, 6, 'commissions', 'commissionId']
  ],
  text: [
    [0, 0, 'transactions', 'transactionId'],
    [2, 9, 'proven_tx_reqs', 'provenTxReqId'],
    [3, 1, 'outputs', 'outputId'],
    [4, 6, 'commissions', 'commissionId'],
    [5, 7, 'sync_states', 'syncStateId'],
    [6, 2, 'certificates', 'certificateId'],
    [7, 12, 'certificate_fields', 'rowid']
  ]
} as const
const events = ['INSERT', 'DELETE'] as const
const groupedPrefix = 'snapshot_journal_packed_grouped_'
const quoted = (name: string): string => '"' + name + '"'
function invalid(): never {
  throw new WERR_INVALID_OPERATION('Invalid or unowned SQLite snapshot journal generation')
}
function originals(family: Family): string[] {
  return coordinates[family].flatMap(([id, tableId, table, key]) =>
    events.map(event => {
      const context = event === 'INSERT' ? 'NEW' : 'OLD',
        source = key === 'rowid' ? table : quoted(table),
        field = key === 'rowid' ? key : quoted(key)
      return `CREATE TRIGGER snapshot_journal_packed_${family === 'text' ? 'text_' : ''}${id}_${event} AFTER ${event} ON brc38_native_${family}_fields WHEN ${context}.tableId=${id} AND EXISTS(SELECT 1 FROM ${source} s WHERE s.${field}=${context}.rowId) BEGIN INSERT INTO snapshot_journal_pointer_event VALUES(${tableId},${context}.rowId); END`
    })
  )
}
function grouped(family: Family): string[] {
  return events.map(event => {
    const context = event === 'INSERT' ? 'NEW' : 'OLD',
      select = coordinates[family]
        .map(([id, tableId, table, key]) => {
          const source = key === 'rowid' ? table : quoted(table),
            field = key === 'rowid' ? key : quoted(key)
          return `SELECT ${tableId},${context}.rowId FROM ${source} s WHERE ${context}.tableId=${id} AND s.${field}=${context}.rowId`
        })
        .join(' UNION ALL ')
    return `CREATE TRIGGER ${groupedPrefix}${family}_${event} AFTER ${event} ON brc38_native_${family}_fields BEGIN INSERT INTO snapshot_journal_pointer_event ${select} LIMIT 1; END`
  })
}

/** Fixed definition DATA only. A complete original positional family is
 * required: partial, altered, duplicate or unknown pointer definitions refuse.
 * Only one packed tableId can select a parent. Its original unique key or
 * physical rowid and LIMIT1 retain the original EXISTS and scalar event. */
export function snapshotJournalGroupedPointerSql(definitions: readonly string[]): readonly string[] {
  const pointers = definitions.filter(sql => sql.startsWith('CREATE TRIGGER snapshot_journal_packed_')),
    selected = new Map<Family, string[]>(),
    known = new Set<string>()
  for (const family of ['binary', 'text'] as const) {
    const expected = originals(family),
      actual = pointers.filter(sql => expected.includes(sql))
    if (actual.length === 0) continue
    if (actual.length !== expected.length || new Set(actual).size !== expected.length) invalid()
    selected.set(family, grouped(family))
    for (const sql of expected) known.add(sql)
  }
  if (pointers.some(sql => !known.has(sql))) invalid()
  const emitted = new Set<Family>(),
    result: string[] = []
  for (const sql of definitions) {
    if (!known.has(sql)) {
      result.push(sql)
      continue
    }
    const family = sql.startsWith('CREATE TRIGGER snapshot_journal_packed_text_') ? 'text' : 'binary'
    if (!emitted.has(family)) result.push(...selected.get(family)!)
    emitted.add(family)
  }
  return Object.freeze(result)
}

/** The complete plan's reserved/source/ownership checks still admit every
 * object. This selects DATA from a genuine native view: fresh generations use
 * original individual emitters; occupied generations retain their exact SQL.
 * An occupied group must match the whole fixed family before selection. */
export async function snapshotJournalNativePointerDefinitions(
  k: Knex,
  definitions: readonly string[]
): Promise<readonly string[]> {
  if (!isOwnedNativeSqlite(k)) return definitions
  if (!k.isTransaction) invalid()
  const candidate = snapshotJournalGroupedPointerSql(definitions),
    expected = new Map(
      candidate
        .filter(sql => sql.startsWith('CREATE TRIGGER ' + groupedPrefix))
        .map(sql => [/^CREATE TRIGGER (\w+)/.exec(sql)![1], sql])
    ),
    rows: Array<{ type: string; name: string; sql: unknown }> = await k('main.sqlite_schema')
      .whereRaw('lower(substr(name,1,?))=?', [groupedPrefix.length, groupedPrefix])
      .select('type', 'name', k.raw('CASE WHEN length(CAST(sql AS BLOB))<=4096 THEN sql END AS sql'))
      .limit(5)
  if (rows.length !== 0) {
    if (rows.length !== expected.size || rows.some(row => row.type !== 'trigger' || expected.get(row.name) !== row.sql))
      invalid()
    return candidate
  }
  return definitions
}
