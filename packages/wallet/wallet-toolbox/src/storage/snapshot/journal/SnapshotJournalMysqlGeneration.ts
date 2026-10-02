import type { Knex } from 'knex'
import { createHash } from 'node:crypto'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { runInSeries } from '../../../utility/runInSeries'
import { SNAPSHOT_JOURNAL_MYSQL_CLOCK_DDL } from './SnapshotJournalMysqlClock'
import { SNAPSHOT_JOURNAL_MYSQL_METADATA_DDL, snapshotJournalMysqlObserverSql } from './SnapshotJournalMysqlObservers'
import { SNAPSHOT_JOURNAL_BOOTSTRAP_DDL, validSnapshotJournalBootstrapBudget } from './SnapshotJournalBootstrap'
import { readSnapshotJournalMysqlBinding } from './SnapshotJournalMysqlSource'
import {
  compareSnapshotJournalRevisions,
  snapshotJournalRevision,
  type SnapshotJournalRevision
} from './SnapshotJournalRevision'
import {
  snapshotJournalReceiptDdl,
  snapshotJournalReceiptPolicy,
  type SnapshotJournalReceiptPolicy
} from './SnapshotJournalReceipt'
import {
  createSnapshotJournalMysqlIntent,
  readSnapshotJournalMysqlIntent,
  SNAPSHOT_JOURNAL_MYSQL_INTENT,
  type SnapshotJournalMysqlIntent,
  type SnapshotJournalMysqlBinding
} from './SnapshotJournalMysqlIntent'

interface Column {
  name: string
  type: string
  nullable?: boolean
  auto?: boolean
}
interface Index {
  name: string
  columns: string[]
  unique: boolean
}
interface Table {
  name: string
  sql: string
  columns: Column[]
  indexes: Index[]
  checks: string[]
  seed?: 'clock' | 'bootstrap' | 'retention'
  charset?: 'ascii'
}
interface Trigger {
  name: string
  sql: string
  table: string
  event: string
  body: string
}
type ObjectDefinition = { type: 'table'; definition: Table } | { type: 'trigger'; definition: Trigger }
interface Context {
  sqlMode: string
  charset: string
  collation: string
  databaseCollation: string
  definer: string
}
interface Plan {
  binding: SnapshotJournalMysqlBinding
  objects: ObjectDefinition[]
  context: Context
  receiptPolicy: SnapshotJournalReceiptPolicy
}
export interface SnapshotJournalMysqlGeneration extends SnapshotJournalMysqlIntent {
  enabled: boolean
}

function invalid(): never {
  throw new WERR_INVALID_OPERATION('Invalid or unowned MySQL snapshot journal generation')
}
function client(k: Knex): void {
  if (!['mysql', 'mysql2'].includes(k.client.config.client)) invalid()
}
const primary = (...columns: string[]): Index => ({ name: 'PRIMARY', columns, unique: true })
const column = (name: string, type: string): Column => ({ name, type })
const integer = (name: string): Column => column(name, 'int')
const big = (name: string): Column => column(name, 'bigint unsigned')
const physicalKey = ['tableId', 'id1', 'id2', 'exactText']
const physicalColumns = [integer('tableId'), big('id1'), big('id2'), column('exactText', 'varbinary(400)')]
const metadataColumns = [big('revision'), column('present', 'tinyint')]
const tail = ' ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin ROW_FORMAT=DYNAMIC'
const objectCount = 59

