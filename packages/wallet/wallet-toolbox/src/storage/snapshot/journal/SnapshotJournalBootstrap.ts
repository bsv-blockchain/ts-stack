import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { runInSeries } from '../../../utility/runInSeries'
import { numeric, legacyNames } from '../../schema/snapshotSqliteMembership'
import { names } from '../../schema/snapshotSqliteIndexGeneration'
import { SNAPSHOT_JOURNAL_SQLITE_ADVANCE } from './SnapshotJournalSqliteClock'
import {
  compareSnapshotJournalRevisions,
  MAX_SNAPSHOT_JOURNAL_REVISION,
  snapshotJournalRevision,
  type SnapshotJournalRevision
} from './SnapshotJournalRevision'
import { snapshotJournalRevisionText, snapshotJournalRevisionOperand } from './SnapshotJournalRevisionSql'

export const SNAPSHOT_JOURNAL_BOOTSTRAP_DDL =
  'CREATE TABLE snapshot_journal_bootstrap(id INTEGER NOT NULL PRIMARY KEY,stream INTEGER NOT NULL,`cursor` TEXT,rowLimit INTEGER,rowsUsed INTEGER NOT NULL,CHECK(id=1),CHECK(stream BETWEEN 0 AND 17),CHECK(rowLimit IS NULL OR rowLimit BETWEEN 0 AND 2147483647),CHECK(rowsUsed BETWEEN 0 AND 2147483647),CHECK(rowLimit IS NULL OR rowsUsed<=rowLimit))'
interface Stream {
  table: string
  keys: string[]
  text?: string
  extra?: string
  physical: boolean
  record: (row: Record<string, unknown>) => Record<string, unknown>
}
/** A conservative charge counts every examined bootstrap record, including an
 * already-observed key. The bound survives retries without counting SQL affected
 * rows, whose semantics differ between the two drivers. */
