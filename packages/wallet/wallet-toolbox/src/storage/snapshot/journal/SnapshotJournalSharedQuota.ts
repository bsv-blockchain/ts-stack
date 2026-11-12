import { snapshotJournalFieldCacheNames, snapshotJournalFieldCacheTriggers } from './SnapshotJournalNativePayload'
import { isOwnedNativeSqlite } from '../../schema/ownedNativeSqliteRuntimeNode'
import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'

export const SNAPSHOT_JOURNAL_SHARED_QUOTA = 'snapshot_reconciliation_shared_quota'
export const SNAPSHOT_JOURNAL_SHARED_BYTE_LIMIT = 17179869184
export const SNAPSHOT_JOURNAL_SHARED_ROW_LIMIT = 2147483647
export function snapshotJournalSharedQuotaDdl(k: Knex): string {
  const mysql = ['mysql', 'mysql2'].includes(String(k.client.config.client))
  return (
    'CREATE TABLE ' +
    SNAPSHOT_JOURNAL_SHARED_QUOTA +
    '(id INTEGER NOT NULL,byteLimit BIGINT NOT NULL,rowLimit INTEGER NOT NULL,bytes BIGINT NOT NULL,`rows` INTEGER NOT NULL,changeBit INTEGER NOT NULL,PRIMARY KEY(id))' +
    (mysql ? ' ENGINE=InnoDB DEFAULT CHARACTER SET ascii COLLATE ascii_bin ROW_FORMAT=DYNAMIC' : '')
  )
}
export interface SnapshotJournalQuotaTrigger {
  name: string
  table: string
  event: 'INSERT' | 'UPDATE' | 'DELETE'
  timing?: 'BEFORE' | 'AFTER'
  body: string
  sql: string
}
function invalid(): never {
  throw new WERR_INVALID_OPERATION('Shared journal quota differs from its owned source')
}

/** Fixed authored DDL only. Charge every auxiliary row, index/key overhead and
 * raw payload by a conservative logical byte allowance. All windows, users,
 * lineages and provider replicas share one durable counter. AFTER triggers
 * correctly distinguish real inserts from conflict/upsert UPDATE paths.
 * Exhaustion rolls back data, counters and destination ACK in the SAME writer.
 */
export function snapshotJournalSharedQuotaTriggers(k: Knex, ddl: readonly string[]): SnapshotJournalQuotaTrigger[] {
  const mysql = ['mysql', 'mysql2'].includes(String(k.client.config.client))
  return quotaTriggers(ddl, mysql, !mysql && isOwnedNativeSqlite(k))
}

/** Exact historical SQLite grammar. Native owner handoff preserves these
 * definitions; selecting their source never grants or fabricates ownership. */
export function snapshotJournalOrdinarySqliteQuotaTriggers(ddl: readonly string[]): SnapshotJournalQuotaTrigger[] {
  return quotaTriggers(ddl, false, false)
}