function tables(k: Knex): Table[] {
  const ddl = [
    ...SNAPSHOT_JOURNAL_MYSQL_CLOCK_DDL,
    ...SNAPSHOT_JOURNAL_MYSQL_METADATA_DDL,
    SNAPSHOT_JOURNAL_BOOTSTRAP_DDL,
    ...snapshotJournalReceiptDdl(k)
  ]
  const specs: Omit<Table, 'sql'>[] = [
    {
      name: 'snapshot_journal_clock',
      columns: [integer('id'), big('ceiling')],
      indexes: [primary('id')],
      checks: ['(`id` = 1)'],
      seed: 'clock'
    },
    {
      name: 'snapshot_journal_events',
      columns: [{ ...big('revision'), auto: true }],
      indexes: [primary('revision')],
      checks: []
    },
    {
      name: 'snapshot_journal_invalid',
      columns: [integer('id'), column('reason', 'varchar(32)')],
      indexes: [primary('id')],
      checks: [
        '(`id` = 1)',
        "(`reason` in (_utf8mb4'capacity-exhausted',_utf8mb4'revision-exhausted',_utf8mb4'key-out-of-range'))"
      ]
    },
    {
      name: 'snapshot_journal_physical',
      columns: [...physicalColumns, big('revision'), big('generation'), column('present', 'tinyint')],
      indexes: [
        primary(...physicalKey),
        {
          name: 'snapshot_journal_physical_page',
          columns: ['tableId', 'revision', 'id1', 'id2', 'exactText'],
          unique: false
        }
      ],
      checks: []
    },
    {
      name: 'snapshot_journal_scope',
      columns: [integer('tableId'), big('userId'), ...physicalColumns.slice(1), ...metadataColumns],
      indexes: [
        primary('tableId', 'userId', 'id1', 'id2', 'exactText'),
        {
          name: 'snapshot_journal_scope_page',
          columns: ['userId', 'tableId', 'revision', 'id1', 'id2', 'exactText'],
          unique: false
        }
      ],
      checks: []
    },
    {
      name: 'snapshot_journal_bootstrap',
      columns: [
        integer('id'),
        integer('stream'),
        { ...column('cursor', 'text'), nullable: true },
        { ...integer('rowLimit'), nullable: true },
        integer('rowsUsed')
      ],
      indexes: [primary('id')],
      checks: [
        '(`id` = 1)',
        '(`stream` between 0 and 17)',
        '((`rowLimit` is null) or (`rowLimit` between 0 and 2147483647))',
        '(`rowsUsed` between 0 and 2147483647)',
        '((`rowLimit` is null) or (`rowsUsed` <= `rowLimit`))'
      ],
      seed: 'bootstrap'
    },
    {
      name: 'snapshot_journal_retention',
      columns: [
        integer('id'),
        column('floor', 'varchar(19)'),
        integer('receiptLimit'),
        column('receiptLifetimeMs', 'bigint')
      ],
      indexes: [primary('id')],
      checks: ['(`id` = 1)', '(`receiptLimit` between 1 and 128)', '(`receiptLifetimeMs` between 1 and 2592000000)'],
      seed: 'retention',
      charset: 'ascii'
    },
    {
      name: 'snapshot_journal_receipts',
      columns: [
        column('requestId', 'varchar(64)'),
        column('binding', 'varchar(64)'),
        column('highWater', 'varchar(19)'),
        column('floor', 'varchar(19)'),
        column('expiresAt', 'bigint')
      ],
      indexes: [
        primary('requestId'),
        { name: 'snapshot_journal_receipts_expiry', columns: ['expiresAt', 'requestId'], unique: false }
      ],
      checks: ['(`expiresAt` between 1 and 9007199254740991)'],
      charset: 'ascii'
    }
  ]
  return specs.map((spec, i) => ({
    ...spec,
    sql: spec.charset === 'ascii' ? ddl[i] : ddl[i].replace(/ ENGINE=InnoDB$/, '') + tail
  }))
}

async function plan(
  k: Knex,
  ceiling: SnapshotJournalRevision,
  receiptPolicy: SnapshotJournalReceiptPolicy,
  config?: Knex.MigratorConfig
): Promise<Plan> {
  const policy = snapshotJournalReceiptPolicy(receiptPolicy)
  client(k)
  if (snapshotJournalRevision(ceiling) === '0') return invalid()
  const source = await readSnapshotJournalMysqlBinding(k, config)
  const [contexts]: Context[][] = await k.raw(
    'SELECT @@sql_mode sqlMode,@@character_set_client charset,@@collation_connection collation,@@collation_database databaseCollation,CURRENT_USER() definer'
  )
  const context = contexts[0]
  const contextKeys: Array<keyof Context> = ['sqlMode', 'charset', 'collation', 'databaseCollation', 'definer']
  if (
    contexts.length !== 1 ||
    context === null ||
    typeof context !== 'object' ||
    Array.isArray(context) ||
    Object.keys(context).length !== contextKeys.length ||
    contextKeys.some(key => typeof context[key] !== 'string' || context[key].length > 4096)
  )
    return invalid()
  const triggers = (await snapshotJournalMysqlObserverSql(k)).map(sql => {
    const match =
      /^CREATE TRIGGER (snapshot_journal_[A-Za-z0-9_]+) AFTER (INSERT|UPDATE|DELETE) ON `([a-z_]+)` FOR EACH ROW (BEGIN .*)$/s.exec(
        sql
      )
    if (!match) return invalid()
    return { name: match[1], event: match[2], table: match[3], body: match[4], sql }
  })
  const objects: ObjectDefinition[] = [
    ...tables(k).map(definition => ({ type: 'table' as const, definition })),
    ...triggers.map(definition => ({ type: 'trigger' as const, definition }))
  ]
  if (objects.length !== objectCount || new Set(objects.map(object => object.definition.name)).size !== objects.length)
    return invalid()
  const digest = createHash('sha256')
    .update('snapshot-journal-mysql-plan-v1\n')
    .update(JSON.stringify([objects, context, policy]))
    .digest('hex')
  return { binding: { source, ceiling, plan: digest }, objects, context, receiptPolicy: policy }
}

