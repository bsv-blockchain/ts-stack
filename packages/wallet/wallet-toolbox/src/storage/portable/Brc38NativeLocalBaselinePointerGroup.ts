/** Fresh schema DATA only. Exactly one fixed packed table ID can select a
 * current parent. UNION ALL shares the observer definition; LIMIT 1 preserves
 * the per-coordinate scalar lookup, including missing parents and physical
 * rowids. This function supplies no native/schema/owner authority. */
export function brc38NativeLocalBaselinePointerGroup(
  family: 'binary' | 'text',
  sources: readonly Readonly<{ id: number; table: string; key: string; tableId: number }>[],
  event: 'INSERT' | 'DELETE'
): string {
  const context = event === 'INSERT' ? 'NEW' : 'OLD'
  const select = sources
    .map(
      source =>
        `SELECT ${source.tableId},NULL,s.rowid,1 FROM ${source.table} s WHERE ${context}.tableId=${source.id} AND s.${source.key}=${context}.rowId`
    )
    .join(' UNION ALL ')
  return `CREATE TRIGGER brc38_local_baseline_packed_${family}_${event} AFTER ${event} ON brc38_native_${family}_fields BEGIN INSERT INTO brc38_local_baseline_event ${select} LIMIT 1; END`
}
