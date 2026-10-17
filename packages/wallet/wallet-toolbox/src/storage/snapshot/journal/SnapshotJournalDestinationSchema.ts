import { snapshotJournalQuotaLayout } from './SnapshotJournalNativeQuotaLayout'
import { brc38SqliteDefinitionBatches, readBrc38SqliteDefinitionBatch } from '../../portable/Brc38SqlFieldSchemaBatch'
import { isOwnedNativeSqlite } from '../../schema/ownedNativeSqliteRuntimeNode'
import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { snapshotJournalDestinationWindowDdl } from './SnapshotJournalDestinationWindow'
import { snapshotJournalDestinationStageDdl } from './SnapshotJournalDestinationStage'
import { snapshotJournalDestinationPromotionDdl } from './SnapshotJournalDestinationPromotion'
import { snapshotJournalCapturedIdentitiesDdl } from './SnapshotJournalCapturedIdentities'
import { snapshotJournalIdentityLedgerDdl } from './SnapshotJournalIdentityLedger'
import { snapshotJournalIdentityRetirementsDdl } from './SnapshotJournalIdentityRetirements'
import { snapshotJournalMembershipDdl } from './SnapshotJournalMemberships'
import { snapshotJournalProvenanceDdl } from './SnapshotJournalProvenance'
import { snapshotJournalProgressDdl } from './SnapshotJournalProgress'
import { migrateSnapshotJournalSqliteSourceAddition } from './SnapshotJournalSqliteGeneration'
import {
  addSnapshotJournalMysqlSourceIndexes,
  SNAPSHOT_JOURNAL_MYSQL_SOURCE_UPGRADE_DDL
} from './SnapshotJournalMysqlSourceUpgrade'
import { snapshotJournalCleanupIndexDdl } from './SnapshotJournalNativeReferences'
import {
  snapshotJournalSharedQuotaDdl,
  snapshotJournalSharedQuotaTriggers,
  seedSnapshotJournalSharedQuota,
  verifySnapshotJournalSharedQuota,
  verifySnapshotJournalQuotaMysqlTriggers
} from './SnapshotJournalSharedQuota'
import { addSnapshotSqliteSourceIndexes } from '../../schema/snapshotSqliteIndexGeneration'
import {
  brc38ImportTargetIndexStatements,
  verifyBrc38ImportTargetIndexes
} from '../../portable/Brc38ImportTargetIndexes'
import {
  snapshotJournalNativeDestinationExtras,
  assertSnapshotJournalOrdinaryDataDeletion
} from './SnapshotJournalNativeDestinationSchema'

