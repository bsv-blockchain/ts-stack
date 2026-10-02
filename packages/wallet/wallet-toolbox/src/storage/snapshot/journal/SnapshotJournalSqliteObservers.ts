import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { runInSeries } from '../../../utility/runInSeries'
import { numeric } from '../../schema/snapshotSqliteMembership'
import { names } from '../../schema/snapshotSqliteIndexGeneration'
import {
  SNAPSHOT_JOURNAL_SQLITE_ADVANCE as tick,
  SNAPSHOT_JOURNAL_SQLITE_REVISION as revision,
  SNAPSHOT_JOURNAL_SQLITE_WRITABLE as writable
} from './SnapshotJournalSqliteClock'

const q = (name: string) => '"' + name.replaceAll('"', '""') + '"'
export const snapshotJournalSqliteSources = [
  ...numeric.map(source => source.table),
  'tx_labels_map',
  'output_tags_map',
  'certificate_fields'
]
const scopeKey = 'tableId,userId,id1,id2,exactText'
const physicalKey = 'tableId,id1,id2,exactText'
export const SNAPSHOT_JOURNAL_SQLITE_METADATA_DDL = [
  `CREATE TABLE snapshot_journal_physical(tableId INTEGER NOT NULL,id1 INTEGER NOT NULL,id2 INTEGER NOT NULL,exactText TEXT COLLATE BINARY NOT NULL,revision INTEGER NOT NULL,generation INTEGER NOT NULL,present INTEGER NOT NULL,PRIMARY KEY(${physicalKey}))`,
  `CREATE TABLE snapshot_journal_scope(tableId INTEGER NOT NULL,userId INTEGER NOT NULL,id1 INTEGER NOT NULL,id2 INTEGER NOT NULL,exactText TEXT COLLATE BINARY NOT NULL,revision INTEGER NOT NULL,present INTEGER NOT NULL,PRIMARY KEY(${scopeKey}))`,
  'CREATE INDEX snapshot_journal_scope_page ON snapshot_journal_scope(userId,tableId,revision,id1,id2,exactText)',
  'CREATE INDEX snapshot_journal_physical_page ON snapshot_journal_physical(tableId,revision,id1,id2,exactText)'
]
const tuple = (table: string, prefix: string) => {
  const key = numeric.find(source => source.table === table)?.key
  if (key) return [prefix + '.' + q(key), '0', "''"]
  if (table === 'tx_labels_map') return [prefix + '.txLabelId', prefix + '.transactionId', "''"]
  if (table === 'output_tags_map') return [prefix + '.outputTagId', prefix + '.outputId', "''"]
  return [prefix + '.certificateId', '0', prefix + '.fieldName']
}
const scopeUpsert = (select: string) =>
  `INSERT INTO snapshot_journal_scope(${scopeKey},revision,present) ${select} ON CONFLICT(${scopeKey}) DO UPDATE SET revision=excluded.revision,present=excluded.present; `
const exactWhere = (table: string, prefix: string, alias: string) => {
  const left = tuple(table, prefix),
    right = tuple(table, alias)
  return left.map((key, i) => `CAST(${key} AS BLOB) IS CAST(${right[i]} AS BLOB)`).join(' AND ')
}
function keyGuard(key: string[], owner?: string): string {
  const [id1, id2, text] = key
  const integer = (value: string, minimum: number) =>
    `(typeof(${value})='integer' AND ${value} BETWEEN ${minimum} AND 9007199254740991)`
  const valid = [
    integer(id1, 1),
    integer(id2, 0),
    `(typeof(${text})='text' AND length(CAST(${text} AS BLOB))<=400)`,
    ...(owner ? [integer(owner, 1)] : [])
  ].join(' AND ')
  return `UPDATE snapshot_journal_clock SET enabled=0,reason='key-out-of-range' WHERE id=1 AND enabled=1 AND NOT (${valid}); `
}

