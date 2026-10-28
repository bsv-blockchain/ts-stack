import { verifyPrimaryHandoffTriggers } from '../../schema/primaryHandoffMigration'
import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { snapshotArchiveDatabaseNow } from '../archive/SnapshotArchiveSql'
import { snapshotJournalRevision } from './SnapshotJournalRevision'
import { snapshotJournalReceiptPolicy, type SnapshotJournalReceiptPolicy } from './SnapshotJournalReceipt'
import {
  readSnapshotJournalMysqlSourceInventory,
  snapshotJournalMysqlInventoryDigest,
  type SnapshotJournalMysqlSourceInventory
} from './SnapshotJournalMysqlSource'
import {
  readSnapshotJournalMysqlGeneration,
  readSnapshotJournalMysqlSourceUpgradeGeneration
} from './SnapshotJournalMysqlGeneration'
import {
  snapshotJournalSharedQuotaTriggers,
  verifySnapshotJournalQuotaMysqlTriggers,
  verifySnapshotJournalSharedQuota
} from './SnapshotJournalSharedQuota'

const table = 'snapshot_reconciliation_source_upgrades'
export const SNAPSHOT_JOURNAL_MYSQL_SOURCE_UPGRADE_DDL =
  'CREATE TABLE ' +
  table +
  '(id INTEGER NOT NULL,phase INTEGER NOT NULL,source VARCHAR(64) NOT NULL,epoch VARCHAR(36) NOT NULL,plan VARCHAR(64) NOT NULL,ceiling VARCHAR(19) NOT NULL,receiptLimit INTEGER NOT NULL,receiptLifetimeMs BIGINT NOT NULL,originalInventory MEDIUMTEXT NOT NULL,PRIMARY KEY(id)) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin ROW_FORMAT=DYNAMIC'
