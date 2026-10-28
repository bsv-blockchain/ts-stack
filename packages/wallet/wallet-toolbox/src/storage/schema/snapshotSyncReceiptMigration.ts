import type { Knex } from 'knex'
import { isOwnedNativeSqlite } from './ownedNativeSqliteRuntimeNode'
import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'

export const SNAPSHOT_SYNC_CONTENT_RECEIPT_MIGRATION = '2026-10-17-001 add snapshot content receipts'
export const SNAPSHOT_SYNC_CONTENT_RECEIPTS = 'snapshot_sync_content_receipts'
const foreignKey = 'snapshot_sync_content_receipts_user'
const columns = [
  ['userId', 'int', false],
  ['sourceKey', 'varchar(64)', false],
  ['sourceStorageIdentityKey', 'varchar(130)', false],
  ['version', 'int', false],
  ['sessionId', 'varchar(64)', false],
  ['snapshotId', 'varchar(64)', false],
  ['sourceBinding', 'varchar(64)', false],
  ['sourceContent', 'varchar(64)', false],
  ['sourceMetadata', 'varchar(64)', false],
  ['sourceHighWater', 'varchar(19)', false],
  ['sourceFloor', 'varchar(19)', false],
  ['destinationBinding', 'varchar(64)', true],
  ['destinationContent', 'varchar(64)', true],
  ['destinationMetadata', 'varchar(64)', true],
  ['destinationHighWater', 'varchar(19)', true],
  ['destinationFloor', 'varchar(19)', true],
  ['primaryEpoch', 'varchar(19)', true],
  ['activeStorage', 'varchar(130)', true],
  ['complete', 'tinyint', false]
] as const

export interface SnapshotComparisonReceiptSchema {
  readonly table: string
  readonly foreignKey: string
  readonly columns: ReadonlyArray<readonly [string, string, boolean]>
}
/** Static expected CODE definitions, never a cached verdict about live SQL. */
export function snapshotComparisonReceiptSchema(
  table: string,
  foreignKey: string,
  input: ReadonlyArray<readonly [string, string, boolean]>
): Readonly<SnapshotComparisonReceiptSchema> {
  const name = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
  if (
    !name.test(table) ||
    !name.test(foreignKey) ||
    input.length < 1 ||
    input.length > 32 ||
    new Set(input.map(row => row[0])).size !== input.length
  )
    invalid()
  const columns = input.map(([key, type, nullable]) => {
    if (!name.test(key) || !/^(?:int|tinyint|varchar\([1-9]\d{0,3}\))$/.test(type) || typeof nullable !== 'boolean')
      invalid()
    return Object.freeze([key, type, nullable] as const)
  })
  return Object.freeze({ table, foreignKey, columns: Object.freeze(columns) })
}
export const snapshotSyncContentReceiptSchema = snapshotComparisonReceiptSchema(
  SNAPSHOT_SYNC_CONTENT_RECEIPTS,
  foreignKey,
  columns
)

function invalid(): never {
  throw new WERR_INVALID_OPERATION('Snapshot content receipt schema is incomplete or changed')
}

function mysql(k: Knex): boolean {
  const client = String(k.client.config.client)
  if (client === 'mysql' || client === 'mysql2') return true
  if (client === 'sqlite3' || client === 'better-sqlite3' || isOwnedNativeSqlite(k)) return false
  return invalid()
}

/** Only optional comparison/completion DATA. Existing wallet tables and the
 * version-one durable merge/checkpoint schema are never rewritten. */
export function snapshotSyncContentReceiptDdl(k: Knex): string {
  return snapshotComparisonReceiptDdl(k, snapshotSyncContentReceiptSchema)
}

export function snapshotComparisonReceiptDdl(k: Knex, specification: SnapshotComparisonReceiptSchema): string {
  const { table, foreignKey, columns } = specification
  const remote = mysql(k)
  const fields = columns.map(([name, type, nullable]) => {
    const declared = remote
      ? type + (type === 'int' || type === 'tinyint' ? ' unsigned' : '')
      : type === 'int' || type === 'tinyint'
        ? 'INTEGER'
        : type.toUpperCase()
    const check = remote
      ? ''
      : name === 'userId'
        ? ' CHECK(userId>0)'
        : name === 'version'
          ? ' CHECK(version=1)'
          : name === 'complete'
            ? ' CHECK(complete IN(0,1))'
            : ''
    return name + ' ' + declared + (nullable ? ' NULL' : ' NOT NULL') + check
  })
  return (
    `CREATE TABLE ${table}(${fields.join(',')},PRIMARY KEY(userId,sourceKey),CONSTRAINT ${foreignKey} FOREIGN KEY(userId) REFERENCES users(userId) ON DELETE CASCADE)` +
    (remote ? ' ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin ROW_FORMAT=DYNAMIC' : '')
  )
}