export const SNAPSHOT_JOURNAL_DESTINATION_MIGRATION = '2026-10-06-001 add journal reconciliation destination'
function invalid(): never {
  throw new WERR_INVALID_OPERATION('Journal destination schema differs from its owned migration')
}
function dialect(k: Knex): boolean {
  if (['mysql', 'mysql2'].includes(String(k.client.config.client))) return true
  if (['sqlite3', 'better-sqlite3'].includes(String(k.client.config.client)) || isOwnedNativeSqlite(k)) return false
  return invalid()
}
function definitions(k: Knex): string[] {
  return [
    snapshotJournalSharedQuotaDdl(k),
    snapshotJournalDestinationWindowDdl(k),
    ...snapshotJournalDestinationStageDdl(k),
    snapshotJournalDestinationPromotionDdl(k),
    ...snapshotJournalCapturedIdentitiesDdl(k),
    ...snapshotJournalIdentityLedgerDdl(k),
    ...snapshotJournalIdentityRetirementsDdl(k),
    ...snapshotJournalMembershipDdl(k),
    ...snapshotJournalProvenanceDdl(k),
    snapshotJournalProgressDdl(k),
    ...(dialect(k) ? [SNAPSHOT_JOURNAL_MYSQL_SOURCE_UPGRADE_DDL] : [])
  ]
}
async function targetIndexes(k: Knex): Promise<string[]> {
  return [...(await brc38ImportTargetIndexStatements(k)), ...snapshotJournalCleanupIndexDdl()]
}
interface Index {
  name: string
  table: string
  columns: string[]
  unique: boolean
}
interface Table {
  name: string
  columns: Array<{ name: string; type: string }>
  indexes: Index[]
  charset: string
  collation: string
  options: string
}
function index(sql: string): Index {
  const match = /^CREATE INDEX (\w+) ON (\w+) ?\(([^)]+)\)$/.exec(sql)
  if (!match) invalid()
  return { name: match[1], table: match[2], columns: match[3].split(',').map(value => value.trim()), unique: false }
}
/** Parse only our small fixed DDL grammar, never remote or stored SQL. */
function table(sql: string): Table {
  const match =
    /^CREATE TABLE (\w+)\((.*)\) ENGINE=InnoDB DEFAULT CHARACTER SET (ascii|utf8mb4) COLLATE (ascii_bin|utf8mb4_bin)(?: ROW_FORMAT=DYNAMIC)?$/.exec(
      sql
    )
  if (!match) invalid()
  const columns: Table['columns'] = [],
    indexes: Index[] = []
  const parts: string[] = []
  let depth = 0,
    start = 0
  for (let i = 0; i < match[2].length; i++) {
    if (match[2][i] === '(') depth++
    if (match[2][i] === ')') depth--
    if (depth < 0) invalid()
    if (match[2][i] === ',' && depth === 0) {
      parts.push(match[2].slice(start, i))
      start = i + 1
    }
  }
  if (depth !== 0) invalid()
  parts.push(match[2].slice(start))
  for (const part of parts) {
    const primary = /^PRIMARY KEY\((\w+(?:,\w+)*)\)$/.exec(part)
    if (primary) indexes.push({ name: 'PRIMARY', table: match[1], columns: primary[1].split(','), unique: true })
    else {
      const field =
        /^(`?\w+`?) (BIGINT|INTEGER|VARCHAR\([1-9]\d*\)|VARBINARY\([1-9]\d*\)|TEXT|MEDIUMTEXT|LONGBLOB) NOT NULL$/.exec(
          part
        )
      if (!field) invalid()
      columns.push({ name: field[1].replaceAll('`', ''), type: field[2].toLowerCase().replace('integer', 'int') })
    }
  }
  if (columns.length > 32 || indexes.length !== 1) invalid()
  return {
    name: match[1],
    columns,
    indexes,
    charset: match[3],
    collation: match[4],
    options: sql.endsWith(' ROW_FORMAT=DYNAMIC') ? 'row_format=DYNAMIC' : ''
  }
}

