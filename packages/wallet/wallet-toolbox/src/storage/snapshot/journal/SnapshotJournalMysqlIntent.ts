import type { Knex } from 'knex'
import { randomUUID } from 'node:crypto'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { snapshotJournalRevision, type SnapshotJournalRevision } from './SnapshotJournalRevision'

export const SNAPSHOT_JOURNAL_MYSQL_INTENT = 'snapshot_journal_generation'
export interface SnapshotJournalMysqlBinding {
  source: string
  plan: string
  ceiling: SnapshotJournalRevision
}
export interface SnapshotJournalMysqlIntent extends SnapshotJournalMysqlBinding {
  epoch: string
  nextObject: number
  complete: boolean
}
const columns = [
  ['id', 'int'],
  ['version', 'int'],
  ['epoch', 'varchar(36)'],
  ['source', 'varchar(64)'],
  ['plan', 'varchar(64)'],
  ['ceiling', 'varchar(19)'],
  ['nextObject', 'int'],
  ['complete', 'tinyint']
] as const
export const SNAPSHOT_JOURNAL_MYSQL_INTENT_DDL =
  'CREATE TABLE snapshot_journal_generation(id INTEGER NOT NULL PRIMARY KEY,version INTEGER NOT NULL,epoch VARCHAR(36) NOT NULL,source VARCHAR(64) NOT NULL,plan VARCHAR(64) NOT NULL,ceiling VARCHAR(19) NOT NULL,nextObject INTEGER NOT NULL,complete BOOLEAN NOT NULL) ENGINE=InnoDB DEFAULT CHARACTER SET ascii COLLATE ascii_bin ROW_FORMAT=DYNAMIC'
