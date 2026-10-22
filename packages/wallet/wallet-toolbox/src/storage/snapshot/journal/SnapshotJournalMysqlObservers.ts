import type { Knex } from 'knex'
import { runInSeries } from '../../../utility/runInSeries'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { numeric } from '../../schema/snapshotSqliteMembership'
import {
  SNAPSHOT_JOURNAL_MYSQL_CLOCK_VARIABLES as variables,
  SNAPSHOT_JOURNAL_MYSQL_ADVANCE as advance
} from './SnapshotJournalMysqlClock'

const tables = [...numeric.map(source => source.table), 'tx_labels_map', 'output_tags_map', 'certificate_fields']
const q = (name: string) => '`' + name.replaceAll('`', '``') + '`'
const physicalKey = 'tableId,id1,id2,exactText',
  scopeKey = 'tableId,userId,id1,id2,exactText'
export const SNAPSHOT_JOURNAL_MYSQL_METADATA_DDL = [
  `CREATE TABLE snapshot_journal_physical(tableId INT NOT NULL,id1 BIGINT UNSIGNED NOT NULL,id2 BIGINT UNSIGNED NOT NULL,exactText VARBINARY(400) NOT NULL,revision BIGINT UNSIGNED NOT NULL,generation BIGINT UNSIGNED NOT NULL,present BOOLEAN NOT NULL,PRIMARY KEY(${physicalKey}),KEY snapshot_journal_physical_page(tableId,revision,id1,id2,exactText)) ENGINE=InnoDB`,
  `CREATE TABLE snapshot_journal_scope(tableId INT NOT NULL,userId BIGINT UNSIGNED NOT NULL,id1 BIGINT UNSIGNED NOT NULL,id2 BIGINT UNSIGNED NOT NULL,exactText VARBINARY(400) NOT NULL,revision BIGINT UNSIGNED NOT NULL,present BOOLEAN NOT NULL,PRIMARY KEY(${scopeKey}),KEY snapshot_journal_scope_page(userId,tableId,revision,id1,id2,exactText)) ENGINE=InnoDB`
]
const tuple = (table: string, p: string): string[] => {
  const key = numeric.find(source => source.table === table)?.key
  if (key) return [p + '.' + q(key), '0', "CAST('' AS BINARY)"]
  if (table === 'tx_labels_map') return [p + '.txLabelId', p + '.transactionId', "CAST('' AS BINARY)"]
  if (table === 'output_tags_map') return [p + '.outputTagId', p + '.outputId', "CAST('' AS BINARY)"]
  return [p + '.certificateId', '0', 'CAST(' + p + '.fieldName AS BINARY)']
}
const scopeUpsert = (selection: string) =>
  `INSERT INTO snapshot_journal_scope(${scopeKey},revision,present) ${selection} ON DUPLICATE KEY UPDATE revision=VALUES(revision),present=VALUES(present); `
function keyGuard(key: string[], owner?: string): string {
  const [id1, id2, text] = key
  const valid = [
    `(${id1} BETWEEN 1 AND 9007199254740991)`,
    `(${id2} BETWEEN 0 AND 9007199254740991)`,
    `(OCTET_LENGTH(${text})<=400)`,
    ...(owner ? [`(${owner} BETWEEN 1 AND 9007199254740991)`] : [])
  ].join(' AND ')
  return `IF NOT COALESCE((${valid}),FALSE) THEN INSERT IGNORE INTO snapshot_journal_invalid(id,reason) VALUES(1,'key-out-of-range'); SET journalEnabled=FALSE; END IF; `
}

