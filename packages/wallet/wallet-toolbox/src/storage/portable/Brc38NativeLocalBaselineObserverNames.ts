import { brc38NativeLocalBaselineTables } from './Brc38NativeLocalBaselineTables'

/** Fresh baseline definition DATA only. Keep every event body and physical
 * source unchanged; a fixed inventory coordinate replaces the repeated source
 * name in the internal observer name. Complete schema checks still establish
 * the actual generation, and occupied generations retain their old names. */
export function brc38NativeLocalBaselineCompactObserverNames(definitions: readonly string[]): readonly string[] {
  const names = new Map<string, string>()
  for (const [id, table] of brc38NativeLocalBaselineTables.entries())
    for (const event of ['insert', 'delete', 'update'] as const)
      names.set(`brc38_local_baseline_${table}_${event}`, `brc38_local_baseline_s${id}_${event}`)
  return Object.freeze(
    definitions.map(sql => {
      const match = /^CREATE TRIGGER ([A-Za-z0-9_]+) AFTER /.exec(sql)
      const replacement = match === null ? undefined : names.get(match[1])
      return replacement === undefined ? sql : sql.replace(match![0], `CREATE TRIGGER ${replacement} AFTER `)
    })
  )
}
