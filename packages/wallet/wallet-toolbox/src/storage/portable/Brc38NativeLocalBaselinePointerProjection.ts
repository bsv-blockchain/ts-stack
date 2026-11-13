/** Canonical schema-definition data for a single current-parent point lookup.
 * This generator creates no schema or owner authority. Native execution still
 * requires its exact freshly installed source observer and genuine connection.
 * LIMIT 1 retains the historical scalar lookup's one-row selection; a missing
 * parent emits no event, and both pointer transitions mark the current parent. */
export function brc38NativeLocalBaselinePointerProjection(
  family: 'binary' | 'text',
  source: Readonly<{ id: number; table: string; key: string }>,
  tableId: number,
  event: 'INSERT' | 'DELETE'
): string {
  const context = event === 'INSERT' ? 'NEW' : 'OLD'
  return `CREATE TRIGGER brc38_local_baseline_packed_${family}_${source.id}_${event} AFTER ${event} ON brc38_native_${family}_fields WHEN ${context}.tableId=${source.id} BEGIN INSERT INTO brc38_local_baseline_event SELECT ${tableId},NULL,s.rowid,1 FROM ${source.table} s WHERE s.${source.key}=${context}.rowId LIMIT 1; END`
}