export function validSnapshotJournalBootstrapBudget(row: { rowLimit: unknown; rowsUsed: unknown }): boolean {
  const bounded = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2147483647
  return (
    bounded(row.rowsUsed) &&
    (row.rowLimit === null ? row.rowsUsed === 0 : bounded(row.rowLimit) && row.rowsUsed <= row.rowLimit)
  )
}
function invalid(): never {
  throw new WERR_INVALID_OPERATION('Invalid snapshot journal bootstrap state or source order')
}
function sqlite(k: Knex): boolean {
  const client = k.client.config.client
  if (client === 'better-sqlite3' || client === 'sqlite3') return true
  if (client === 'mysql' || client === 'mysql2') return false
  return invalid()
}
function physicalKeys(table: string, key: string | undefined): string[] {
  if (key) return [key]
  if (table === 'tx_labels_map') return ['txLabelId', 'transactionId']
  if (table === 'output_tags_map') return ['outputTagId', 'outputId']
  return ['fieldName', 'certificateId']
}
function physicalRecord(
  tableId: number,
  key: string | undefined,
  row: Record<string, unknown>
): Record<string, unknown> {
  let id1 = row.certificateId,
    id2: unknown = 0
  if (key) id1 = row[key]
  else if (tableId === 10) {
    id1 = row.txLabelId
    id2 = row.transactionId
  } else if (tableId === 11) {
    id1 = row.outputTagId
    id2 = row.outputId
  }
  return { tableId, id1, id2, exactText: tableId === 12 ? row.fieldName : '', present: 1 }
}
function streams(local: boolean): Stream[] {
  const membership = local ? names : legacyNames
  const tables = [...numeric.map(source => source.table), 'tx_labels_map', 'output_tags_map', 'certificate_fields']
  const physical: Stream[] = tables.map((table, tableId) => {
    const key = numeric[tableId]?.key
    return {
      table,
      keys: physicalKeys(table, key),
      text: tableId === 12 ? 'fieldName' : undefined,
      physical: true,
      record: row => physicalRecord(tableId, key, row)
    }
  })
  return [
    ...physical,
    {
      table: membership.profile,
      keys: ['snapshotTableId', 'snapshotUserId', 'snapshotRowId'],
      physical: false,
      record: r => ({
        tableId: r.snapshotTableId,
        userId: r.snapshotUserId,
        id1: r.snapshotRowId,
        id2: 0,
        exactText: '',
        present: 1
      })
    },
    {
      table: membership.relation,
      keys: ['snapshotTableId', 'snapshotUserId', 'snapshotLeftId', 'snapshotRightId'],
      extra: 'snapshotMembership',
      physical: false,
      record: r => ({
        tableId: Number(r.snapshotTableId) + 10,
        userId: r.snapshotUserId,
        id1: r.snapshotLeftId,
        id2: r.snapshotRightId,
        exactText: '',
        present: Number(r.snapshotMembership) !== 0 ? 1 : 0
      })
    },
    {
      table: membership.certificate,
      keys: ['snapshotUserId', 'snapshotFieldName', 'snapshotCertificateId'],
      text: 'snapshotFieldName',
      extra: 'snapshotMembership',
      physical: false,
      record: r => ({
        tableId: 12,
        userId: r.snapshotUserId,
        id1: r.snapshotCertificateId,
        id2: 0,
        exactText: r.snapshotFieldName,
        present: Number(r.snapshotMembership) !== 0 ? 1 : 0
      })
    },
    {
      table: membership.keys,
      keys: ['tableId', 'userId', 'rowId'],
      extra: 'present',
      physical: false,
      record: r => ({
        tableId: r.tableId === 0 ? 9 : 8,
        userId: r.userId,
        id1: r.rowId,
        id2: 0,
        exactText: '',
        present: Number(r.present)
      })
    }
  ]
}
function validKey(record: Record<string, unknown>): boolean {
  const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
  const text = record.exactText
  return (
    integer(record.tableId, 0, 12) &&
    integer(record.id1, 1) &&
    integer(record.id2, 0) &&
    (record.userId === undefined || integer(record.userId, 1)) &&
    typeof text === 'string' &&
    Buffer.byteLength(text, 'utf8') <= 400 &&
    Buffer.from(text, 'utf8').toString('utf8') === text &&
    (record.present === 0 || record.present === 1)
  )
}
async function invalidate(k: Knex, reason: string): Promise<void> {
  if (sqlite(k)) await k('snapshot_journal_clock').where({ id: 1, enabled: 1 }).update({ enabled: 0, reason })
  else await k('snapshot_journal_invalid').insert({ id: 1, reason }).onConflict('id').ignore()
}
async function revision(k: Knex, local: boolean): Promise<SnapshotJournalRevision | undefined> {
  if (local) {
    await k.raw(SNAPSHOT_JOURNAL_SQLITE_ADVANCE)
    const row = await k('snapshot_journal_clock')
      .where('id', 1)
      .select('enabled', { value: snapshotJournalRevisionText(k, 'revision') })
      .first()
    if (!row || ![0, 1].includes(row.enabled)) return invalid()
    return row.enabled === 1 ? snapshotJournalRevision(row.value) : undefined
  }
  const row = await k('snapshot_journal_clock')
    .where('id', 1)
    .select({ ceiling: snapshotJournalRevisionText(k, 'ceiling') })
    .first()
  if (!row) return invalid()
  const ceiling = snapshotJournalRevision(row.ceiling)
  await k('snapshot_journal_events').insert({})
  const [[allocated]]: Array<Array<{ value: string }>> = await k.raw('SELECT CAST(LAST_INSERT_ID() AS CHAR) value')
  if (!allocated || typeof allocated.value !== 'string' || !/^\d+$/.test(allocated.value)) return invalid()
  await k('snapshot_journal_events').where('revision', allocated.value).delete()
  if (BigInt(allocated.value) > BigInt(MAX_SNAPSHOT_JOURNAL_REVISION)) {
    await invalidate(k, 'revision-exhausted')
    return undefined
  }
  const value = snapshotJournalRevision(allocated.value)
  if (compareSnapshotJournalRevisions(value, ceiling) > 0) {
    await invalidate(k, 'capacity-exhausted')
    return undefined
  }
  return value
}
async function mysqlSourceQuery(k: Knex, stream: Stream): Promise<{ query: Knex.QueryBuilder }> {
  const [parts]: Array<Array<{ name: string; field: string }>> = await k.raw(
    'SELECT INDEX_NAME name,COLUMN_NAME field FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX',
    [stream.table]
  )
  const indexes = new Map<string, string[]>()
  for (const part of parts) {
    if (!indexes.has(part.name)) indexes.set(part.name, [])
    indexes.get(part.name)!.push(part.field)
  }
  const index = [...indexes].find(([, fields]) => JSON.stringify(fields) === JSON.stringify(stream.keys))?.[0]
  if (!index) return invalid()
  return { query: k.from(k.raw('?? AS ?? FORCE INDEX (??)', [stream.table, 's', index])).forShare() }
}
function decodeTextRows(rows: Array<Record<string, unknown>>, stream: Stream, local: boolean): void {
  if (!stream.text) return
  for (const row of rows) {
    const bytes = row.boundedText
    if (!(bytes instanceof Uint8Array)) return invalid()
    const text = Buffer.from(bytes).toString('utf8')
    row[stream.text] =
      (!local || row.boundedTextType === 'text') && Buffer.from(text, 'utf8').equals(Buffer.from(bytes))
        ? text
        : undefined
    delete row.boundedTextType
    delete row.boundedText
  }
}
function projectPage(k: Knex, query: Knex.QueryBuilder, stream: Stream, local: boolean): void {
  for (const key of stream.keys) {
    if (key === stream.text) {
      if (local) query.select(k.raw('typeof(??) AS ??', ['s.' + key, 'boundedTextType']))
      query.select(
        k.raw(local ? 'substr(CAST(?? AS BLOB),1,401) AS ??' : 'SUBSTRING(CAST(?? AS BINARY),1,401) AS ??', [
          's.' + key,
          'boundedText'
        ])
      )
    } else query.select('s.' + key)
  }
  if (stream.extra) query.select('s.' + stream.extra)
}
function afterCursor(query: Knex.QueryBuilder, stream: Stream, cursor: Array<number | string>, local: boolean): void {
  if (local)
    query.whereRaw('(' + stream.keys.map(() => '??').join(',') + ') > (' + stream.keys.map(() => '?').join(',') + ')', [
      ...stream.keys.map(key => 's.' + key),
      ...cursor
    ])
  else
    query.where(function () {
      stream.keys.forEach((key, index) => {
        this.orWhere(function () {
          for (let i = 0; i < index; i++) this.where('s.' + stream.keys[i], cursor[i])
          this.where('s.' + key, '>', cursor[index])
        })
      })
    })
}
async function queryPage(
  k: Knex,
  stream: Stream,
  cursor: Array<number | string> | undefined,
  local: boolean
): Promise<Array<Record<string, unknown>>> {
  const query = local ? k.from({ s: stream.table }) : (await mysqlSourceQuery(k, stream)).query
  projectPage(k, query, stream, local)
  query.orderBy(stream.keys.map(key => 's.' + key)).limit(256)
  if (cursor) afterCursor(query, stream, cursor, local)
  const sql = query.toSQL()
  const plan = await k.raw((local ? 'EXPLAIN QUERY PLAN ' : 'EXPLAIN ') + sql.sql, sql.bindings as Knex.RawBinding[])
  if (
    (local ? plan : plan[0]).some((step: { detail?: string; Extra?: string }) =>
      local ? step.detail?.includes('TEMP B-TREE') : step.Extra?.includes('filesort')
    )
  )
    return invalid()
  const rows: Array<Record<string, unknown>> = await query
  if (rows.length > 256) return invalid()
  decodeTextRows(rows, stream, local)
  return rows
}