async function verifyMysql(
  k: Knex,
  ddl: readonly string[],
  nativeIndexes: readonly string[],
  complete = true,
  triggers = true
): Promise<void> {
  const specs = ddl.filter(sql => sql.startsWith('CREATE TABLE ')).map(table)
  const standalone = [...ddl.filter(sql => sql.startsWith('CREATE INDEX ')), ...nativeIndexes].map(index)
  for (const spec of specs) {
    const objects: Array<Record<string, unknown>> = await k('information_schema.TABLES')
      .whereRaw('TABLE_SCHEMA=DATABASE()')
      .where('TABLE_NAME', spec.name)
      .select('TABLE_TYPE', 'ENGINE', 'TABLE_COLLATION', 'ROW_FORMAT', 'CREATE_OPTIONS')
      .limit(2)
    if (
      objects.length !== 1 ||
      objects[0].TABLE_TYPE !== 'BASE TABLE' ||
      objects[0].ENGINE !== 'InnoDB' ||
      objects[0].TABLE_COLLATION !== spec.collation ||
      objects[0].ROW_FORMAT !== 'Dynamic' ||
      objects[0].CREATE_OPTIONS !== spec.options
    )
      invalid()
    const columns: Array<Record<string, unknown>> = await k('information_schema.COLUMNS')
      .whereRaw('TABLE_SCHEMA=DATABASE()')
      .where('TABLE_NAME', spec.name)
      .select(
        'COLUMN_NAME',
        'COLUMN_TYPE',
        'IS_NULLABLE',
        'COLUMN_DEFAULT',
        'EXTRA',
        'CHARACTER_SET_NAME',
        'COLLATION_NAME',
        'GENERATION_EXPRESSION'
      )
      .orderBy('ORDINAL_POSITION')
      .limit(33)
    if (
      columns.length !== spec.columns.length ||
      columns.some((column, i) => {
        const expected = spec.columns[i],
          text = /^(varchar|text|mediumtext)/.test(expected.type)
        return (
          column.COLUMN_NAME !== expected.name ||
          String(column.COLUMN_TYPE).replace(/^(bigint|int)\(\d+\)$/, '$1') !== expected.type ||
          column.IS_NULLABLE !== 'NO' ||
          column.COLUMN_DEFAULT !== null ||
          column.EXTRA !== '' ||
          column.GENERATION_EXPRESSION !== '' ||
          column.CHARACTER_SET_NAME !== (text ? spec.charset : null) ||
          column.COLLATION_NAME !== (text ? spec.collation : null)
        )
      })
    )
      invalid()
    const constraints: Array<Record<string, unknown>> = await k('information_schema.TABLE_CONSTRAINTS')
      .whereRaw('TABLE_SCHEMA=DATABASE()')
      .where('TABLE_NAME', spec.name)
      .select('CONSTRAINT_NAME', 'CONSTRAINT_TYPE')
      .limit(2)
    if (
      constraints.length !== 1 ||
      constraints[0].CONSTRAINT_NAME !== 'PRIMARY' ||
      constraints[0].CONSTRAINT_TYPE !== 'PRIMARY KEY'
    )
      invalid()
  }
  if (triggers)
    await verifySnapshotJournalQuotaMysqlTriggers(
      k,
      snapshotJournalSharedQuotaTriggers(k, ddl),
      specs.map(spec => spec.name)
    )
  for (const spec of specs) spec.indexes.push(...standalone.filter(value => value.table === spec.name))
  const all = [
    ...specs.flatMap(spec => spec.indexes),
    ...standalone.filter(value => !specs.some(spec => spec.name === value.table))
  ]
  for (const value of all) {
    const rows: Array<Record<string, unknown>> = await k('information_schema.STATISTICS')
      .whereRaw('TABLE_SCHEMA=DATABASE()')
      .where({ TABLE_NAME: value.table, INDEX_NAME: value.name })
      .select('COLUMN_NAME', 'NON_UNIQUE', 'COLLATION', 'SUB_PART', 'INDEX_TYPE', 'IS_VISIBLE', 'EXPRESSION')
      .orderBy('SEQ_IN_INDEX')
      .limit(17)
    if (
      rows.length !== value.columns.length ||
      rows.some(
        (row, i) =>
          row.COLUMN_NAME !== value.columns[i] ||
          Number(row.NON_UNIQUE) !== (value.unique ? 0 : 1) ||
          row.COLLATION !== 'A' ||
          row.SUB_PART !== null ||
          row.INDEX_TYPE !== 'BTREE' ||
          row.IS_VISIBLE !== 'YES' ||
          row.EXPRESSION !== null
      )
    )
      invalid()
  }
  for (const spec of specs) {
    const names: Array<{ INDEX_NAME: unknown }> = await k('information_schema.STATISTICS')
      .whereRaw('TABLE_SCHEMA=DATABASE()')
      .where('TABLE_NAME', spec.name)
      .distinct('INDEX_NAME')
      .limit(17)
    if (
      names.length !== spec.indexes.length ||
      names.some(row => !spec.indexes.some(value => value.name === row.INDEX_NAME))
    )
      invalid()
  }
  if (complete) {
    const owned = await k('information_schema.TABLES')
      .whereRaw('TABLE_SCHEMA=DATABASE()')
      .whereRaw('LEFT(TABLE_NAME,24)=?', ['snapshot_reconciliation_'])
      .select('TABLE_NAME')
      .limit(65)
    if (owned.length !== specs.length || owned.some(row => !specs.some(spec => spec.name === row.TABLE_NAME))) invalid()
    const triggerNames = await k('information_schema.TRIGGERS')
      .whereRaw('TRIGGER_SCHEMA=DATABASE()')
      .whereRaw('LEFT(TRIGGER_NAME,24)=?', ['snapshot_reconciliation_'])
      .select('TRIGGER_NAME')
      .limit(129)
    const expected = snapshotJournalSharedQuotaTriggers(k, ddl)
    if (
      triggerNames.length !== expected.length ||
      triggerNames.some(row => !expected.some(value => value.name === row.TRIGGER_NAME))
    )
      invalid()
  }
}

