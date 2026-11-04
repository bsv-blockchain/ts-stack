import { runInSeries } from '../../utility/runInSeries'
import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
import type { Knex } from 'knex'
import {
  readSqliteIdentityObservations,
  readSqliteIndexObservations,
  type SqliteIdentityObservation,
  type SqliteIndexObservation
} from './snapshotSqliteIdentityObservations'
// Metadata-bound conflict witnesses are maintained by the additive SQLite generation.
export interface SourceIdentity {
  table: string
  key: string
  owner?: string
}
interface Part {
  name: string
  collation: string
}
interface Column {
  name: string
  type: string
  pk: number
  hidden: number
}
export interface IdentityDefinition {
  source: SourceIdentity
  table: string
  columns: Column[]
  unique: Part[][]
  /** Derived storage coordinates only; never source or ownership authority. */
  sharedStorage?: { tag: number; columns: string[]; indexes: string[] }
}
const quote = (name: string): string => '"' + name.replaceAll('"', '""') + '"'
export async function readIdentity(k: Knex, source: SourceIdentity): Promise<IdentityDefinition> {
  return await readIdentityCurrent(k, source)
}

/** Fresh source metadata is scoped to this one construction. No caller can
 * supply observations or reuse them as generation/commit authority. */
export async function readIdentities(k: Knex, sources: SourceIdentity[]): Promise<IdentityDefinition[]> {
  const observed = await readSqliteIdentityObservations(
    k,
    sources.map(source => source.table)
  )
  // These are fresh DATA rows from this construction, never a retained schema
  // verdict. Group parts across tables under the same sixteen-name bound.
  // An unsupported primary or partial constraint keeps the original ordered
  // individual path so later metadata cannot replace its first refusal.
  let parts: Map<string, SqliteIndexObservation> | undefined
  if (
    observed !== undefined &&
    sources.every((source, position) => {
      const value = observed[position],
        primary = value?.columns.filter(column => column.pk !== 0)
      return (
        value?.table === source.table &&
        primary?.length === 1 &&
        primary[0].name === source.key &&
        primary[0].type.toLowerCase() === 'integer' &&
        value.indexes.every(index => index.unique === 0 || index.partial === 0)
      )
    })
  ) {
    const names = [
      ...new Set(observed.flatMap(value => value.indexes.filter(index => index.unique !== 0).map(index => index.name)))
    ]
    parts = new Map()
    for (let offset = 0; offset < names.length; offset += 16) {
      const group = await readSqliteIndexObservations(k, names.slice(offset, offset + 16))
      if (group === undefined) {
        parts = undefined
        break
      }
      for (const observation of group) parts.set(observation.name, observation)
    }
  }
  const identities: IdentityDefinition[] = []
  await runInSeries(sources.entries(), async ([index, source]) => {
    const selected = observed?.[index]
    identities.push(
      await readIdentityCurrent(k, source, selected?.table === source.table ? selected : undefined, parts)
    )
  })
  return identities
}