function quotaTriggers(ddl: readonly string[], mysql: boolean, native: boolean): SnapshotJournalQuotaTrigger[] {
  const result: SnapshotJournalQuotaTrigger[] = []
  for (const sql of ddl.filter(value => value.startsWith('CREATE TABLE '))) {
    const match = /^CREATE TABLE (snapshot_reconciliation_\w+)\((.*)\)(?: ENGINE=.*)?$/.exec(sql)
    if (!match) invalid()
    const table = match[1]
    if (table === SNAPSHOT_JOURNAL_SHARED_QUOTA) continue
    const columns = [
      ...match[2].matchAll(
        /(?:^|,)`?(\w+)`? (BIGINT|INTEGER|VARCHAR\([1-9]\d*\)|VARBINARY\([1-9]\d*\)|TEXT|MEDIUMTEXT|LONGBLOB|BLOB) NOT NULL/g
      )
    ].map(value => value[1])
    if (!columns.length || columns.length > 32) invalid()
    const charge = (side: 'OLD' | 'NEW') =>
      native
        ? 'brc38_shared_row_charge(' + columns.map(name => side + '."' + name + '"').join(',') + ')'
        : '4096+' +
          columns
            .map(name =>
              mysql
                ? '4*coalesce(octet_length(' + side + '.`' + name + '`),0)'
                : '4*coalesce(length(cast(' + side + '."' + name + '" as blob)),0)'
            )
            .join('+')
    for (const event of ['INSERT', 'UPDATE', 'DELETE'] as const) {
      const before = event === 'INSERT' ? '0' : '(' + charge('OLD') + ')',
        after = event === 'DELETE' ? '0' : '(' + charge('NEW') + ')'
      const delta = event === 'INSERT' ? 1 : event === 'DELETE' ? -1 : 0
      // SQLite stores each complete trigger definition in its physical schema.
      // Compute the same two charges once rather than repeating their complete
      // column expressions in every SET and guard. The original byte/row limits,
      // atomic counter update and changes() refusal remain identical.
      const oldCharge = mysql ? before : 'quota_change.beforeBytes',
        newCharge = mysql ? after : 'quota_change.afterBytes'
      const change =
        'UPDATE ' +
        SNAPSHOT_JOURNAL_SHARED_QUOTA +
        ' SET bytes=bytes-' +
        oldCharge +
        '+' +
        newCharge +
        ',`rows`=`rows`+' +
        delta +
        ',changeBit=1-changeBit' +
        (mysql ? '' : ' FROM (SELECT ' + before + ' AS beforeBytes,' + after + ' AS afterBytes) AS quota_change') +
        ' WHERE id=0 AND changeBit IN (0,1) AND bytes>=' +
        oldCharge +
        ' AND bytes-' +
        oldCharge +
        '+(' +
        newCharge +
        ')<=byteLimit AND `rows`>=' +
        String(delta < 0 ? 1 : 0) +
        ' AND `rows`+' +
        delta +
        '<=rowLimit AND byteLimit=' +
        SNAPSHOT_JOURNAL_SHARED_BYTE_LIMIT +
        ' AND rowLimit=' +
        SNAPSHOT_JOURNAL_SHARED_ROW_LIMIT +
        ';'
      // The genuine native producer supplies the same pure counter predicate.
      // Its arithmetic result is consumed by this atomic SQL UPDATE; it retains
      // no database/owner state and raises the same constraint on exhaustion.
      const nativeChange =
        'UPDATE ' +
        SNAPSHOT_JOURNAL_SHARED_QUOTA +
        ' SET bytes=brc38_shared_quota_next_bytes(bytes,`rows`,changeBit,byteLimit,rowLimit,' +
        before +
        ',' +
        after +
        ',' +
        delta +
        '),`rows`=`rows`+' +
        delta +
        ',changeBit=1-changeBit WHERE id=0;'
      const body = mysql
        ? 'BEGIN ' +
          change +
          " IF ROW_COUNT()<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Shared journal quota exhausted or inconsistent'; END IF; END"
        : 'BEGIN ' +
          (native ? nativeChange : change) +
          " SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'Shared journal quota exhausted or inconsistent') END; END"
      const name =
        'snapshot_reconciliation_quota_' + table.slice('snapshot_reconciliation_'.length) + '_' + event.toLowerCase()
      if (name.length > 64) invalid()
      const statement =
        'CREATE TRIGGER ' + name + ' AFTER ' + event + ' ON ' + table + ' ' + (mysql ? 'FOR EACH ROW ' : '') + body
      result.push({ name, table, event, body, sql: statement })
    }
  }
  if (ddl.some(sql => sql.startsWith('CREATE TABLE ' + snapshotJournalFieldCacheNames.versions + '(')))
    result.push(...snapshotJournalFieldCacheTriggers(mysql))
  return result
}
export async function verifySnapshotJournalSharedQuota(k: Knex): Promise<void> {
  const mysql = ['mysql', 'mysql2'].includes(String(k.client.config.client))
  const rows: Array<Record<string, unknown>> = await k(SNAPSHOT_JOURNAL_SHARED_QUOTA)
    .select(
      'id',
      k.raw(mysql ? 'CAST(byteLimit AS CHAR) AS byteLimit' : 'CAST(byteLimit AS TEXT) AS byteLimit'),
      k.raw(mysql ? 'CAST(bytes AS CHAR) AS bytes' : 'CAST(bytes AS TEXT) AS bytes'),
      'rowLimit',
      'rows',
      'changeBit'
    )
    .limit(2)
  if (
    rows.length !== 1 ||
    ![0, 1].includes(Number(rows[0].changeBit)) ||
    Number(rows[0].id) !== 0 ||
    rows[0].byteLimit !== String(SNAPSHOT_JOURNAL_SHARED_BYTE_LIMIT) ||
    Number(rows[0].rowLimit) !== SNAPSHOT_JOURNAL_SHARED_ROW_LIMIT ||
    typeof rows[0].bytes !== 'string' ||
    !/^(?:0|[1-9]\d{0,10})$/.test(rows[0].bytes) ||
    Number(rows[0].bytes) > SNAPSHOT_JOURNAL_SHARED_BYTE_LIMIT ||
    !Number.isSafeInteger(Number(rows[0].rows)) ||
    Number(rows[0].rows) < 0 ||
    Number(rows[0].rows) > SNAPSHOT_JOURNAL_SHARED_ROW_LIMIT
  )
    invalid()
}