/** Prepare observers only after the caller validates the completed v2 source generation. */
export async function snapshotJournalSqliteObserverSql(k: Knex): Promise<string[]> {
  if (!['sqlite3', 'better-sqlite3'].includes(k.client.config.client))
    throw new WERR_INVALID_OPERATION('Snapshot journal observers require SQLite')
  const definitions: string[] = []
  const membership: Array<{
    table: string
    expressions: (p: string) => string[]
    present: (p: string) => string
  }> = [
    {
      table: names.profile,
      expressions: p => [p + '.snapshotTableId', p + '.snapshotUserId', p + '.snapshotRowId', '0', "''"],
      present: () => '1'
    },
    {
      table: names.relation,
      expressions: p => [
        p + '.snapshotTableId+10',
        p + '.snapshotUserId',
        p + '.snapshotLeftId',
        p + '.snapshotRightId',
        "''"
      ],
      present: () => '1'
    },
    {
      table: names.certificate,
      expressions: p => ['12', p + '.snapshotUserId', p + '.snapshotCertificateId', '0', p + '.snapshotFieldName'],
      present: () => '1'
    },
    {
      table: names.keys,
      expressions: p => ['CASE ' + p + '.tableId WHEN 0 THEN 9 ELSE 8 END', p + '.userId', p + '.rowId', '0', "''"],
      present: p => p + '.present'
    }
  ]
  for (const [i, source] of membership.entries())
    for (const event of ['INSERT', 'DELETE', 'UPDATE']) {
      const p = event === 'DELETE' ? 'OLD' : 'NEW',
        fields = source.expressions(p)
      const selected = [...fields, revision, event === 'DELETE' ? '0' : source.present(p)].join(',')
      definitions.push(
        `CREATE TRIGGER snapshot_journal_scope_${i}_${event} AFTER ${event} ON ${q(source.table)} BEGIN ${keyGuard(fields.slice(2), fields[1])}${tick}${scopeUpsert('SELECT ' + selected + ' WHERE ' + writable)} END`
      )
    }
  await runInSeries(snapshotJournalSqliteSources.entries(), async ([tableId, table]) => {
    const columns: Array<{ name: string }> = await k.raw('PRAGMA table_info(??)', [table])
    if (columns.length === 0) throw new WERR_INVALID_OPERATION('Missing snapshot journal source')
    const changed = columns
      .map(({ name }) => `CAST(OLD.${q(name)} AS BLOB) IS NOT CAST(NEW.${q(name)} AS BLOB)`)
      .join(' OR ')
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
      const prefix = event === 'DELETE' ? 'OLD' : 'NEW',
        current = tuple(table, prefix)
      const regenerate =
        event === 'INSERT' ? '1' : event === 'UPDATE' ? `NOT (${exactWhere(table, 'OLD', 'NEW')})` : '0'
      const writePhysical = (p: string, fresh: string) =>
        `INSERT INTO snapshot_journal_physical(${physicalKey},revision,generation,present) SELECT ${tableId},${tuple(table, p).join(',')},${revision},${revision},EXISTS(SELECT 1 FROM ${q(table)} s WHERE ${exactWhere(table, p, 's')}) WHERE ${writable} ON CONFLICT(${physicalKey}) DO UPDATE SET revision=excluded.revision,generation=CASE WHEN ${fresh} THEN excluded.generation ELSE snapshot_journal_physical.generation END,present=excluded.present; `
      let body = keyGuard(current, tableId < 8 ? prefix + '.userId' : undefined)
      if (event === 'UPDATE') body += keyGuard(tuple(table, 'OLD'), tableId < 8 ? 'OLD.userId' : undefined)
      body += tick
      if (event === 'UPDATE') body += writePhysical('OLD', '0')
      body += writePhysical(prefix, regenerate)
      if (tableId < 8) {
        body += scopeUpsert(
          `SELECT ${tableId},s.userId,s.${q(numeric[tableId].key)},0,'',${revision},1 FROM ${q(table)} s WHERE ${exactWhere(table, prefix, 's')} AND ${writable}`
        )
      } else if (tableId === 10 || tableId === 11) {
        body += scopeUpsert(
          `SELECT ${tableId},snapshotUserId,snapshotLeftId,snapshotRightId,'',${revision},1 FROM ${names.relation} WHERE snapshotTableId=${tableId - 10} AND snapshotLeftId=${current[0]} AND snapshotRightId=${current[1]} AND ${writable}`
        )
      } else if (tableId === 12) {
        body += scopeUpsert(
          `SELECT 12,snapshotUserId,snapshotCertificateId,0,snapshotFieldName,${revision},1 FROM ${names.certificate} WHERE snapshotCertificateId=${current[0]} AND snapshotFieldName=${current[2]} AND ${writable}`
        )
      }
      definitions.push(
        `CREATE TRIGGER snapshot_journal_physical_${tableId}_${event} AFTER ${event} ON ${q(table)} ${event === 'UPDATE' ? 'WHEN ' + changed : ''} BEGIN ${body} END`
      )
    }
  })
  return definitions
}