function bootstrapCursor(stream: Stream, value: string | null): Array<number | string> | undefined {
  if (value === null) return undefined
  if (Buffer.byteLength(value) > 2048) return invalid()
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return invalid()
  }
  if (!Array.isArray(parsed) || parsed.length !== stream.keys.length) return invalid()
  for (const [i, value] of parsed.entries())
    if (
      stream.keys[i] === stream.text
        ? typeof value !== 'string' || Buffer.byteLength(value) > 400
        : typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0
    )
      return invalid()
  return parsed as Array<number | string>
}
interface BootstrapState {
  stream: number
  cursor: string | null
  rowLimit: number | null
  rowsUsed: number
}
async function readBootstrapState(t: Knex, streamCount: number, rowLimit: number): Promise<BootstrapState> {
  const state: BootstrapState | undefined = await t('snapshot_journal_bootstrap').where('id', 1).first()
  if (
    !state ||
    !Number.isInteger(state.stream) ||
    state.stream < 0 ||
    state.stream > streamCount ||
    !(state.cursor === null || typeof state.cursor === 'string') ||
    !validSnapshotJournalBootstrapBudget(state) ||
    (state.rowLimit !== null && state.rowLimit !== rowLimit) ||
    (state.rowLimit === null && (state.stream !== 0 || state.cursor !== null))
  )
    return invalid()
  return state
}
async function writeBootstrapRecords(
  t: Knex,
  stream: Stream,
  records: Array<Record<string, unknown>>,
  local: boolean
): Promise<boolean> {
  if (!records.length) return true
  const at = await revision(t, local)
  if (at === undefined) return false
  const table = stream.physical ? 'snapshot_journal_physical' : 'snapshot_journal_scope'
  const primary = stream.physical
    ? ['tableId', 'id1', 'id2', 'exactText']
    : ['tableId', 'userId', 'id1', 'id2', 'exactText']
  // At most four writes per page, each below the 999-binding SQLite floor.
  const batches = Array.from({ length: Math.ceil(records.length / 64) }, (_, i) => records.slice(i * 64, (i + 1) * 64))
  await runInSeries(batches, async batch => {
    const query = t(table)
      .insert(
        batch.map(record => ({
          ...record,
          exactText: local ? record.exactText : Buffer.from(record.exactText as string),
          revision: snapshotJournalRevisionOperand(t, at),
          ...(stream.physical ? { generation: snapshotJournalRevisionOperand(t, at) } : {})
        }))
      )
      .onConflict(primary)
    if (local) await query.ignore()
    else await query.merge({ id1: t.ref(table + '.id1') })
  })
  return true
}
export interface SnapshotJournalBootstrapPage {
  complete: boolean
  selected: number
  stream: number
  invalidated: boolean
}
/** Fresh/resumed owned state only. Caller validates migration ownership before
 * every resume and supplies an explicit row allowance. The first page persists
 * that allowance; changing it requires a new generation. This bounds bootstrap
 * allocation, separately from event-window and physical/receipt retention limits.
 * Owns its transaction: a caller transaction could retain the writer barrier
 * beyond this page or reuse an older MySQL progress/capacity read view.
 */