async function readIdentityCurrent(
  k: Knex,
  source: SourceIdentity,
  observed?: SqliteIdentityObservation,
  currentParts?: ReadonlyMap<string, SqliteIndexObservation>
): Promise<IdentityDefinition> {
  const columns: Column[] = observed?.columns ?? (await k.raw('PRAGMA table_xinfo(??)', [source.table]))
  const primary = columns.filter(column => column.pk !== 0)
  if (primary.length !== 1 || primary[0].name !== source.key || primary[0].type.toLowerCase() !== 'integer')
    throw new WERR_INVALID_OPERATION('Unsupported numeric identity')
  const indexes: Array<{
    name: string
    unique: number
    partial: number
  }> = observed?.indexes ?? (await k.raw('PRAGMA index_list(??)', [source.table]))
  const unique: Part[][] = []
  const uniqueIndexes = indexes.filter(index => index.unique !== 0)
  // Partial constraints retain the original individual reads and first-error
  // ordering. The public single-identity reader also retains that legacy path.
  const observedParts =
    observed !== undefined && currentParts !== undefined
      ? uniqueIndexes.map(index => currentParts.get(index.name))
      : observed !== undefined && uniqueIndexes.every(index => index.partial === 0)
        ? await readSqliteIndexObservations(
            k,
            uniqueIndexes.map(index => index.name)
          )
        : undefined
  await runInSeries(uniqueIndexes.entries(), async ([position, index]) => {
    if (index.partial !== 0) throw new WERR_INVALID_OPERATION('Unsupported partial unique identity')
    const metadata: Array<{
      name: string | null
      coll: string
      key: number
    }> =
      observedParts?.[position]?.name === index.name
        ? observedParts[position].parts
        : await k.raw('PRAGMA index_xinfo(??)', [index.name])
    const parts = metadata.filter(part => part.key !== 0)
    if (
      parts.length === 0 ||
      parts.some(part => part.name === null || !['BINARY', 'NOCASE', 'RTRIM'].includes(part.coll))
    )
      throw new WERR_INVALID_OPERATION('Unsupported unique identity comparison')
    unique.push(parts.map(part => ({ name: part.name!, collation: part.coll })))
  })
  const names = new Set([
    source.key,
    ...(source.owner ? [source.owner] : []),
    ...unique.flatMap(parts => parts.map(part => part.name))
  ])
  const selected = [...names].map(name => columns.find(column => column.name === name))
  if (
    selected.some(
      column => column?.hidden !== 0 || !/^(integer|bigint|boolean|varchar\([1-9]\d*\))$/i.test(column.type)
    )
  )
    throw new WERR_INVALID_OPERATION('Unsupported identity column')
  return {
    source,
    table: 'snapshot_identity_' + source.table,
    columns: selected as Column[],
    unique
  }
}
export function identityDDL(identity: IdentityDefinition): string[] {
  const primary = [identity.source.key, ...(identity.source.owner ? [identity.source.owner] : [])]
  const fields = identity.columns.map(
    column => `${quote(column.name)} ${column.type}${primary.includes(column.name) ? ' NOT NULL' : ''}`
  )
  return [
    `CREATE TABLE ${quote(identity.table)} (${fields.join(',')},PRIMARY KEY (${primary.map(quote).join(',')}))`,
    ...identity.unique.map(
      (parts, index) =>
        `CREATE INDEX ${quote(identity.table + '_' + index)} ON ${quote(identity.table)} (${parts.map(part => quote(part.name) + ' COLLATE ' + part.collation).join(',')})`
    )
  ]
}
export const sharedIdentityTable = 'snapshot_identity_witnesses_v2'
/** Share only the derived witness roots. Slots retain each declared affinity;
 * source tags keep unrelated key/owner/unique comparisons independent. Larger
 * source shapes retain the original layout rather than widening SQLite limits. */
