import type { Knex } from 'knex'
import { createHash } from 'node:crypto'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { runInSeries } from '../../../utility/runInSeries'
import { numeric } from '../../schema/snapshotSqliteMembership'
import { snapshotGlobalIndexTriggers } from '../../schema/snapshotGlobalIndexTriggers'
import { readSnapshotGlobalIndexState } from '../../schema/snapshotGlobalIndexMigration'
import {
  snapshotProfileTriggerDefinition,
  readSnapshotProfileIndexState
} from '../../schema/snapshotProfileIndexMigration'
import {
  snapshotRelationIndexTriggers,
  readSnapshotRelationIndexState
} from '../../schema/snapshotRelationIndexMigration'
import {
  snapshotCertificateIndexTriggers,
  readSnapshotCertificateIndexState
} from '../../schema/snapshotCertificateIndexMigration'

function invalid(): never {
  throw new WERR_INVALID_OPERATION('Unsupported or incomplete MySQL snapshot journal source')
}
interface SourceColumn {
  tableName: string
  name: string
  type: string
  nullable: string
  extra: string
}
function validateNumericColumns(columns: SourceColumn[]): void {
  for (const source of numeric) {
    for (const name of [source.key, ...(source.owner ? [source.owner] : [])]) {
      const found = columns.filter(column => column.tableName === source.table && column.name === name)
      if (
        found.length !== 1 ||
        found[0].type.replaceAll(/\(\d+\)/g, '') !== 'int unsigned' ||
        found[0].nullable !== 'NO' ||
        !(found[0].extra === '' || (name === source.key && found[0].extra === 'auto_increment'))
      )
        return invalid()
    }
  }
}
/** Read-only prerequisite guard; ownership/install intents and epoch/receipt provenance remain the migrator's responsibility. */
export async function validateSnapshotJournalMysqlSource(k: Knex, config?: Knex.MigratorConfig): Promise<void> {
  if (!['mysql', 'mysql2'].includes(k.client.config.client)) return invalid()
  await runInSeries(
    [
      readSnapshotProfileIndexState,
      readSnapshotRelationIndexState,
      readSnapshotCertificateIndexState,
      readSnapshotGlobalIndexState
    ],
    async read => {
      if (!(await read(k, config))) invalid()
    }
  )
  const sourceTables = [
    ...numeric.map(source => source.table),
    'tx_labels_map',
    'output_tags_map',
    'certificate_fields'
  ]
  const [tables]: Array<Array<{ name: string; engine: string; type: string }>> = await k.raw(
    'SELECT TABLE_NAME name,ENGINE engine,TABLE_TYPE type FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (' +
      sourceTables.map(() => '?').join(',') +
      ')',
    sourceTables
  )
  if (
    tables.length !== sourceTables.length ||
    tables.some(table => table.engine !== 'InnoDB' || table.type !== 'BASE TABLE')
  )
    return invalid()
  const [columns]: Array<SourceColumn[]> = await k.raw(
    'SELECT TABLE_NAME tableName,COLUMN_NAME name,COLUMN_TYPE type,IS_NULLABLE nullable,EXTRA extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (' +
      sourceTables.map(() => '?').join(',') +
      ') ORDER BY TABLE_NAME,ORDINAL_POSITION LIMIT 513',
    sourceTables
  )
  const [parts]: Array<
    Array<{
      tableName: string
      name: string
      columnName: string
      nonUnique: number
      direction: string
      prefix: unknown
      visible: string
    }>
  > = await k.raw(
    'SELECT TABLE_NAME tableName,INDEX_NAME name,COLUMN_NAME columnName,NON_UNIQUE nonUnique,COLLATION direction,SUB_PART prefix,IS_VISIBLE visible FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (' +
      sourceTables.map(() => '?').join(',') +
      ') ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX LIMIT 513',
    sourceTables
  )
  if (columns.length > 512 || parts.length > 512) return invalid()
  validateNumericColumns(columns)
  const identities = [
    ...numeric.map(source => ({ table: source.table, keys: [source.key], primary: true })),
    { table: 'tx_labels_map', keys: ['txLabelId', 'transactionId'], primary: false },
    { table: 'output_tags_map', keys: ['outputTagId', 'outputId'], primary: false },
    { table: 'certificate_fields', keys: ['fieldName', 'certificateId'], primary: false }
  ]
  for (const source of identities) {
    const candidates = parts.filter(part => part.tableName === source.table && part.nonUnique === 0)
    const matches = [...new Set(candidates.map(part => part.name))].some(name => {
      const index = candidates.filter(part => part.name === name)
      return (
        (!source.primary || name === 'PRIMARY') &&
        index.length === source.keys.length &&
        index.every(
          (part, i) =>
            part.columnName === source.keys[i] &&
            part.direction === 'A' &&
            part.prefix === null &&
            part.visible === 'YES'
        )
      )
    })
    if (!matches) return invalid()
  }
  const [rules]: Array<Array<{ updateRule: string; deleteRule: string }>> = await k.raw(
    'SELECT UPDATE_RULE updateRule,DELETE_RULE deleteRule FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME IN (' +
      sourceTables.map(() => '?').join(',') +
      ')',
    sourceTables
  )
  if (
    rules.some(
      rule => ![rule.updateRule, rule.deleteRule].every(value => value === 'RESTRICT' || value === 'NO ACTION')
    )
  )
    return invalid()
  const profile = numeric
    .filter(source => source.owner !== undefined)
    .flatMap((source, tableId) =>
      (['INSERT', 'UPDATE', 'DELETE'] as const).map(event => ({
        ...snapshotProfileTriggerDefinition(true, source.table, source.key, tableId, event),
        table: source.table,
        event,
        timing: 'AFTER'
      }))
    )
  const relation = snapshotRelationIndexTriggers(true),
    certificate = snapshotCertificateIndexTriggers(true)
  const expected = [
    ...profile,
    ...relation.observers,
    ...relation.producers,
    ...certificate.observers,
    ...certificate.producers,
    ...snapshotGlobalIndexTriggers(true)
  ]
  const maximum = Math.max(...expected.map(trigger => Buffer.byteLength(trigger.body, 'utf8'))) + 1
  const [actual]: Array<Array<{ name: string; table: string; event: string; timing: string; body: string }>> =
    await k.raw(
      'SELECT TRIGGER_NAME name,EVENT_OBJECT_TABLE `table`,EVENT_MANIPULATION event,ACTION_TIMING timing,SUBSTRING(ACTION_STATEMENT,1,?) body FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME IN (' +
        expected.map(() => '?').join(',') +
        ')',
      [maximum, ...expected.map(trigger => trigger.name)]
    )
  if (actual.length !== expected.length) return invalid()
  for (const trigger of expected) {
    const found = actual.filter(row => row.name === trigger.name)
    if (
      found.length !== 1 ||
      found[0].table !== trigger.table ||
      found[0].event !== trigger.event ||
      found[0].timing !== trigger.timing ||
      found[0].body !== trigger.body
    )
      return invalid()
  }
}