async function reserved(k: Knex): Promise<Array<{ name: string; type: string }>> {
  const [tables]: Array<Array<{ name: string; type: string }>> = await k.raw(
    "SELECT TABLE_NAME name,TABLE_TYPE type FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND LOWER(LEFT(TABLE_NAME,17))='snapshot_journal_' ORDER BY TABLE_NAME LIMIT 130"
  )
  const [triggers]: Array<Array<{ name: string; type: string }>> = await k.raw(
    "SELECT TRIGGER_NAME name,'TRIGGER' type FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND LOWER(LEFT(TRIGGER_NAME,17))='snapshot_journal_' ORDER BY TRIGGER_NAME LIMIT 130"
  )
  if (tables.length + triggers.length > objectCount + 1) return invalid()
  return [...tables, ...triggers]
}
const owner = (epoch: string): string => 'snapshot-journal-owner:' + epoch
function triggerBody(trigger: Trigger, epoch: string): string {
  return trigger.body.replace(/^BEGIN /, 'BEGIN /* ' + owner(epoch) + ' */ ')
}

async function validateTable(k: Knex, table: Table, epoch: string): Promise<void> {
  const charset = table.charset ?? 'utf8mb4'
  const [actual]: Array<
    Array<{
      engine: string
      type: string
      collation: string
      rowFormat: string
      options: string
      comment: string
    }>
  > = await k.raw(
    'SELECT ENGINE engine,TABLE_TYPE type,TABLE_COLLATION collation,ROW_FORMAT rowFormat,CREATE_OPTIONS options,TABLE_COMMENT comment FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',
    [table.name]
  )
  if (
    actual.length !== 1 ||
    actual[0].engine !== 'InnoDB' ||
    actual[0].type !== 'BASE TABLE' ||
    actual[0].collation !== charset + '_bin' ||
    actual[0].rowFormat !== 'Dynamic' ||
    actual[0].options !== 'row_format=DYNAMIC' ||
    actual[0].comment !== owner(epoch)
  )
    return invalid()
  const [columns]: Array<
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
    [table.name]
  )
  if (
    columns.length !== table.columns.length ||
    columns.some((actual, i) => {
      const expected = table.columns[i],
        text = expected.type === 'text' || expected.type.startsWith('varchar')
      return (
        actual.name !== expected.name ||
        actual.type.replace(/^(int|tinyint|bigint)\(\d+\)/, '$1') !== expected.type ||
        actual.nullable !== (expected.nullable ? 'YES' : 'NO') ||
        actual.defaultValue !== null ||
        actual.extra !== (expected.auto ? 'auto_increment' : '') ||
        actual.charset !== (text ? charset : null) ||
        actual.collation !== (text ? charset + '_bin' : null) ||
        actual.expression !== ''
      )
    })
  )
    return invalid()
  const expectedIndexes = table.indexes.flatMap(index =>
    index.columns.map((columnName, i) => ({
      name: index.name,
      columnName,
      position: i + 1,
      nonUnique: index.unique ? 0 : 1,
      direction: 'A',
      prefix: null,
      type: 'BTREE',
      visible: 'YES',
      expression: null
    }))
  )
  const [indexes]: Array<Array<Record<string, unknown>>> = await k.raw(
    'SELECT INDEX_NAME name,COLUMN_NAME columnName,SEQ_IN_INDEX position,NON_UNIQUE nonUnique,COLLATION direction,SUB_PART prefix,INDEX_TYPE type,IS_VISIBLE visible,EXPRESSION expression FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX LIMIT 16',
    [table.name]
  )
  if (JSON.stringify(indexes) !== JSON.stringify(expectedIndexes)) return invalid()
  const [constraints]: Array<Array<{ name: string; type: string; enforced: string; clause: string | null }>> =
    await k.raw(
      'SELECT t.CONSTRAINT_NAME name,t.CONSTRAINT_TYPE type,t.ENFORCED enforced,c.CHECK_CLAUSE clause FROM information_schema.TABLE_CONSTRAINTS t LEFT JOIN information_schema.CHECK_CONSTRAINTS c ON c.CONSTRAINT_SCHEMA=t.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME=t.CONSTRAINT_NAME WHERE t.TABLE_SCHEMA=DATABASE() AND t.TABLE_NAME=? ORDER BY t.CONSTRAINT_NAME LIMIT 8',
      [table.name]
    )
  const expectedConstraints = [
    { name: 'PRIMARY', type: 'PRIMARY KEY', enforced: 'YES', clause: null },
    ...table.checks.map((clause, i) => ({
      name: table.name + '_chk_' + (i + 1),
      type: 'CHECK',
      enforced: 'YES',
      clause: clause.replaceAll("'", "\\'")
    }))
  ]
  if (JSON.stringify(constraints) !== JSON.stringify(expectedConstraints)) return invalid()
  const [triggers]: unknown[][] = await k.raw(
    'SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=? LIMIT 1',
    [table.name]
  )
  const [partitions]: unknown[][] = await k.raw(
    'SELECT PARTITION_NAME FROM information_schema.PARTITIONS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND PARTITION_NAME IS NOT NULL LIMIT 1',
    [table.name]
  )
  const [foreign]: unknown[][] = await k.raw(
    'SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME=? LIMIT 1',
    [table.name]
  )
  if (triggers.length || partitions.length || foreign.length) return invalid()
}