export function sharedIdentityLayout(
  definitions: IdentityDefinition[]
): { definitions: IdentityDefinition[]; ddl: string[] } | undefined {
  const slots = new Map<string, string[]>(),
    fields: Array<{ name: string; type: string }> = [],
    planned: IdentityDefinition[] = []
  if (definitions.length === 0 || definitions.length > 10) return undefined
  for (const [tag, identity] of definitions.entries()) {
    if (
      identity.source.owner !== undefined &&
      !['integer', 'bigint'].includes(
        identity.columns.find(column => column.name === identity.source.owner)?.type.toLowerCase() ?? ''
      )
    )
      return undefined
    const ordinals = new Map<string, number>(),
      columns: string[] = []
    for (const column of identity.columns) {
      if (column.name === identity.source.key) columns.push('id')
      else if (column.name === identity.source.owner) columns.push('owner')
      else {
        const type = column.type.toLowerCase(),
          ordinal = ordinals.get(type) ?? 0,
          group = slots.get(type) ?? []
        ordinals.set(type, ordinal + 1)
        if (group[ordinal] === undefined) {
          group.push('v' + fields.length)
          fields.push({ name: group[ordinal], type: column.type })
          slots.set(type, group)
        }
        columns.push(group[ordinal])
      }
    }
    planned.push({ ...identity, sharedStorage: { tag, columns, indexes: [] } })
  }
  if (fields.length > 1997) return undefined
  const ddl = [
    `CREATE TABLE ${quote(sharedIdentityTable)} (tag INTEGER NOT NULL,id INTEGER NOT NULL,owner INTEGER NOT NULL,${fields.map(field => quote(field.name) + ' ' + field.type).join(',')}${fields.length === 0 ? '' : ','}PRIMARY KEY (tag,id,owner)) WITHOUT ROWID`
  ]
  // Tag is always the leading indexed column. Identical physical column/order/
  // collation shapes can share that tree without comparing unrelated sources.
  const indexes = new Map<string, string>()
  for (const identity of planned)
    for (const [index, parts] of identity.unique.entries()) {
      const shape = parts.map(part => storedColumn(identity, part.name) + ' COLLATE ' + part.collation).join(',')
      let name = indexes.get(shape)
      if (name === undefined) {
        name = identity.table + '_' + index
        indexes.set(shape, name)
        ddl.push(`CREATE INDEX ${quote(name)} ON ${quote(sharedIdentityTable)} (tag,${shape})`)
      }
      identity.sharedStorage!.indexes.push(name)
    }
  return ddl.some(sql => Buffer.byteLength(sql, 'utf8') > 65536) ? undefined : { definitions: planned, ddl }
}
function storedColumn(identity: IdentityDefinition, name: string): string {
  if (identity.sharedStorage === undefined) return quote(name)
  const index = identity.columns.findIndex(column => column.name === name),
    mapped = identity.sharedStorage.columns[index]
  if (index < 0 || mapped === undefined) throw new WERR_INVALID_OPERATION('Missing shared witness column')
  return quote(mapped)
}
function witnessTable(identity: IdentityDefinition): string {
  return quote(identity.sharedStorage === undefined ? identity.table : sharedIdentityTable)
}
function witnessPredicate(identity: IdentityDefinition, predicate: string): string {
  return identity.sharedStorage === undefined ? predicate : `tag=${identity.sharedStorage.tag} AND (${predicate})`
}
/** SQL unique equality deliberately excludes NULL, as the source constraint does. */
function conflicts(identity: IdentityDefinition, updated: boolean): string {
  const key = quote(identity.source.key)
  return [
    `${key}=NEW.${key}`,
    ...(updated ? [`${key}=OLD.${key}`] : []),
    ...identity.unique.map(
      parts =>
        '(' +
        parts.map(part => `${quote(part.name)} COLLATE ${part.collation}=NEW.${quote(part.name)}`).join(' AND ') +
        ')'
    )
  ].join(' OR ')
}
function merge(identity: IdentityDefinition, selection: string, compactKeys = false): string {
  const columns = identity.columns.map(column => storedColumn(identity, column.name))
  // A nested source trigger can expose a new owner before the outer trigger
  // consumes the old one. Preserve both until membership cleanup runs.
  const primary =
    identity.sharedStorage === undefined
      ? [identity.source.key, ...(identity.source.owner ? [identity.source.owner] : [])].map(quote)
      : ['tag', 'id', 'owner']
  // A BINARY, non-NULL primary-key conflict already proves equality of these
  // cells. Keep the original UPSERT for nested writes, but omit self-assignments
  // and impossible key-change predicates only in the fresh native family.
  const keys = new Set(identity.sharedStorage === undefined ? primary : primary.map(quote)),
    updates = compactKeys ? columns.filter(column => !keys.has(column)) : columns,
    changed = updates.map(column => `${column} IS NOT excluded.${column}`).join(' OR '),
    assignments = updates.map(column => `${column}=excluded.${column}`).join(',')
  const shared = identity.sharedStorage
  const inserted = shared === undefined ? columns : ['tag', ...(identity.source.owner ? [] : ['owner']), ...columns]
  const selected =
    shared === undefined
      ? selection
      : selection.replace(/^SELECT /, `SELECT ${shared.tag},${identity.source.owner ? '' : '0,'}`)
  const conflict = updates.length === 0 ? 'DO NOTHING' : `DO UPDATE SET ${assignments} WHERE ${changed}`
  return `INSERT INTO ${witnessTable(identity)} (${inserted.join(',')}) ${selected} ON CONFLICT(${primary.join(',')}) ${conflict};`
}

/** Observe existing rows only. An ignored source write cannot remove ownership. */
export function observeIdentity(identity: IdentityDefinition, updated: boolean): string {
  const columns = identity.columns.map(column => quote(column.name)).join(',')
  return merge(identity, `SELECT ${columns} FROM ${quote(identity.source.table)} WHERE ${conflicts(identity, updated)}`)
}
/** Evaluated after the successful source operation, before the witness changes. */
export function displacedIdentity(identity: IdentityDefinition, updated: boolean): string {
  return `SELECT ${quote(identity.source.key)}${identity.source.owner ? ',' + quote(identity.source.owner) : ''} FROM ${quote(identity.table)} WHERE ${conflicts(identity, updated)}`
}
/** Direct retirement projection for the fresh native observer layout. The
 * historical wrapper remains unchanged. Both projections use the same SQL
 * comparison predicate, including source collations and NULL semantics. */
