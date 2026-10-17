/** Internal spelling DATA only. The complete SQL family still establishes
 * schema identity; this noncryptographic name digest never grants authority.
 * Names stay stable when unrelated observers are added or reordered. */
export function brc38NativePackedObserverName(kind: 'binary' | 'text', name: string): string {
  const prefix = `brc38_native_${kind}_`,
    suffix = name.slice(prefix.length)
  if (!name.startsWith(prefix) || !/^[A-Za-z0-9_]+$/.test(suffix) || /^o[0-9a-f]{8}$/.test(suffix))
    throw new Error('Packed observer original name differs')
  // These anchors are inspected or rewritten by the existing family builders.
  if (
    /^fields_(row|move)_\d+$/.test(suffix) ||
    suffix === 'versions_update_guard' ||
    suffix.startsWith('journal_quota_')
  )
    return name
  let digest = 2166136261
  for (let i = 0; i < name.length; i++) digest = Math.imul(digest ^ name.charCodeAt(i), 16777619) >>> 0
  return prefix + 'o' + digest.toString(16).padStart(8, '0')
}

/** Change only CREATE TRIGGER names. Every timing, UPDATE OF list, predicate,
 * statement, error, table/index definition and source coordinate stays exact.
 * Occupied original families remain separate and are never rewritten. */
export function brc38NativePackedObserverNames(
  kind: 'binary' | 'text',
  definitions: readonly string[]
): readonly string[] {
  const originals = new Set<string>(),
    selected = new Set<string>()
  return Object.freeze(
    definitions.map(sql => {
      const object = /^CREATE (TABLE|INDEX|TRIGGER) ([A-Za-z0-9_]+)(?=\s|\()/.exec(sql)
      if (object === null || originals.has(object[2])) throw new Error('Packed observer source names differ')
      originals.add(object[2])
      const name = object[1] === 'TRIGGER' ? brc38NativePackedObserverName(kind, object[2]) : object[2]
      if (selected.has(name)) throw new Error('Packed observer compact name collision')
      selected.add(name)
      return name === object[2] ? sql : `CREATE TRIGGER ${name}` + sql.slice(object[0].length)
    })
  )
}