async function validateObject(
  k: Knex,
  object: ObjectDefinition,
  state: SnapshotJournalMysqlIntent,
  context: Context,
  policy: SnapshotJournalReceiptPolicy
): Promise<void> {
  if (object.type === 'table') {
    await validateTable(k, object.definition, state.epoch)
    if (object.definition.seed === 'clock') {
      const clocks = await k('snapshot_journal_clock').select('id', k.raw('CAST(ceiling AS CHAR) ceiling')).limit(2)
      if (clocks.length !== 1 || clocks[0].id !== 1 || clocks[0].ceiling !== state.ceiling) return invalid()
    }
    if (object.definition.seed === 'bootstrap' && state.nextObject < objectCount) {
      const progress = await k('snapshot_journal_bootstrap').select('*').limit(2)
      if (
        progress.length !== 1 ||
        progress[0].id !== 1 ||
        progress[0].stream !== 0 ||
        progress[0].cursor !== null ||
        progress[0].rowLimit !== null ||
        progress[0].rowsUsed !== 0
      )
        return invalid()
    }
    if (object.definition.seed === 'retention') {
      const rows = await k('snapshot_journal_retention')
        .select(
          'id',
          'receiptLimit',
          k.raw('CAST(receiptLifetimeMs AS CHAR) receiptLifetimeMs'),
          k.raw('SUBSTRING(floor,1,20) floor')
        )
        .limit(2)
      if (
        rows.length !== 1 ||
        rows[0].id !== 1 ||
        rows[0].receiptLimit !== policy.receiptLimit ||
        rows[0].receiptLifetimeMs !== String(policy.receiptLifetimeMs)
      )
        return invalid()
      const floor = snapshotJournalRevision(rows[0].floor)
      if (
        compareSnapshotJournalRevisions(floor, state.ceiling) > 0 ||
        (state.nextObject < objectCount && floor !== '0')
      )
        return invalid()
    }
    return
  }
  const definition = object.definition,
    expectedBody = triggerBody(definition, state.epoch)
  const [rows]: Array<
    Array<{
      name: string
      table: string
      event: string
      timing: string
      body: string
      sqlMode: string
      charset: string
      collation: string
      databaseCollation: string
      definer: string
    }>
  > = await k.raw(
    'SELECT TRIGGER_NAME name,EVENT_OBJECT_TABLE `table`,EVENT_MANIPULATION event,ACTION_TIMING timing,SUBSTRING(ACTION_STATEMENT,1,?) body,SQL_MODE sqlMode,CHARACTER_SET_CLIENT charset,COLLATION_CONNECTION collation,DATABASE_COLLATION databaseCollation,DEFINER definer FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME=?',
    [expectedBody.length + 1, definition.name]
  )
  if (
    rows.length !== 1 ||
    rows[0].name !== definition.name ||
    rows[0].table !== definition.table ||
    rows[0].event !== definition.event ||
    rows[0].timing !== 'AFTER' ||
    rows[0].body !== expectedBody ||
    Object.entries(context).some(([key, value]) => rows[0][key as keyof Context] !== value)
  )
    return invalid()
}