interface State {
  phase: 1 | 2
  source: string
  epoch: string
  plan: string
  ceiling: ReturnType<typeof snapshotJournalRevision>
  policy: SnapshotJournalReceiptPolicy
  inventory: SnapshotJournalMysqlSourceInventory[]
  originalInventory: string
}
function invalid(): never {
  throw new WERR_INVALID_OPERATION('Invalid or unowned MySQL journal source-index upgrade')
}
const expectedColumns = [
  ['id', 'int'],
  ['phase', 'int'],
  ['source', 'varchar(64)'],
  ['epoch', 'varchar(36)'],
  ['plan', 'varchar(64)'],
  ['ceiling', 'varchar(19)'],
  ['receiptLimit', 'int'],
  ['receiptLifetimeMs', 'bigint'],
  ['originalInventory', 'mediumtext']
] as const
async function verifyRecordSchema(k: Knex): Promise<void> {
  const objects: Array<Record<string, unknown>> = await k('information_schema.TABLES')
    .whereRaw('TABLE_SCHEMA=DATABASE()')
    .where('TABLE_NAME', table)
    .select('ENGINE', 'TABLE_TYPE', 'TABLE_COLLATION', 'ROW_FORMAT', 'CREATE_OPTIONS')
    .limit(2)
  if (
    objects.length !== 1 ||
    objects[0].ENGINE !== 'InnoDB' ||
    objects[0].TABLE_TYPE !== 'BASE TABLE' ||
    objects[0].TABLE_COLLATION !== 'utf8mb4_bin' ||
    objects[0].ROW_FORMAT !== 'Dynamic' ||
    objects[0].CREATE_OPTIONS !== 'row_format=DYNAMIC'
  )
    invalid()
  const columns: Array<Record<string, unknown>> = await k('information_schema.COLUMNS')
    .whereRaw('TABLE_SCHEMA=DATABASE()')
    .where('TABLE_NAME', table)
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
    .limit(10)
  if (
    columns.length !== expectedColumns.length ||
    columns.some((row, i) => {
      const [name, type] = expectedColumns[i],
        text = /^(varchar|mediumtext)/.test(type)
      return (
        row.COLUMN_NAME !== name ||
        String(row.COLUMN_TYPE).replace(/^(int|bigint)\(\d+\)$/, '$1') !== type ||
        row.IS_NULLABLE !== 'NO' ||
        row.COLUMN_DEFAULT !== null ||
        row.EXTRA !== '' ||
        row.GENERATION_EXPRESSION !== '' ||
        row.CHARACTER_SET_NAME !== (text ? 'utf8mb4' : null) ||
        row.COLLATION_NAME !== (text ? 'utf8mb4_bin' : null)
      )
    })
  )
    invalid()
  const indexes: Array<Record<string, unknown>> = await k('information_schema.STATISTICS')
    .whereRaw('TABLE_SCHEMA=DATABASE()')
    .where('TABLE_NAME', table)
    .select(
      'INDEX_NAME',
      'COLUMN_NAME',
      'NON_UNIQUE',
      'COLLATION',
      'SUB_PART',
      'INDEX_TYPE',
      'IS_VISIBLE',
      'EXPRESSION'
    )
    .limit(2)
  if (
    indexes.length !== 1 ||
    indexes[0].INDEX_NAME !== 'PRIMARY' ||
    indexes[0].COLUMN_NAME !== 'id' ||
    Number(indexes[0].NON_UNIQUE) !== 0 ||
    indexes[0].COLLATION !== 'A' ||
    indexes[0].SUB_PART !== null ||
    indexes[0].INDEX_TYPE !== 'BTREE' ||
    indexes[0].IS_VISIBLE !== 'YES' ||
    indexes[0].EXPRESSION !== null
  )
    invalid()
  const constraints: Array<Record<string, unknown>> = await k('information_schema.TABLE_CONSTRAINTS')
    .whereRaw('TABLE_SCHEMA=DATABASE()')
    .where('TABLE_NAME', table)
    .select('CONSTRAINT_NAME', 'CONSTRAINT_TYPE')
    .limit(2)
  if (
    constraints.length !== 1 ||
    constraints[0].CONSTRAINT_NAME !== 'PRIMARY' ||
    constraints[0].CONSTRAINT_TYPE !== 'PRIMARY KEY'
  )
    invalid()
  await verifySnapshotJournalQuotaMysqlTriggers(
    k,
    snapshotJournalSharedQuotaTriggers(k, [SNAPSHOT_JOURNAL_MYSQL_SOURCE_UPGRADE_DDL]),
    [table]
  )
  await verifySnapshotJournalSharedQuota(k)
}
async function read(k: Knex, recordId = 1): Promise<State | undefined> {
  await verifyRecordSchema(k)
  if ((await k(table).whereNotIn('id', [1, 2]).select('id').limit(1)).length) invalid()
  const rows: Array<Record<string, unknown>> = await k(table)
    .where('id', recordId)
    .select(
      'id',
      'phase',
      'receiptLimit',
      'receiptLifetimeMs',
      k.raw('CASE WHEN octet_length(source)=64 THEN source ELSE NULL END AS source'),
      k.raw('CASE WHEN octet_length(plan)=64 THEN plan ELSE NULL END AS plan'),
      k.raw('CASE WHEN octet_length(epoch)=36 THEN epoch ELSE NULL END AS epoch'),
      k.raw('CASE WHEN octet_length(ceiling) BETWEEN 1 AND 19 THEN ceiling ELSE NULL END AS ceiling'),
      k.raw(
        'CASE WHEN octet_length(originalInventory)<=1048576 THEN originalInventory ELSE NULL END AS originalInventory'
      )
    )
    .limit(2)
  if (rows.length > 1) invalid()
  if (!rows.length) return undefined
  const row = rows[0]
  if (
    Number(row.id) !== recordId ||
    ![1, 2].includes(Number(row.phase)) ||
    typeof row.source !== 'string' ||
    !/^[0-9a-f]{64}$/.test(row.source) ||
    typeof row.plan !== 'string' ||
    !/^[0-9a-f]{64}$/.test(row.plan) ||
    typeof row.epoch !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.epoch) ||
    typeof row.originalInventory !== 'string'
  )
    invalid()
  const inventory = JSON.parse(row.originalInventory) as SnapshotJournalMysqlSourceInventory[]
  if (
    !Array.isArray(inventory) ||
    inventory.length !== 7 ||
    JSON.stringify(inventory.map(value => value.kind)) !==
      JSON.stringify(['tables', 'columns', 'indexes', 'foreignKeys', 'foreignRules', 'checks', 'triggers']) ||
    inventory.some(
      value =>
        Object.keys(value).length !== 2 ||
        !Array.isArray(value.rows) ||
        value.rows.length > 512 ||
        value.rows.some(record => record === null || typeof record !== 'object' || Array.isArray(record))
    ) ||
    snapshotJournalMysqlInventoryDigest(inventory) !== row.source ||
    JSON.stringify(inventory) !== row.originalInventory
  )
    invalid()
  return {
    phase: Number(row.phase) as 1 | 2,
    source: row.source,
    epoch: row.epoch,
    plan: row.plan,
    ceiling: snapshotJournalRevision(row.ceiling),
    policy: snapshotJournalReceiptPolicy({
      receiptLimit: Number(row.receiptLimit),
      receiptLifetimeMs: Number(row.receiptLifetimeMs)
    }),
    inventory,
    originalInventory: row.originalInventory
  }
}
interface Index {
  name: string
  table: string
  columns: string[]
}
function indexes(statements: readonly string[]): Index[] {
  const result = statements.map(sql => {
    const match = /^CREATE INDEX (brc38_import_target_\w+) ON (\w+) \(([^)]+)\)$/.exec(sql)
    if (!match) invalid()
    return { name: match[1], table: match[2], columns: match[3].split(',').map(value => value.trim()) }
  })
  if (new Set(result.map(value => value.name)).size !== result.length || result.length > 32) invalid()
  return result
}
async function verifyPresentIndexes(k: Knex, owned: readonly Index[], complete: boolean): Promise<void> {
  for (const spec of owned) {
    const rows: Array<Record<string, unknown>> = await k('information_schema.STATISTICS')
      .whereRaw('TABLE_SCHEMA=DATABASE()')
      .where({ TABLE_NAME: spec.table, INDEX_NAME: spec.name })
      .select('COLUMN_NAME', 'NON_UNIQUE', 'COLLATION', 'SUB_PART', 'INDEX_TYPE', 'IS_VISIBLE', 'EXPRESSION')
      .orderBy('SEQ_IN_INDEX')
      .limit(17)
    if (!rows.length && !complete) continue
    if (
      rows.length !== spec.columns.length ||
      rows.some(
        (row, i) =>
          row.COLUMN_NAME !== spec.columns[i] ||
          Number(row.NON_UNIQUE) !== 1 ||
          row.COLLATION !== 'A' ||
          row.SUB_PART !== null ||
          row.INDEX_TYPE !== 'BTREE' ||
          row.IS_VISIBLE !== 'YES' ||
          row.EXPRESSION !== null
      )
    )
      invalid()
  }
}
async function currentInventory(
  k: Knex,
  state: State,
  owned: readonly Index[],
  primaryControl = false
): Promise<string> {
  const current = await readSnapshotJournalMysqlSourceInventory(k, k.client.config.migrations)
  if (current.length !== state.inventory.length) invalid()
  for (let i = 0; i < current.length; i++) {
    const previous = state.inventory[i],
      next = current[i]
    if (next.kind !== previous.kind) invalid()
    if (primaryControl && next.kind === 'triggers') {
      const names = new Set(['wallet_primary_control_guard', 'wallet_primary_control_consume'])
      if (previous.rows.some(row => names.has(String(row.name)))) invalid()
      const originalNames = new Set(previous.rows.map(row => String(row.tableName) + ':' + String(row.name)))
      const filtered = next.rows.filter(
        row =>
          originalNames.has(String(row.tableName) + ':' + String(row.name)) ||
          row.tableName !== 'users' ||
          !names.has(String(row.name))
      )
      if (JSON.stringify(filtered) !== JSON.stringify(previous.rows)) invalid()
      await verifyPrimaryHandoffTriggers(k, false, true)
      continue
    }
    if (next.kind !== 'indexes') {
      if (JSON.stringify(next.rows) !== JSON.stringify(previous.rows)) invalid()
      continue
    }
    const originalNames = new Set(previous.rows.map(row => String(row.tableName) + ':' + String(row.name)))
    const filtered = next.rows.filter(
      row =>
        originalNames.has(String(row.tableName) + ':' + String(row.name)) ||
        !owned.some(value => value.table === row.tableName && value.name === row.name)
    )
    if (JSON.stringify(filtered) !== JSON.stringify(previous.rows)) invalid()
  }
  await verifyPresentIndexes(k, owned, false)
  return snapshotJournalMysqlInventoryDigest(current)
}
async function lockGeneration(k: Knex): Promise<void> {
  const rows = await k('snapshot_journal_generation').where('id', 1).select('id').forUpdate().noWait().limit(2)
  if (rows.length !== 1) invalid()
}

