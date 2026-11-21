/** Bounded DDL transformation DATA for a fresh, owned private candidate only.
 * Column definitions/constraints are retained verbatim. The actual migration
 * independently checks empty tables, native ownership and equivalent schema. */
export function brc38NativeTailLayout(
  sql: string,
  table: string,
  temporary: string,
  columns: readonly string[],
  binaries: readonly string[]
): string {
  const identifier = /^[A-Za-z][A-Za-z0-9_]*$/
  if (
    sql.length > 65536 ||
    !identifier.test(table) ||
    !identifier.test(temporary) ||
    columns.length > 128 ||
    binaries.length < 1 ||
    binaries.length > 3 ||
    columns.some(value => !identifier.test(value)) ||
    new Set(columns).size !== columns.length ||
    new Set(binaries).size !== binaries.length ||
    binaries.some(value => !columns.includes(value))
  )
    throw new Error('Private native tail layout exceeds its fixed schema')
  const prefix = /^CREATE TABLE\s+(?:`([^`]+)`|"([^"]+)"|([A-Za-z][A-Za-z0-9_]*))\s*\(/i.exec(sql)
  if (prefix === null || (prefix[1] ?? prefix[2] ?? prefix[3]) !== table || !/\)\s*$/.test(sql))
    throw new Error('Private native tail layout requires ordinary owned table DDL')
  const body = sql.slice(prefix[0].length, sql.lastIndexOf(')')),
    parts: string[] = []
  let start = 0,
    depth = 0,
    quote = ''
  for (let at = 0; at < body.length; at++) {
    const value = body[at]
    if (quote !== '') {
      const terminal = quote === '[' ? ']' : quote
      if (value === terminal) {
        if (body[at + 1] === terminal) at++
        else quote = ''
      }
    } else if (value === "'" || value === '"' || value === '`' || value === '[') quote = value
    else if (value === '(') depth++
    else if (value === ')') {
      if (depth-- < 1) throw new Error('Unbalanced native layout DDL')
    } else if (value === ',' && depth === 0) {
      parts.push(body.slice(start, at).trim())
      start = at + 1
    } else if ((value === '-' && body[at + 1] === '-') || (value === '/' && body[at + 1] === '*') || value === ';')
      throw new Error('Unsupported native layout DDL token')
  }
  if (depth !== 0 || quote !== '') throw new Error('Unbalanced native layout DDL')
  parts.push(body.slice(start).trim())
  if (parts.length > 256 || parts.some(value => value === ''))
    throw new Error('Native layout DDL exceeds its fixed schema')
  const definitions = new Map<string, string>(),
    constraints: string[] = []
  for (const part of parts) {
    const first = /^(?:`([^`]+)`|"([^"]+)"|([A-Za-z][A-Za-z0-9_]*))\s/.exec(part),
      name = first?.[1] ?? first?.[2] ?? first?.[3]
    if (name !== undefined && columns.includes(name)) {
      if (definitions.has(name)) throw new Error('Duplicate native layout column')
      definitions.set(name, part)
    } else if (/^(?:CONSTRAINT\s|FOREIGN\s+KEY\s*\(|PRIMARY\s+KEY\s*\(|UNIQUE\s*\(|CHECK\s*\()/i.test(part))
      constraints.push(part)
    else throw new Error('Unexpected native layout definition')
  }
  if (definitions.size !== columns.length) throw new Error('Native layout columns differ')
  const ordered = [...columns.filter(name => !binaries.includes(name)), ...binaries]
  return `CREATE TABLE "${temporary}" (${[...ordered.map(name => definitions.get(name)!), ...constraints].join(', ')})`
}