export function retirementProjection(
  identity: IdentityDefinition,
  event: 'INSERT' | 'UPDATE' | 'DELETE',
  owners: boolean
): string {
  const columns = owners && identity.source.owner ? [identity.source.owner, identity.source.key] : [identity.source.key]
  return event === 'DELETE'
    ? 'SELECT ' + columns.map(column => `OLD.${quote(column)} AS ${quote(column)}`).join(',')
    : `SELECT ${columns.map(quote).join(',')} FROM ${quote(identity.table)} WHERE ${conflicts(identity, event === 'UPDATE')}`
}
/** Fixed event-view columns carry the source cells, not an authority verdict.
 * Event 1/2/3 is INSERT/UPDATE/DELETE. Keep source unique equality, collations
 * and SQL NULL semantics identical to the ordinary conflict witness. */
function sharedCell(identity: IdentityDefinition, column: string, prior = false): string {
  const ordinal = identity.columns.findIndex(value => value.name === column)
  if (ordinal < 0) throw new WERR_INVALID_OPERATION('Missing shared identity source column')
  return `NEW.${prior ? 'o' : 'n'}${ordinal}`
}
function sharedConflicts(identity: IdentityDefinition, stored = false): string {
  const column = (name: string) => (stored ? storedColumn(identity, name) : quote(name))
  const key = column(identity.source.key)
  return [
    `${key}=${sharedCell(identity, identity.source.key)}`,
    `(NEW.event=2 AND ${key}=${sharedCell(identity, identity.source.key, true)})`,
    ...identity.unique.map(
      parts =>
        '(' +
        parts
          .map(part => `${column(part.name)} COLLATE ${part.collation}=${sharedCell(identity, part.name)}`)
          .join(' AND ') +
        ')'
    )
  ].join(' OR ')
}
/** Source observations run in the original BEFORE position. Event cells carry
 * the actual NEW/OLD values; unique equality still excludes NULL and uses the
 * freshly inspected source collations. The same witness merge owns affinity. */
export function observeSharedIdentity(identity: IdentityDefinition, compactKeys = false): string {
  const columns = identity.columns.map(column => quote(column.name)).join(',')
  return merge(
    identity,
    `SELECT ${columns} FROM ${quote(identity.source.table)} WHERE ${sharedConflicts(identity)}`,
    compactKeys
  )
}
export function sharedRetirementProjection(identity: IdentityDefinition, owners: boolean): string {
  const columns = owners && identity.source.owner ? [identity.source.owner, identity.source.key] : [identity.source.key]
  const projected = columns
    .map(name =>
      identity.sharedStorage === undefined ? quote(name) : `${storedColumn(identity, name)} AS ${quote(name)}`
    )
    .join(',')
  return (
    'SELECT ' +
    columns.map(column => `${sharedCell(identity, column, true)} AS ${quote(column)}`).join(',') +
    ` WHERE NEW.event=3 UNION ALL SELECT ${projected} FROM ${witnessTable(identity)} WHERE ${witnessPredicate(identity, `NEW.event<>3 AND (${sharedConflicts(identity, true)})`)}`
  )
}
/** Same final witness removal and live-row merge, after every membership
 * family consumes the retirement projection in its original statement order. */
export function finishSharedIdentity(identity: IdentityDefinition, compactKeys = false): string {
  const key = storedColumn(identity, identity.source.key),
    remove = `(NEW.event=3 AND ${key}=${sharedCell(identity, identity.source.key, true)}) OR (NEW.event<>3 AND (${sharedConflicts(identity, true)}))`,
    columns = identity.columns.map(column => quote(column.name)).join(',')
  return (
    `DELETE FROM ${witnessTable(identity)} WHERE ${witnessPredicate(identity, remove)}; ` +
    merge(
      identity,
      `SELECT ${columns} FROM ${quote(identity.source.table)} WHERE ${quote(identity.source.key)}=NEW.${quote(identity.source.key)}`,
      compactKeys
    )
  )
}

/** Run only after all affected membership families consume displacedIdentity. */
export function finishIdentity(identity: IdentityDefinition, event: 'INSERT' | 'UPDATE' | 'DELETE'): string {
  const key = quote(identity.source.key)
  const row = event === 'DELETE' ? 'OLD' : 'NEW'
  const remove = event === 'DELETE' ? `${key}=OLD.${key}` : conflicts(identity, event === 'UPDATE')
  const columns = identity.columns.map(column => quote(column.name)).join(',')
  return (
    `DELETE FROM ${quote(identity.table)} WHERE ${remove}; ` +
    merge(identity, `SELECT ${columns} FROM ${quote(identity.source.table)} WHERE ${key}=${row}.${key}`)
  )
}