function invalid(): never {
  throw new WERR_INVALID_OPERATION('Invalid or unowned MySQL snapshot journal installation intent')
}
function binding(value: SnapshotJournalMysqlBinding): void {
  if (
    typeof value.source !== 'string' ||
    typeof value.plan !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.source) ||
    !/^[0-9a-f]{64}$/.test(value.plan) ||
    snapshotJournalRevision(value.ceiling) === '0'
  )
    invalid()
}
function client(k: Knex): void {
  if (k.client.config.client !== 'mysql' && k.client.config.client !== 'mysql2') invalid()
}
async function structure(k: Knex): Promise<void> {
  const [tables]: Array<
    Array<{ engine: string; type: string; collation: string; rowFormat: string; options: string }>
  > = await k.raw(
    'SELECT ENGINE engine,TABLE_TYPE type,TABLE_COLLATION collation,ROW_FORMAT rowFormat,CREATE_OPTIONS options FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',
    [SNAPSHOT_JOURNAL_MYSQL_INTENT]
  )
  if (
    tables.length !== 1 ||
    tables[0].engine !== 'InnoDB' ||
    tables[0].type !== 'BASE TABLE' ||
    tables[0].collation !== 'ascii_bin' ||
    tables[0].rowFormat !== 'Dynamic' ||
    tables[0].options !== 'row_format=DYNAMIC'
  )
    return invalid()
  const [actual]: Array<
    Array<{
      name: string
      type: string
      nullable: string
      defaultValue: unknown
      extra: string
      charset: string | null
      collation: string | null
      expression: string
    }>
  > = await k.raw(
    'SELECT COLUMN_NAME name,COLUMN_TYPE type,IS_NULLABLE nullable,COLUMN_DEFAULT defaultValue,EXTRA extra,CHARACTER_SET_NAME charset,COLLATION_NAME collation,GENERATION_EXPRESSION expression FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION LIMIT 9',
    [SNAPSHOT_JOURNAL_MYSQL_INTENT]
  )
  if (
    actual.length !== columns.length ||
    actual.some((column, index) => {
      const [name, type] = columns[index],
        text = type.startsWith('varchar')
      return (
        column.name !== name ||
        column.type.replace(/^(int|tinyint)\(\d+\)$/, '$1') !== type ||
        column.nullable !== 'NO' ||
        column.defaultValue !== null ||
        column.extra !== '' ||
        column.expression !== '' ||
        column.charset !== (text ? 'ascii' : null) ||
        column.collation !== (text ? 'ascii_bin' : null)
      )
    })
  )
    return invalid()
  const [indexes]: Array<
    Array<{
      name: string
      columnName: string
      nonUnique: number
      direction: string
      prefix: unknown
      type: string
      visible: string
    }>
  > = await k.raw(
    'SELECT INDEX_NAME name,COLUMN_NAME columnName,NON_UNIQUE nonUnique,COLLATION direction,SUB_PART prefix,INDEX_TYPE type,IS_VISIBLE visible FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX LIMIT 2',
    [SNAPSHOT_JOURNAL_MYSQL_INTENT]
  )
  if (
    indexes.length !== 1 ||
    indexes[0].name !== 'PRIMARY' ||
    indexes[0].columnName !== 'id' ||
    indexes[0].nonUnique !== 0 ||
    indexes[0].direction !== 'A' ||
    indexes[0].prefix !== null ||
    indexes[0].type !== 'BTREE' ||
    indexes[0].visible !== 'YES'
  )
    return invalid()
  const [constraints]: Array<Array<{ name: string; type: string; enforced: string }>> = await k.raw(
    'SELECT CONSTRAINT_NAME name,CONSTRAINT_TYPE type,ENFORCED enforced FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? LIMIT 2',
    [SNAPSHOT_JOURNAL_MYSQL_INTENT]
  )
  if (
    constraints.length !== 1 ||
    constraints[0].name !== 'PRIMARY' ||
    constraints[0].type !== 'PRIMARY KEY' ||
    constraints[0].enforced !== 'YES'
  )
    return invalid()
  const [triggers]: Array<unknown[]> = await k.raw(
    'SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=? LIMIT 1',
    [SNAPSHOT_JOURNAL_MYSQL_INTENT]
  )
  if (triggers.length !== 0) return invalid()
}
export async function readSnapshotJournalMysqlIntent(
  k: Knex,
  expected: SnapshotJournalMysqlBinding
): Promise<SnapshotJournalMysqlIntent> {
  client(k)
  binding(expected)
  await structure(k)
  const rows = await k(SNAPSHOT_JOURNAL_MYSQL_INTENT).select('*').limit(2)
  if (rows.length !== 1) return invalid()
  const row = rows[0]
  if (
    row.id !== 1 ||
    row.version !== 1 ||
    typeof row.epoch !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.epoch) ||
    row.source !== expected.source ||
    row.plan !== expected.plan ||
    row.ceiling !== expected.ceiling ||
    !Number.isInteger(row.nextObject) ||
    row.nextObject < 0 ||
    row.nextObject > 128 ||
    ![0, 1].includes(row.complete)
  )
    return invalid()
  return { ...expected, epoch: row.epoch, nextObject: row.nextObject, complete: row.complete === 1 }
}

/** MySQL 8.0.21+ InnoDB atomic CREATE TABLE SELECT persists the first intent row
 * with its table. Caller excludes other migrators and validates source/schema
 * before calling; no existing object is adopted, replaced or dropped here.
 * This is not a transaction wrapper: ordinary MySQL DDL commits implicitly.
 */
export async function createSnapshotJournalMysqlIntent(
  k: Knex,
  expected: SnapshotJournalMysqlBinding
): Promise<SnapshotJournalMysqlIntent> {
  client(k)
  binding(expected)
  if (k.isTransaction) return invalid()
  const [[server]]: Array<Array<{ version: string }>> = await k.raw('SELECT VERSION() version')
  const version = /^8\.(\d+)\.(\d+)(?:[-.]|$)/.exec(server.version)
  if (!version || (Number(version[1]) === 0 && Number(version[2]) < 21)) return invalid()
  const epoch = randomUUID()
  await k.raw(
    SNAPSHOT_JOURNAL_MYSQL_INTENT_DDL +
      ' SELECT 1 id,1 version,? epoch,? source,? plan,? ceiling,0 nextObject,0 complete',
    [epoch, expected.source, expected.plan, expected.ceiling]
  )
  return await readSnapshotJournalMysqlIntent(k, expected)
}