/** Fresh actual complete schema verification, not a persisted capability flag.
 * Authentication, current physical backend/profile and primary fences remain
 * independent prerequisites for every provider operation. */
export async function verifySnapshotJournalDestinationSchema(k: Knex): Promise<void> {
  if (isOwnedNativeSqlite(k) && !k.isTransaction) {
    await k.transaction(async trx => await verifySnapshotJournalDestinationSchema(trx))
    return
  }
  const mysql = dialect(k),
    sourceDdl = definitions(k),
    quota = await snapshotJournalQuotaLayout(k, sourceDdl),
    ddl = quota.ddl,
    native = await targetIndexes(k)
  if (mysql) {
    await verifyMysql(k, ddl, native)
    await verifySnapshotJournalSharedQuota(k)
    return
  }
  const tables = ddl.filter(sql => sql.startsWith('CREATE TABLE ')).map(sql => /^CREATE TABLE (\w+)/.exec(sql)![1]),
    extra = await snapshotJournalNativeDestinationExtras(k, tables)
  const expected = new Map(
    [...ddl, ...native, ...quota.triggers.map(value => value.sql), ...quota.dispatch, ...extra].map(sql => {
      const match = /^CREATE (TABLE|INDEX|TRIGGER|VIEW) (\w+)/.exec(sql)
      if (!match) invalid()
      return [match[2], { type: match[1].toLowerCase(), name: match[2], sql }]
    })
  )
  const actual: Array<{ type: unknown; name: unknown }> = await k('sqlite_schema')
    .where(function () {
      void this.whereIn('name', [...expected.keys()])
        .orWhereRaw('substr(name,1,24)=?', ['snapshot_reconciliation_'])
        .orWhereIn(
          'tbl_name',
          [...expected.values()].filter(value => value.type === 'table').map(value => value.name)
        )
    })
    .whereNot('name', 'like', 'sqlite_autoindex_%')
    .select('type', k.raw('substr(name,1,129) AS name'))
    .limit(expected.size + 1)
  if (
    actual.length !== expected.size ||
    actual.some(row => typeof row.name !== 'string' || expected.get(row.name)?.type !== row.type)
  )
    invalid()
  // Compare every definition freshly inside SQLite in bounded scalar batches;
  // complete SQL bodies never cross the retained view's result boundary.
  for (const batch of brc38SqliteDefinitionBatches(expected)) {
    const match = await readBrc38SqliteDefinitionBatch(k, batch)
    if (Number(match.matches) !== batch.definitions.length || Number(match.names) !== batch.definitions.length)
      invalid()
  }
  if (isOwnedNativeSqlite(k)) await verifyBrc38ImportTargetIndexes(k as Knex.Transaction)
  await verifySnapshotJournalSharedQuota(k)
}

/** Data erasure accepts an interrupted installation/previous erasure, but every
 * surviving object must still match authored source. Absence is not runtime
 * admission, and a name or migration entry never proves object ownership. */