async function validateObjects(k: Knex, p: Plan, state: SnapshotJournalMysqlIntent): Promise<boolean> {
  if (state.nextObject > p.objects.length || (state.complete && state.nextObject !== p.objects.length)) return invalid()
  const actual = await reserved(k)
  const intent = actual.filter(object => object.name === SNAPSHOT_JOURNAL_MYSQL_INTENT && object.type === 'BASE TABLE')
  if (intent.length !== 1) return invalid()
  const expected = p.objects.slice(0, state.nextObject + 1)
  if (
    actual.some(
      object =>
        object.name !== SNAPSHOT_JOURNAL_MYSQL_INTENT &&
        !expected.some(
          value =>
            value.definition.name === object.name && object.type === (value.type === 'table' ? 'BASE TABLE' : 'TRIGGER')
        )
    )
  )
    return invalid()
  let currentExists = false
  await runInSeries(p.objects.entries(), async ([i, object]) => {
    const found = actual.filter(row => row.name === object.definition.name)
    if ((i < state.nextObject && found.length !== 1) || found.length > 1) return invalid()
    if (found.length === 1) {
      await validateObject(k, object, state, p.context, p.receiptPolicy)
      if (i === state.nextObject) currentExists = true
    }
  })
  return currentExists
}

async function validateState(
  k: Knex,
  p: Plan,
  state: SnapshotJournalMysqlIntent
): Promise<SnapshotJournalMysqlGeneration> {
  if (await k('snapshot_journal_events').first('revision')) return invalid()
  const receipts = await k('snapshot_journal_receipts')
    .select(k.raw('1 AS occupied'))
    .limit(p.receiptPolicy.receiptLimit + 1)
  if (receipts.length > p.receiptPolicy.receiptLimit) return invalid()
  const clocks = await k('snapshot_journal_clock').select('id', k.raw('CAST(ceiling AS CHAR) ceiling')).limit(2)
  if (clocks.length !== 1 || clocks[0].id !== 1 || clocks[0].ceiling !== p.binding.ceiling) return invalid()
  const progress = await k('snapshot_journal_bootstrap').select('*').limit(2)
  if (progress.length !== 1) return invalid()
  const row = progress[0]
  if (
    row.id !== 1 ||
    !Number.isInteger(row.stream) ||
    row.stream < 0 ||
    row.stream > 17 ||
    !(row.cursor === null || (typeof row.cursor === 'string' && Buffer.byteLength(row.cursor, 'utf8') <= 2048)) ||
    (row.stream === 17 && row.cursor !== null) ||
    (state.complete && row.stream !== 17) ||
    !validSnapshotJournalBootstrapBudget(row) ||
    (row.rowLimit === null && (row.stream !== 0 || row.cursor !== null))
  )
    return invalid()
  const invalidations = await k('snapshot_journal_invalid').select('*').limit(2)
  if (
    invalidations.length > 1 ||
    invalidations.some(
      row => row.id !== 1 || !['capacity-exhausted', 'revision-exhausted', 'key-out-of-range'].includes(row.reason)
    )
  )
    return invalid()
  return { ...state, enabled: invalidations.length === 0 }
}

/** Excludes concurrent migrators and schema changes. Every implicit-DDL step is
 * preceded by durable intent; only that step may exist without its acknowledgement.
 * Epoch markers and complete typed metadata are required on every resume. No SQL
 * is loaded from persisted state, and no existing source/object is dropped.
 */
