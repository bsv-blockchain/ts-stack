import { runInSeries } from '../../utility/runInSeries'
import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
import type { Knex } from 'knex'
import { readSqliteIdentityObservations, type SqliteIdentityObservation } from './snapshotSqliteIdentityObservations'
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
  const identities: IdentityDefinition[] = []
  await runInSeries(sources.entries(), async ([index, source]) => {
    const selected = observed?.[index]
    identities.push(await readIdentityCurrent(k, source, selected?.table === source.table ? selected : undefined))
  })
  return identities
}

async function readIdentityCurrent(
  k: Knex,
  source: SourceIdentity,
  observed?: SqliteIdentityObservation
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
  await runInSeries(
    indexes.filter(index => index.unique !== 0),
    async index => {
      if (index.partial !== 0) throw new WERR_INVALID_OPERATION('Unsupported partial unique identity')
      const metadata: Array<{
        name: string | null
        coll: string
        key: number
      }> = await k.raw('PRAGMA index_xinfo(??)', [index.name])
      const parts = metadata.filter(part => part.key !== 0)
      if (
        parts.length === 0 ||
        parts.some(part => part.name === null || !['BINARY', 'NOCASE', 'RTRIM'].includes(part.coll))
      )
        throw new WERR_INVALID_OPERATION('Unsupported unique identity comparison')
      unique.push(parts.map(part => ({ name: part.name!, collation: part.coll })))
    }
  )
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
function merge(identity: IdentityDefinition, selection: string): string {
  const columns = identity.columns.map(column => quote(column.name))
  const changed = columns.map(column => `${column} IS NOT excluded.${column}`).join(' OR ')
  // A nested source trigger can expose a new owner before the outer trigger
  // consumes the old one. Preserve both until membership cleanup runs.
  const primary = [identity.source.key, ...(identity.source.owner ? [identity.source.owner] : [])]
  const assignments = columns.map(column => `${column}=excluded.${column}`).join(',')
  return `INSERT INTO ${quote(identity.table)} (${columns.join(',')}) ${selection} ON CONFLICT(${primary.map(quote).join(',')}) DO UPDATE SET ${assignments} WHERE ${changed};`
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