async function verifyRemainingDestinationForDataDeletion(k: Knex, ddl: readonly string[]): Promise<Set<string>> {
  const tableDdl = ddl.filter(value => value.startsWith('CREATE TABLE '))
  const tables = tableDdl.map(sql => {
    const name = /^CREATE TABLE (\w+)/.exec(sql)?.[1]
    if (name === undefined) invalid()
    return name
  })
  const quota = await snapshotJournalQuotaLayout(k, ddl),
    triggers = quota.triggers
  if (dialect(k)) {
    const actual: Array<{ TABLE_NAME: string }> = await k('information_schema.TABLES')
      .whereRaw('TABLE_SCHEMA=DATABASE()')
      .whereRaw('LOWER(LEFT(TABLE_NAME,24))=?', ['snapshot_reconciliation_'])
      .select('TABLE_NAME')
      .limit(65)
    if (actual.length > tables.length || actual.some(row => !tables.includes(row.TABLE_NAME))) invalid()
    const present = new Set(actual.map(row => row.TABLE_NAME))
    const actualIndexes: Array<{ TABLE_NAME: string; INDEX_NAME: string }> = present.size
      ? await k('information_schema.STATISTICS')
          .whereRaw('TABLE_SCHEMA=DATABASE()')
          .whereIn('TABLE_NAME', [...present])
          .distinct('TABLE_NAME', 'INDEX_NAME')
          .limit(129)
      : []
    if (actualIndexes.length > 128) invalid()
    const indexes = ddl
      .filter(value => value.startsWith('CREATE INDEX '))
      .filter(sql => {
        const value = index(sql)
        return (
          present.has(value.table) &&
          actualIndexes.some(row => row.TABLE_NAME === value.table && row.INDEX_NAME === value.name)
        )
      })
    const remaining = [...tableDdl.filter(sql => present.has(/^CREATE TABLE (\w+)/.exec(sql)![1])), ...indexes]
    if (present.size) await verifyMysql(k, remaining, [], false, false)
    const actualTriggers: Array<{ TRIGGER_NAME: string }> = await k('information_schema.TRIGGERS')
      .whereRaw('TRIGGER_SCHEMA=DATABASE()')
      .where(function () {
        void this.whereRaw('LOWER(LEFT(TRIGGER_NAME,24))=?', ['snapshot_reconciliation_']).orWhereIn(
          'EVENT_OBJECT_TABLE',
          tables
        )
      })
      .select('TRIGGER_NAME')
      .limit(129)
    if (
      actualTriggers.length > triggers.length ||
      actualTriggers.some(row => !triggers.some(value => value.name === row.TRIGGER_NAME && present.has(value.table)))
    )
      invalid()
    const expected = triggers.filter(value => actualTriggers.some(row => row.TRIGGER_NAME === value.name))
    await verifySnapshotJournalQuotaMysqlTriggers(k, expected, tables)
    return present
  }
  const extra = await snapshotJournalNativeDestinationExtras(k, tables)
  const expected = new Map(
    [...quota.ddl, ...triggers.map(value => value.sql), ...quota.dispatch, ...extra].map(sql => {
      const match = /^CREATE (TABLE|INDEX|TRIGGER|VIEW) (\w+)/.exec(sql)
      if (!match) invalid()
      return [match[2], { type: match[1].toLowerCase(), sql }]
    })
  )
  const actual: Array<{ type: unknown; name: unknown }> = await k('sqlite_schema')
    .where(function () {
      void this.whereRaw('lower(substr(name,1,24))=?', ['snapshot_reconciliation_'])
        .orWhereIn('tbl_name', tables)
        .orWhereIn('name', [...expected.keys()])
    })
    .whereNot('name', 'like', 'sqlite_autoindex_%')
    .select('type', k.raw('substr(name,1,129) AS name'))
    .limit(expected.size + 1)
  if (
    actual.length > expected.size ||
    actual.some(row => typeof row.name !== 'string' || expected.get(row.name)?.type !== row.type)
  )
    invalid()
  for (const row of actual) {
    const source = expected.get(row.name as string)!
    const match = (await k('sqlite_schema')
      .where({ name: row.name, type: source.type })
      .whereRaw('CAST(sql AS BLOB)=CAST(? AS BLOB)', [source.sql])
      .count({ count: '*' })
      .first()) as { count: unknown } | undefined
    if (Number(match?.count) !== 1) invalid()
  }
  return new Set(actual.filter(row => row.type === 'table').map(row => row.name as string))
}

/** Data erasure only, after all owned source/destination sessions have drained.
 * MySQL resumes at the actually remaining objects following any DDL boundary.
 * Quota ownership outlives all charged tables. Native source indexes remain
 * installed until the standard schema is removed. */
export async function dropSnapshotJournalDestinationForDataDeletion(k: Knex): Promise<void> {
  await assertSnapshotJournalOrdinaryDataDeletion(k)
  if (!dialect(k) && !k.isTransaction) {
    await k.transaction(async trx => await dropSnapshotJournalDestinationForDataDeletion(trx))
    return
  }
  if (dialect(k) && k.isTransaction) invalid()
  const ddl = definitions(k),
    quota = await snapshotJournalQuotaLayout(k, ddl),
    present = await verifyRemainingDestinationForDataDeletion(k, ddl)
  for (const sql of ddl.filter(value => value.startsWith('CREATE TABLE ')).reverse()) {
    const match = /^CREATE TABLE (\w+)/.exec(sql)
    if (!match) invalid()
    if (present.has(match[1])) await k.schema.dropTable(match[1])
  }
  // Parent-table deletion removes the emitters. The exact surviving dispatch
  // objects were validated above and are removed after their charged tables.
  for (const sql of [...quota.dispatch].reverse()) {
    const object = /^CREATE (VIEW|TRIGGER) (\w+)/.exec(sql)
    if (object === null) invalid()
    if (
      (await k('sqlite_schema').where({ name: object[2], type: object[1].toLowerCase() }).select('name')).length !== 0
    )
      await k.raw(`DROP ${object[1]} ??`, [object[2]])
  }
}

