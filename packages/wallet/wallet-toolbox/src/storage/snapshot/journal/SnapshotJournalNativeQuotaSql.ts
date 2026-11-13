import type { SnapshotJournalQuotaTrigger } from './SnapshotJournalSharedQuota'

/** Source SQL generation only. These definitions carry no connection, owner,
 * admission or reusable schema verdict. Actual installation/guard checks are
 * separate and compare every complete definition on the current database. */
export const nativeQuotaEvent = 'snapshot_reconciliation_quota_event'
export const nativeQuotaApply = nativeQuotaEvent + '_apply'
export const nativeQuotaDispatchDdl = [
  `CREATE VIEW ${nativeQuotaEvent} AS SELECT 0 AS beforeBytes,0 AS afterBytes,0 AS rowDelta WHERE 0`,
  `CREATE TRIGGER ${nativeQuotaApply} INSTEAD OF INSERT ON ${nativeQuotaEvent} BEGIN UPDATE snapshot_reconciliation_shared_quota SET bytes=brc38_shared_quota_next_bytes(bytes,\`rows\`,changeBit,byteLimit,rowLimit,NEW.beforeBytes,NEW.afterBytes,NEW.rowDelta),\`rows\`=\`rows\`+NEW.rowDelta,changeBit=1-changeBit WHERE id=0; SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'Shared journal quota exhausted or inconsistent') END; END`
] as const

export interface NativeQuotaSource {
  table: string
  sql: string
  columns: string[]
}
export function nativeQuotaSources(ddl: readonly string[]): NativeQuotaSource[] {
  const sources: NativeQuotaSource[] = []
  for (const sql of ddl.filter(value => value.startsWith('CREATE TABLE '))) {
    const match = /^CREATE TABLE (snapshot_reconciliation_\w+)\((.*)\)$/.exec(sql)
    if (match === null) throw new Error('Unsupported native quota source definition')
    if (match[1] === 'snapshot_reconciliation_shared_quota') continue
    // The same fixed NOT NULL column/type grammar as the historical producer.
    // Nullable fields were not charged by that producer and remain unchanged.
    const columns = [
      ...match[2].matchAll(
        /(?:^|,)`?(\w+)`? (BIGINT|INTEGER|VARCHAR\([1-9]\d*\)|VARBINARY\([1-9]\d*\)|TEXT|MEDIUMTEXT|LONGBLOB|BLOB) NOT NULL/g
      )
    ].map(value => value[1])
    if (columns.length === 0 || columns.length > 32 || sources.some(source => source.table === match[1]))
      throw new Error('Unsupported native quota source columns')
    sources.push({ table: match[1], sql, columns })
  }
  return sources
}
export function nativeQuotaDispatchTriggers(ddl: readonly string[]): SnapshotJournalQuotaTrigger[] {
  return nativeQuotaSources(ddl).flatMap(({ table, columns }) => {
    const charge = (side: 'OLD' | 'NEW'): string =>
      'brc38_shared_row_charge(' + columns.map(column => `${side}."${column}"`).join(',') + ')'
    return (['INSERT', 'UPDATE', 'DELETE'] as const).map(event => {
      const before = event === 'INSERT' ? '0' : '(' + charge('OLD') + ')'
      const after = event === 'DELETE' ? '0' : '(' + charge('NEW') + ')'
      const delta = event === 'INSERT' ? 1 : event === 'DELETE' ? -1 : 0
      const name =
        'snapshot_reconciliation_quota_' + table.slice('snapshot_reconciliation_'.length) + '_' + event.toLowerCase()
      if (name.length > 64) throw new Error('Unsupported native quota source name')
      const body = `BEGIN INSERT INTO ${nativeQuotaEvent} VALUES(${before},${after},${delta}); END`
      return { name, table, event, body, sql: `CREATE TRIGGER ${name} AFTER ${event} ON ${table} ${body}` }
    })
  })
}