export async function seedSnapshotJournalSharedQuota(k: Knex, ddl: readonly string[]): Promise<void> {
  const rows = await k(SNAPSHOT_JOURNAL_SHARED_QUOTA).select('id').limit(2)
  if (rows.length) {
    await verifySnapshotJournalSharedQuota(k)
    return
  }
  // An interrupted schema with pre-existing auxiliary payloads cannot start a
  // zero counter. Never scan/recalculate and silently adopt unaccounted data.
  for (const sql of ddl.filter(value => value.startsWith('CREATE TABLE '))) {
    const name = /^CREATE TABLE (\w+)/.exec(sql)?.[1]
    if (name === undefined) invalid()
    if (
      name !== SNAPSHOT_JOURNAL_SHARED_QUOTA &&
      (await k.schema.hasTable(name)) &&
      (await k(name).select(k.raw('1 AS occupied')).limit(1)).length
    )
      invalid()
  }
  await k(SNAPSHOT_JOURNAL_SHARED_QUOTA).insert({
    id: 0,
    byteLimit: SNAPSHOT_JOURNAL_SHARED_BYTE_LIMIT,
    rowLimit: SNAPSHOT_JOURNAL_SHARED_ROW_LIMIT,
    bytes: 0,
    rows: 0,
    changeBit: 0
  })
  await verifySnapshotJournalSharedQuota(k)
}

/** Fresh MySQL trigger body and creation-context verification. A trigger name,
 * recorded installation flag or cached source verdict cannot stand in for it. */
export async function verifySnapshotJournalQuotaMysqlTriggers(
  k: Knex,
  expected: readonly SnapshotJournalQuotaTrigger[],
  tables: readonly string[]
): Promise<void> {
  const [contexts]: Array<
    Array<{ sqlMode: unknown; charset: unknown; collation: unknown; definer: unknown; databaseCollation: unknown }>
  > = await k.raw(
    'SELECT @@sql_mode AS sqlMode,@@character_set_client AS charset,@@collation_connection AS collation,CURRENT_USER() AS definer,(SELECT DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=DATABASE()) AS databaseCollation'
  )
  if (contexts.length !== 1) invalid()
  const context = contexts[0]
  const rows: Array<Record<string, unknown>> = await k('information_schema.TRIGGERS')
    .whereRaw('TRIGGER_SCHEMA=DATABASE()')
    .whereIn('EVENT_OBJECT_TABLE', [...tables])
    .select(
      'TRIGGER_NAME',
      'EVENT_OBJECT_TABLE',
      'EVENT_MANIPULATION',
      'ACTION_TIMING',
      k.raw('substr(ACTION_STATEMENT,1,16385) AS ACTION_STATEMENT'),
      'SQL_MODE',
      'CHARACTER_SET_CLIENT',
      'COLLATION_CONNECTION',
      'DATABASE_COLLATION',
      'DEFINER'
    )
    .limit(129)
  if (
    rows.length !== expected.length ||
    rows.some(
      row =>
        !expected.some(
          value =>
            row.TRIGGER_NAME === value.name &&
            row.EVENT_OBJECT_TABLE === value.table &&
            row.EVENT_MANIPULATION === value.event &&
            row.ACTION_TIMING === (value.timing ?? 'AFTER') &&
            row.ACTION_STATEMENT === value.body &&
            row.SQL_MODE === context.sqlMode &&
            row.CHARACTER_SET_CLIENT === context.charset &&
            row.COLLATION_CONNECTION === context.collation &&
            row.DATABASE_COLLATION === context.databaseCollation &&
            row.DEFINER === context.definer
        )
    )
  )
    invalid()
}