/** Repeat against actual current objects; neither a migration stamp nor a
 * previous successful probe is schema or backend authority. */
export async function verifySnapshotSyncContentReceiptSchema(k: Knex): Promise<void> {
  await verifySnapshotComparisonReceiptSchema(k, snapshotSyncContentReceiptSchema)
}

export async function verifySnapshotComparisonReceiptSchema(
  k: Knex,
  specification: SnapshotComparisonReceiptSchema
): Promise<void> {
  const { table: tableName, foreignKey, columns } = specification
  if (!mysql(k)) {
    const shadows = await k('sqlite_temp_master')
      .where(function () {
        void this.where('name', tableName).orWhere('tbl_name', tableName)
      })
      .select('name')
      .limit(1)
    if (shadows.length !== 0) invalid()
    const objects: Array<{ name: string; type: string; sql: string | null }> = await k('sqlite_master')
      .where('tbl_name', tableName)
      .select('name', 'type', 'sql')
      .limit(3)
    const table = objects.find(row => row.type === 'table'),
      index = objects.find(row => row.type === 'index')
    if (
      objects.length !== 2 ||
      table?.name !== tableName ||
      table.sql !== snapshotComparisonReceiptDdl(k, specification) ||
      index?.name !== 'sqlite_autoindex_' + tableName + '_1' ||
      index.sql !== null
    )
      invalid()
    return
  }
  const tables: Array<Record<string, unknown>> = await k('information_schema.TABLES')
    .whereRaw('TABLE_SCHEMA=DATABASE()')
    .where('TABLE_NAME', tableName)
    .select('TABLE_TYPE', 'ENGINE', 'TABLE_COLLATION', 'ROW_FORMAT')
    .limit(2)
  if (
    tables.length !== 1 ||
    tables[0].TABLE_TYPE !== 'BASE TABLE' ||
    tables[0].ENGINE !== 'InnoDB' ||
    tables[0].TABLE_COLLATION !== 'utf8mb4_bin' ||
    tables[0].ROW_FORMAT !== 'Dynamic'
  )
    invalid()
  const actual: Array<Record<string, unknown>> = await k('information_schema.COLUMNS')
    .whereRaw('TABLE_SCHEMA=DATABASE()')
    .where('TABLE_NAME', tableName)
    .select(
      'COLUMN_NAME',
      'COLUMN_TYPE',
      'IS_NULLABLE',
      'COLUMN_DEFAULT',
      'EXTRA',
      'GENERATION_EXPRESSION',
      'CHARACTER_SET_NAME',
      'COLLATION_NAME'
    )
    .orderBy('ORDINAL_POSITION')
    .limit(columns.length + 1)
  if (
    actual.length !== columns.length ||
    actual.some((row, index) => {
      const [name, type, nullable] = columns[index],
        numeric = type === 'int' || type === 'tinyint',
        expected = type + (numeric ? ' unsigned' : '')
      return (
        row.COLUMN_NAME !== name ||
        String(row.COLUMN_TYPE).replace(/^(int|tinyint)\(\d+\)/, '$1') !== expected ||
        row.IS_NULLABLE !== (nullable ? 'YES' : 'NO') ||
        row.COLUMN_DEFAULT !== null ||
        row.EXTRA !== '' ||
        row.GENERATION_EXPRESSION !== '' ||
        row.CHARACTER_SET_NAME !== (numeric ? null : 'utf8mb4') ||
        row.COLLATION_NAME !== (numeric ? null : 'utf8mb4_bin')
      )
    })
  )
    invalid()
  const constraints: Array<{ CONSTRAINT_NAME: string; CONSTRAINT_TYPE: string }> = await k(
    'information_schema.TABLE_CONSTRAINTS'
  )
    .whereRaw('TABLE_SCHEMA=DATABASE()')
    .where('TABLE_NAME', tableName)
    .select('CONSTRAINT_NAME', 'CONSTRAINT_TYPE')
    .limit(3)
  if (
    constraints.length !== 2 ||
    !constraints.some(row => row.CONSTRAINT_NAME === 'PRIMARY' && row.CONSTRAINT_TYPE === 'PRIMARY KEY') ||
    !constraints.some(row => row.CONSTRAINT_NAME === foreignKey && row.CONSTRAINT_TYPE === 'FOREIGN KEY')
  )
    invalid()
  const indexes: Array<Record<string, unknown>> = await k('information_schema.STATISTICS')
    .whereRaw('TABLE_SCHEMA=DATABASE()')
    .where('TABLE_NAME', tableName)
    .select(
      'INDEX_NAME',
      'COLUMN_NAME',
      'SEQ_IN_INDEX',
      'NON_UNIQUE',
      'COLLATION',
      'SUB_PART',
      'INDEX_TYPE',
      'IS_VISIBLE',
      'EXPRESSION'
    )
    .orderBy('INDEX_NAME')
    .orderBy('SEQ_IN_INDEX')
    .limit(3)
  if (
    indexes.length !== 2 ||
    indexes.some(
      (row, index) =>
        row.INDEX_NAME !== 'PRIMARY' ||
        row.COLUMN_NAME !== ['userId', 'sourceKey'][index] ||
        Number(row.SEQ_IN_INDEX) !== index + 1 ||
        Number(row.NON_UNIQUE) !== 0 ||
        row.COLLATION !== 'A' ||
        row.SUB_PART !== null ||
        row.INDEX_TYPE !== 'BTREE' ||
        row.IS_VISIBLE !== 'YES' ||
        row.EXPRESSION !== null
    )
  )
    invalid()
  const references: Array<Record<string, unknown>> = await k('information_schema.KEY_COLUMN_USAGE')
    .whereRaw('TABLE_SCHEMA=DATABASE()')
    .where('TABLE_NAME', tableName)
    .whereNotNull('REFERENCED_TABLE_NAME')
    .select(
      'CONSTRAINT_NAME',
      'COLUMN_NAME',
      'REFERENCED_TABLE_SCHEMA',
      'REFERENCED_TABLE_NAME',
      'REFERENCED_COLUMN_NAME'
    )
    .select(k.raw('DATABASE() AS currentDatabase'))
    .limit(2)
  const reference = references[0]
  if (
    references.length !== 1 ||
    reference.CONSTRAINT_NAME !== foreignKey ||
    reference.COLUMN_NAME !== 'userId' ||
    reference.REFERENCED_TABLE_SCHEMA !== reference.currentDatabase ||
    reference.REFERENCED_TABLE_NAME !== 'users' ||
    reference.REFERENCED_COLUMN_NAME !== 'userId'
  )
    invalid()
  const rules: Array<{ DELETE_RULE: string; UPDATE_RULE: string }> = await k(
    'information_schema.REFERENTIAL_CONSTRAINTS'
  )
    .whereRaw('CONSTRAINT_SCHEMA=DATABASE()')
    .where({ TABLE_NAME: tableName, CONSTRAINT_NAME: foreignKey })
    .select('DELETE_RULE', 'UPDATE_RULE')
    .limit(2)
  if (
    rules.length !== 1 ||
    rules[0].DELETE_RULE !== 'CASCADE' ||
    !['NO ACTION', 'RESTRICT'].includes(rules[0].UPDATE_RULE)
  )
    invalid()
  const triggers = await k('information_schema.TRIGGERS')
    .whereRaw('TRIGGER_SCHEMA=DATABASE()')
    .where('EVENT_OBJECT_TABLE', tableName)
    .select('TRIGGER_NAME')
    .limit(1)
  if (triggers.length !== 0) invalid()
}

/** CREATE TABLE includes its FK atomically, including MySQL's independently
 * committed DDL. An interrupted install may retry; changed objects refuse. */
export async function addSnapshotSyncContentReceiptSchema(k: Knex): Promise<void> {
  if (!(await k.schema.hasTable(SNAPSHOT_SYNC_CONTENT_RECEIPTS))) await k.raw(snapshotSyncContentReceiptDdl(k))
  await verifySnapshotSyncContentReceiptSchema(k)
}

/** Dropping optional comparison DATA makes the next copy take the old path;
 * wallet data and its original durable version-one ACK remain intact. */
export async function removeSnapshotSyncContentReceiptSchema(k: Knex): Promise<void> {
  mysql(k)
  if (await k.schema.hasTable(SNAPSHOT_SYNC_CONTENT_RECEIPTS)) {
    await verifySnapshotSyncContentReceiptSchema(k)
    await k.schema.dropTable(SNAPSHOT_SYNC_CONTENT_RECEIPTS)
  }
}