function sourceScope(tableId: number, keys: string[]): string {
  if (tableId < 8)
    return scopeUpsert(
      `SELECT ${tableId},NEW.userId,NEW.${q(numeric[tableId].key)},0,CAST('' AS BINARY),journalRevision,1`
    )
  else if (tableId === 10 || tableId === 11)
    return scopeUpsert(
      `SELECT ${tableId},snapshotUserId,snapshotLeftId,snapshotRightId,CAST('' AS BINARY),journalRevision,1 FROM snapshot_relation_keys WHERE snapshotTableId=${tableId - 10} AND snapshotLeftId=${keys[0]} AND snapshotRightId=${keys[1]} AND snapshotMembership<>0 FOR SHARE`
    )
  else if (tableId === 12)
    return scopeUpsert(
      `SELECT 12,snapshotUserId,snapshotCertificateId,0,CAST(snapshotFieldName AS BINARY),journalRevision,1 FROM snapshot_certificate_field_keys WHERE snapshotCertificateId=NEW.certificateId AND snapshotFieldName=NEW.fieldName AND snapshotMembership<>0 FOR SHARE`
    )
  return ''
}
function freshGeneration(event: string, same: string): string {
  if (event === 'INSERT') return 'TRUE'
  if (event === 'UPDATE') return `NOT (${same})`
  return 'FALSE'
}
function physicalTrigger(tableId: number, table: string, event: string, changed: string): string {
  const same = tuple(table, 'OLD')
    .map((x, i) => `(${x} <=> ${tuple(table, 'NEW')[i]})`)
    .join(' AND ')
  const write = (p: string, present: number, fresh: string) =>
    `INSERT INTO snapshot_journal_physical(${physicalKey},revision,generation,present) VALUES(${tableId},${tuple(table, p).join(',')},journalRevision,journalRevision,${present}) ON DUPLICATE KEY UPDATE revision=VALUES(revision),generation=CASE WHEN ${fresh} THEN VALUES(generation) ELSE generation END,present=VALUES(present); `
  const p = event === 'DELETE' ? 'OLD' : 'NEW',
    keys = tuple(table, p)
  let body = advance + keyGuard(keys, tableId < 8 ? p + '.userId' : undefined)
  if (event === 'UPDATE') body += keyGuard(tuple(table, 'OLD'), tableId < 8 ? 'OLD.userId' : undefined)
  body += 'IF journalEnabled THEN '
  if (event === 'UPDATE') body += `IF NOT (${same}) THEN ${write('OLD', 0, 'FALSE')} END IF; `
  body += write(p, event === 'DELETE' ? 0 : 1, freshGeneration(event, same))
  if (event !== 'DELETE') body += sourceScope(tableId, keys)
  body += 'END IF; '
  return `CREATE TRIGGER snapshot_journal_physical_${tableId}_${event} AFTER ${event} ON ${q(table)} FOR EACH ROW BEGIN ${variables}IF ${event === 'UPDATE' ? changed : 'TRUE'} THEN ${body} END IF; END`
}

/** Caller validates the completed MySQL membership/source schema before installing these observers. */
export async function snapshotJournalMysqlObserverSql(k: Knex): Promise<string[]> {
  if (!['mysql', 'mysql2'].includes(k.client.config.client))
    throw new WERR_INVALID_OPERATION('Snapshot journal observers require MySQL')
  const definitions: string[] = []
  const membership: Array<{
    table: string
    expressions: (p: string) => string[]
    present: (p: string) => string
  }> = [
    {
      table: 'snapshot_profile_keys',
      expressions: p => [
        p + '.snapshotTableId',
        p + '.snapshotUserId',
        p + '.snapshotRowId',
        '0',
        "CAST('' AS BINARY)"
      ],
      present: () => '1'
    },
    {
      table: 'snapshot_relation_keys',
      expressions: p => [
        p + '.snapshotTableId+10',
        p + '.snapshotUserId',
        p + '.snapshotLeftId',
        p + '.snapshotRightId',
        "CAST('' AS BINARY)"
      ],
      present: p => '(' + p + '.snapshotMembership<>0)'
    },
    {
      table: 'snapshot_certificate_field_keys',
      expressions: p => [
        '12',
        p + '.snapshotUserId',
        p + '.snapshotCertificateId',
        '0',
        'CAST(' + p + '.snapshotFieldName AS BINARY)'
      ],
      present: p => '(' + p + '.snapshotMembership<>0)'
    },
    {
      table: 'snapshot_global_keys',
      expressions: p => [
        'CASE ' + p + '.tableId WHEN 0 THEN 9 ELSE 8 END',
        p + '.userId',
        p + '.rowId',
        '0',
        "CAST('' AS BINARY)"
      ],
      present: p => p + '.present'
    }
  ]
  for (const [i, source] of membership.entries())
    for (const event of ['INSERT', 'DELETE', 'UPDATE']) {
      const p = event === 'DELETE' ? 'OLD' : 'NEW',
        fields = source.expressions(p)
      const condition =
        event === 'UPDATE'
          ? [
              ...source.expressions('OLD').map((x, j) => `NOT (${x} <=> ${source.expressions('NEW')[j]})`),
              `NOT (${source.present('OLD')} <=> ${source.present('NEW')})`
            ].join(' OR ')
          : 'TRUE'
      definitions.push(
        `CREATE TRIGGER snapshot_journal_scope_${i}_${event} AFTER ${event} ON ${q(source.table)} FOR EACH ROW BEGIN ${variables}IF ${condition} THEN ${advance}${keyGuard(fields.slice(2), fields[1])}IF journalEnabled THEN ${scopeUpsert('SELECT ' + [...fields, 'journalRevision', event === 'DELETE' ? '0' : source.present(p)].join(','))} END IF; END IF; END`
      )
    }
  await runInSeries(tables.entries(), async ([tableId, table]) => {
    const [columns]: Array<Array<{ name: string }>> = await k.raw(
      'SELECT COLUMN_NAME name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION',
      [table]
    )
    if (columns.length === 0) throw new WERR_INVALID_OPERATION('Missing snapshot journal source')
    const changed = columns
      .map(({ name }) => `NOT (CAST(OLD.${q(name)} AS BINARY) <=> CAST(NEW.${q(name)} AS BINARY))`)
      .join(' OR ')
    for (const event of ['INSERT', 'UPDATE', 'DELETE'])
      definitions.push(physicalTrigger(tableId, table, event, changed))
  })
  return definitions
}