/** Bind static source semantics, never row counts, statistics or AUTO_INCREMENT positions.
 * Call only with operator-owned schema changes excluded; this read is not a DDL lock.
 * The epoch owner persists the returned digest and refuses a different binding.
 */
export async function readSnapshotJournalMysqlBinding(k: Knex, config?: Knex.MigratorConfig): Promise<string> {
  await validateSnapshotJournalMysqlSource(k, config)
  const tables = [
    ...numeric.map(source => source.table),
    'tx_labels_map',
    'output_tags_map',
    'certificate_fields',
    'users',
    'settings',
    'snapshot_profile_keys',
    'snapshot_relation_keys',
    'snapshot_certificate_field_keys',
    'snapshot_global_edges',
    'snapshot_global_keys',
    'snapshot_global_guards'
  ]
  const marks = tables.map(() => '?').join(',')
  const journalNames = [
    ...Array.from({ length: 4 }, (_, i) => 'snapshot_journal_scope_' + i),
    ...Array.from({ length: 13 }, (_, i) => 'snapshot_journal_physical_' + i)
  ].flatMap(prefix => ['INSERT', 'UPDATE', 'DELETE'].map(event => prefix + '_' + event))
  // Hard query cardinality and value limits keep metadata capture independent of wallet size.
  // Reject truncation rather than hashing a prefix as if it described the whole schema.
  const bound = (column: string) => `SUBSTRING(${column},1,16385)`
  const definitions = [
    [
      'tables',
      `SELECT TABLE_NAME name,ENGINE engine,TABLE_TYPE type,TABLE_COLLATION collation,ROW_FORMAT rowFormat,${bound('CREATE_OPTIONS')} options FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${marks}) ORDER BY TABLE_NAME`
    ],
    [
      'columns',
      `SELECT TABLE_NAME tableName,COLUMN_NAME name,ORDINAL_POSITION position,COLUMN_TYPE type,IS_NULLABLE nullable,${bound('COLUMN_DEFAULT')} defaultValue,EXTRA extra,CHARACTER_SET_NAME charset,COLLATION_NAME collation,${bound('GENERATION_EXPRESSION')} expression FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${marks}) ORDER BY TABLE_NAME,ORDINAL_POSITION`
    ],
    [
      'indexes',
      `SELECT TABLE_NAME tableName,INDEX_NAME name,SEQ_IN_INDEX position,COLUMN_NAME columnName,NON_UNIQUE nonUnique,COLLATION direction,SUB_PART prefix,NULLABLE nullable,INDEX_TYPE type,IS_VISIBLE visible,${bound('EXPRESSION')} expression FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${marks}) ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX`
    ],
    [
      'foreignKeys',
      `SELECT TABLE_NAME tableName,CONSTRAINT_NAME name,ORDINAL_POSITION position,COLUMN_NAME columnName,REFERENCED_TABLE_SCHEMA foreignSchema,REFERENCED_TABLE_NAME foreignTable,REFERENCED_COLUMN_NAME foreignColumn FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${marks}) AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY TABLE_NAME,CONSTRAINT_NAME,ORDINAL_POSITION`
    ],
    [
      'foreignRules',
      `SELECT TABLE_NAME tableName,CONSTRAINT_NAME name,MATCH_OPTION matchOption,UPDATE_RULE updateRule,DELETE_RULE deleteRule FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME IN (${marks}) ORDER BY TABLE_NAME,CONSTRAINT_NAME`
    ],
    [
      'checks',
      `SELECT t.TABLE_NAME tableName,t.CONSTRAINT_NAME name,t.ENFORCED enforced,${bound('c.CHECK_CLAUSE')} clause FROM information_schema.TABLE_CONSTRAINTS t JOIN information_schema.CHECK_CONSTRAINTS c ON c.CONSTRAINT_SCHEMA=t.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME=t.CONSTRAINT_NAME WHERE t.TABLE_SCHEMA=DATABASE() AND t.TABLE_NAME IN (${marks}) AND t.CONSTRAINT_TYPE='CHECK' ORDER BY t.TABLE_NAME,t.CONSTRAINT_NAME`
    ],
    [
      'triggers',
      `SELECT EVENT_OBJECT_TABLE tableName,TRIGGER_NAME name,EVENT_MANIPULATION event,ACTION_TIMING timing,ACTION_ORDER actionOrder,DEFINER definer,${bound('ACTION_STATEMENT')} body,SQL_MODE sqlMode,CHARACTER_SET_CLIENT charset,COLLATION_CONNECTION connectionCollation,DATABASE_COLLATION databaseCollation FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE IN (${marks}) AND TRIGGER_NAME NOT IN (${journalNames.map(() => '?').join(',')}) ORDER BY EVENT_OBJECT_TABLE,TRIGGER_NAME`
    ]
  ] as const
  const digest = createHash('sha256').update('snapshot-journal-mysql-binding-v1\n')
  let bytes = 0
  await runInSeries(definitions, async ([kind, sql]) => {
    const [rows]: Array<Array<Record<string, unknown>>> = await k.raw(
      sql + ' LIMIT 513',
      kind === 'triggers' ? [...tables, ...journalNames] : tables
    )
    if (
      !Array.isArray(rows) ||
      rows.length > 512 ||
      rows.some(row =>
        Object.values(row).some(value => typeof value === 'string' && Buffer.byteLength(value, 'utf8') > 16384)
      )
    )
      invalid()
    if (
      kind === 'tables' &&
      (rows.length !== tables.length || rows.some(row => row.type !== 'BASE TABLE' || row.engine !== 'InnoDB'))
    )
      invalid()
    const canonical = JSON.stringify([kind, rows])
    bytes += Buffer.byteLength(canonical, 'utf8')
    if (bytes > 1048576) invalid()
    digest.update(canonical)
  })
  return digest.digest('hex')
}