/** Resumable MySQL DDL source addition. Before DDL, drain live receipts and
 * atomically retain the old inventory while marking the source incomplete.
 * Every resume independently verifies actual native semantics, journal objects,
 * epoch ownership and that only fixed additive indexes changed. No SQL or
 * authority verdict is loaded from the recovery record. Existing data, event
 * generations, physical epoch and counters stay intact; the changed source
 * digest fences all prior source bindings. */
export async function addSnapshotJournalMysqlSourceIndexes(
  k: Knex,
  statements: readonly string[],
  apply: () => Promise<void>
): Promise<void> {
  return await sourceAddition(k, statements, apply, false)
}
/** Fixed primary-control triggers only, independently verified before every
 * resume. Recovery DATA cannot select the allowed change or execute SQL. */
export async function addSnapshotJournalMysqlPrimaryControl(k: Knex, apply: () => Promise<void>): Promise<void> {
  return await sourceAddition(k, [], apply, true)
}
async function sourceAddition(
  k: Knex,
  statements: readonly string[],
  apply: () => Promise<void>,
  primaryControl: boolean
): Promise<void> {
  if (k.isTransaction || !['mysql', 'mysql2'].includes(String(k.client.config.client))) invalid()
  if (!(await k.schema.hasTable('snapshot_journal_generation'))) {
    await apply()
    return
  }
  const recordId = primaryControl ? 2 : 1
  const owned = indexes(statements)
  const verify = async (db: Knex, complete: boolean): Promise<void> => {
    await verifyPresentIndexes(db, owned, complete)
    if (primaryControl) await verifyPrimaryHandoffTriggers(db, complete, true)
  }
  if (!(await k.schema.hasTable(table))) await k.raw(SNAPSHOT_JOURNAL_MYSQL_SOURCE_UPGRADE_DDL)
  let state = await read(k, recordId)
  if (state === undefined) {
    await k.transaction(async trx => {
      await lockGeneration(trx)
      const policyRows: Array<Record<string, unknown>> = await trx('snapshot_journal_retention')
        .where('id', 1)
        .select('receiptLimit', 'receiptLifetimeMs')
        .limit(2)
      const generationRows: Array<{ ceiling: unknown }> = await trx('snapshot_journal_generation')
        .where('id', 1)
        .select(trx.raw('CASE WHEN octet_length(ceiling) BETWEEN 1 AND 19 THEN ceiling ELSE NULL END AS ceiling'))
        .limit(2)
      if (policyRows.length !== 1 || generationRows.length !== 1) invalid()
      const policy = snapshotJournalReceiptPolicy({
        receiptLimit: Number(policyRows[0].receiptLimit),
        receiptLifetimeMs: Number(policyRows[0].receiptLifetimeMs)
      })
      const ceiling = snapshotJournalRevision(generationRows[0].ceiling)
      const actual = await readSnapshotJournalMysqlGeneration(trx, ceiling, policy, trx.client.config.migrations)
      if (!actual.complete || !actual.enabled) invalid()
      if (
        (
          await trx('snapshot_journal_receipts')
            .where('expiresAt', '>', await snapshotArchiveDatabaseNow(trx))
            .select('requestId')
            .limit(1)
        ).length
      )
        throw new WERR_INVALID_OPERATION('Drain live journal captures before changing their source indexes')
      await verify(trx, false)
      const inventory = await readSnapshotJournalMysqlSourceInventory(trx, trx.client.config.migrations)
      if (snapshotJournalMysqlInventoryDigest(inventory) !== actual.source) invalid()
      const originalInventory = JSON.stringify(inventory)
      if (Buffer.byteLength(originalInventory, 'utf8') > 1048576) invalid()
      await trx(table).insert({
        id: recordId,
        phase: 1,
        source: actual.source,
        epoch: actual.epoch,
        plan: actual.plan,
        ceiling,
        receiptLimit: policy.receiptLimit,
        receiptLifetimeMs: policy.receiptLifetimeMs,
        originalInventory
      })
      if (
        (await trx('snapshot_journal_generation')
          .where({ id: 1, source: actual.source, epoch: actual.epoch, plan: actual.plan, complete: 1 })
          .update({ complete: 0 })) !== 1
      )
        invalid()
    })
    state = await read(k, recordId)
    if (state === undefined) invalid()
  }
  const before = await currentInventory(k, state, owned, primaryControl)
  if (state.phase === 2) {
    const actual = await readSnapshotJournalMysqlGeneration(k, state.ceiling, state.policy, k.client.config.migrations)
    if (
      !actual.complete ||
      !actual.enabled ||
      actual.epoch !== state.epoch ||
      actual.plan !== state.plan ||
      actual.source !== before
    )
      invalid()
    await verify(k, true)
    await apply()
    return
  }
  const actual = await readSnapshotJournalMysqlSourceUpgradeGeneration(
    k,
    state.source,
    state.ceiling,
    state.policy,
    k.client.config.migrations
  )
  if (
    actual.generation.complete ||
    !actual.generation.enabled ||
    actual.generation.epoch !== state.epoch ||
    actual.generation.plan !== state.plan ||
    actual.currentSource !== before
  )
    invalid()
  await apply()
  const after = await currentInventory(k, state, owned, primaryControl)
  await verify(k, true)
  const saved = state
  await k.transaction(async trx => {
    await lockGeneration(trx)
    const current = await read(trx, recordId)
    if (
      current === undefined ||
      current.phase !== 1 ||
      current.source !== saved.source ||
      current.epoch !== saved.epoch ||
      current.plan !== saved.plan ||
      current.originalInventory !== saved.originalInventory
    )
      invalid()
    const checked = await readSnapshotJournalMysqlSourceUpgradeGeneration(
      trx,
      saved.source,
      saved.ceiling,
      saved.policy,
      trx.client.config.migrations
    )
    if (
      checked.generation.complete ||
      !checked.generation.enabled ||
      checked.currentSource !== after ||
      checked.generation.epoch !== saved.epoch ||
      (await currentInventory(trx, saved, owned, primaryControl)) !== after
    )
      invalid()
    if (
      (await trx('snapshot_journal_generation')
        .where({ id: 1, source: saved.source, epoch: saved.epoch, plan: saved.plan, complete: 0 })
        .update({ source: after, complete: 1 })) !== 1 ||
      (await trx(table)
        .where({ id: recordId, phase: 1, source: saved.source, epoch: saved.epoch, plan: saved.plan })
        .update({ phase: 2 })) !== 1
    )
      invalid()
    const result = await readSnapshotJournalMysqlGeneration(
      trx,
      saved.ceiling,
      saved.policy,
      trx.client.config.migrations
    )
    if (!result.complete || !result.enabled || result.source !== after || result.epoch !== saved.epoch) invalid()
  })
}