export async function installSnapshotJournalMysqlGeneration(
  k: Knex,
  ceiling: SnapshotJournalRevision,
  receiptPolicy: SnapshotJournalReceiptPolicy,
  config?: Knex.MigratorConfig
): Promise<SnapshotJournalMysqlGeneration> {
  if (k.isTransaction) return invalid()
  const p = await plan(k, ceiling, receiptPolicy, config)
  const existing = await reserved(k)
  let state =
    existing.length === 0
      ? await createSnapshotJournalMysqlIntent(k, p.binding)
      : await readSnapshotJournalMysqlIntent(k, p.binding)
  const currentExists = await validateObjects(k, p, state)
  const initial = state.nextObject
  await runInSeries(p.objects.entries(), async ([i, object]) => {
    if (i < initial) return
    if (!(i === initial && currentExists)) {
      if (object.type === 'trigger')
        await k.raw(object.definition.sql.replace(object.definition.body, triggerBody(object.definition, state.epoch)))
      else {
        const table = object.definition
        const sql = table.sql + " COMMENT='" + owner(state.epoch) + "'"
        if (table.seed === 'clock') await k.raw(sql + ' SELECT 1 id,? ceiling', [ceiling])
        else if (table.seed === 'bootstrap')
          await k.raw(sql + ' SELECT 1 id,0 stream,NULL `cursor`,NULL rowLimit,0 rowsUsed')
        else if (table.seed === 'retention')
          await k.raw(sql + " SELECT 1 id,'0' floor,? receiptLimit,? receiptLifetimeMs", [
            p.receiptPolicy.receiptLimit,
            p.receiptPolicy.receiptLifetimeMs
          ])
        else await k.raw(sql)
      }
      await validateObject(k, object, state, p.context, p.receiptPolicy)
    }
    const updated = await k(SNAPSHOT_JOURNAL_MYSQL_INTENT)
      .where({ id: 1, epoch: state.epoch, nextObject: i, complete: 0 })
      .update({ nextObject: i + 1 })
    if (updated !== 1) return invalid()
    state = { ...state, nextObject: i + 1 }
  })
  if ((await readSnapshotJournalMysqlBinding(k, config)) !== p.binding.source) return invalid()
  await validateObjects(k, p, state)
  return await validateState(k, p, state)
}

export async function readSnapshotJournalMysqlGeneration(
  k: Knex,
  ceiling: SnapshotJournalRevision,
  receiptPolicy: SnapshotJournalReceiptPolicy,
  config?: Knex.MigratorConfig
): Promise<SnapshotJournalMysqlGeneration> {
  const p = await plan(k, ceiling, receiptPolicy, config),
    state = await readSnapshotJournalMysqlIntent(k, p.binding)
  if (state.nextObject !== p.objects.length) return invalid()
  await validateObjects(k, p, state)
  return await validateState(k, p, state)
}

/** Publication still requires the registered migration journal in the reader view. */
export async function completeSnapshotJournalMysqlGeneration(
  k: Knex,
  ceiling: SnapshotJournalRevision,
  receiptPolicy: SnapshotJournalReceiptPolicy,
  config?: Knex.MigratorConfig
): Promise<SnapshotJournalMysqlGeneration> {
  const validated = await readSnapshotJournalMysqlGeneration(k, ceiling, receiptPolicy, config)
  return await k.transaction(async t => {
    if (!(await t('snapshot_journal_clock').where('id', 1).forUpdate().noWait().first('id'))) return invalid()
    const state = await readSnapshotJournalMysqlIntent(t, validated)
    if (state.epoch !== validated.epoch || state.nextObject !== objectCount) return invalid()
    const progress = await t('snapshot_journal_bootstrap').where('id', 1).first('stream', 'cursor')
    if (
      !progress ||
      progress.stream !== 17 ||
      progress.cursor !== null ||
      (await t('snapshot_journal_invalid').where('id', 1).first('id'))
    )
      return invalid()
    const updated = await t(SNAPSHOT_JOURNAL_MYSQL_INTENT)
      .where({ id: 1, epoch: state.epoch, nextObject: objectCount })
      .update({ complete: 1 })
    if (updated !== 1) return invalid()
    return { ...state, complete: true, enabled: true }
  })
}