export async function copySnapshotJournalBootstrapPage(
  k: Knex,
  rowLimit: number
): Promise<SnapshotJournalBootstrapPage> {
  if (k.isTransaction || !validSnapshotJournalBootstrapBudget({ rowLimit, rowsUsed: 0 }) || rowLimit === null)
    return invalid()
  const local = sqlite(k),
    all = streams(local)
  return await k.transaction(async t => {
    if (local)
      await t('snapshot_journal_bootstrap')
        .where('id', 1)
        .update({ stream: t.ref('stream') })
    else if (!(await t('snapshot_journal_clock').where('id', 1).forUpdate().noWait().first('id'))) return invalid()
    const state = await readBootstrapState(t, all.length, rowLimit)
    const enabled = local
      ? (await t('snapshot_journal_clock').where('id', 1).first('enabled'))?.enabled === 1
      : !(await t('snapshot_journal_invalid').where('id', 1).first('id'))
    if (!enabled) return { complete: false, selected: 0, stream: state.stream, invalidated: true }
    if (state.rowLimit === null) {
      await t('snapshot_journal_bootstrap').where('id', 1).update({ rowLimit })
    }
    if (state.stream === all.length) {
      if (state.cursor !== null) return invalid()
      return { complete: true, selected: 0, stream: state.stream, invalidated: false }
    }
    const stream = all[state.stream]
    const cursor = bootstrapCursor(stream, state.cursor)
    const rows = await queryPage(t, stream, cursor, local),
      records = rows.map(row => stream.record(row))
    if (records.some(record => !validKey(record))) {
      await invalidate(t, 'key-out-of-range')
      return { complete: false, selected: rows.length, stream: state.stream, invalidated: true }
    }
    if (records.length > rowLimit - state.rowsUsed) {
      await invalidate(t, 'capacity-exhausted')
      return { complete: false, selected: rows.length, stream: state.stream, invalidated: true }
    }
    if (!(await writeBootstrapRecords(t, stream, records, local)))
      return { complete: false, selected: rows.length, stream: state.stream, invalidated: true }
    const last = rows.at(-1)
    await t('snapshot_journal_bootstrap')
      .where('id', 1)
      .update(
        last
          ? { cursor: JSON.stringify(stream.keys.map(key => last[key])), rowsUsed: state.rowsUsed + rows.length }
          : { stream: state.stream + 1, cursor: null }
      )
    return {
      complete: !last && state.stream + 1 === all.length,
      selected: rows.length,
      stream: state.stream,
      invalidated: false
    }
  })
}