/** SQLite commits all additions together and safely rebinds existing observer
 * generations. MySQL DDL is resumable per exact object and never adopted by name
 * alone. Existing source journals retain their data through the corresponding
 * source-upgrade protocol before native source indexes are changed. */
export async function addSnapshotJournalDestinationSchema(k: Knex): Promise<void> {
  const mysql = dialect(k),
    sourceDdl = definitions(k),
    native = await targetIndexes(k),
    quota = await snapshotJournalQuotaLayout(k, sourceDdl),
    ddl = quota.ddl
  if (!mysql && !k.isTransaction) invalid()
  const install = async () => {
    for (const sql of [...ddl, ...native]) {
      const match = /^CREATE (TABLE|INDEX) (\w+)(?: ON (\w+))?/.exec(sql)
      if (!match) invalid()
      const exists = mysql
        ? match[1] === 'TABLE'
          ? (
              await k('information_schema.TABLES')
                .whereRaw('TABLE_SCHEMA=DATABASE()')
                .where('TABLE_NAME', match[2])
                .select('TABLE_NAME')
                .limit(2)
            ).length
          : (
              await k('information_schema.STATISTICS')
                .whereRaw('TABLE_SCHEMA=DATABASE()')
                .where({ TABLE_NAME: match[3], INDEX_NAME: match[2] })
                .select('INDEX_NAME')
                .limit(17)
            ).length
        : (await k('sqlite_schema').where('name', match[2]).select('name').limit(2)).length
      if (!exists) await k.raw(sql)
    }
    await seedSnapshotJournalSharedQuota(k, ddl)
    for (const sql of quota.dispatch) {
      const object = /^CREATE (VIEW|TRIGGER) (\w+)/.exec(sql)
      if (object === null) invalid()
      if ((await k('sqlite_schema').where('name', object[2]).select('name').limit(2)).length === 0) await k.raw(sql)
    }
    for (const trigger of quota.triggers) {
      const exists = mysql
        ? (
            await k('information_schema.TRIGGERS')
              .whereRaw('TRIGGER_SCHEMA=DATABASE()')
              .where('TRIGGER_NAME', trigger.name)
              .select('TRIGGER_NAME')
              .limit(2)
          ).length
        : (await k('sqlite_schema').where('name', trigger.name).select('name').limit(2)).length
      if (!exists) await k.raw(trigger.sql)
    }
    await verifySnapshotJournalDestinationSchema(k)
  }
  if (mysql) {
    if (k.isTransaction) invalid()
    // The forward source-upgrade record is itself quota-owned data. Install
    // its exact table/guards BEFORE that protocol can persist an inventory.
    const early = [snapshotJournalSharedQuotaDdl(k), SNAPSHOT_JOURNAL_MYSQL_SOURCE_UPGRADE_DDL]
    for (const sql of early) {
      const name = /^CREATE TABLE (\w+)/.exec(sql)?.[1]
      if (name === undefined) invalid()
      if (!(await k.schema.hasTable(name))) await k.raw(sql)
    }
    await verifyMysql(k, early, [], false, false)
    await seedSnapshotJournalSharedQuota(k, ddl)
    for (const trigger of snapshotJournalSharedQuotaTriggers(k, early)) {
      const exists = await k('information_schema.TRIGGERS')
        .whereRaw('TRIGGER_SCHEMA=DATABASE()')
        .where('TRIGGER_NAME', trigger.name)
        .select('TRIGGER_NAME')
        .limit(2)
      if (!exists.length) await k.raw(trigger.sql)
    }
    await verifyMysql(k, early, [], false)
    await addSnapshotJournalMysqlSourceIndexes(k, native, install)
  } else
    await migrateSnapshotJournalSqliteSourceAddition(
      k,
      () => addSnapshotSqliteSourceIndexes(k, native, install),
      k.client.config.migrations
    )
}
