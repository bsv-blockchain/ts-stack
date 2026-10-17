import { snapshotSqliteCellsChanged } from '../../schema/snapshotSqliteCellComparison'
import { hasBrc38NativePackedSchema, nativePackedTables } from '../../portable/Brc38NativePackedSchemaNode'
import { hasBrc38NativePackedTextSchema, nativePackedTextTables } from '../../portable/Brc38NativePackedTextSchemaNode'
import { isOwnedNativeSqlite } from '../../schema/ownedNativeSqliteRuntimeNode'
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
const scopeColumns = scopeKey + ',revision,present'
const physicalColumns = physicalKey + ',revision,generation,present'
const eventView = (name: string, columns: string) =>
  `CREATE VIEW ${name} (${columns}) AS SELECT ${columns
    .split(',')
    .map(() => 'NULL')
    .join(',')} WHERE 0`
const eventValues = (columns: string) =>
  columns
    .split(',')
    .map(column => 'NEW.' + column)
    .join(',')
/** Derived SQL data only. These rowless helpers retain the original statement
 * positions and values; actual source/producer/generation checks admit a plan. */
export const SNAPSHOT_JOURNAL_SQLITE_SHARED_EFFECT_DDL = Object.freeze([
  eventView('snapshot_journal_guard_event', 'valid'),
  "CREATE TRIGGER snapshot_journal_guard_apply INSTEAD OF INSERT ON snapshot_journal_guard_event BEGIN UPDATE snapshot_journal_clock SET enabled=0,reason='key-out-of-range' WHERE id=1 AND enabled=1 AND NOT (NEW.valid); END",
  eventView('snapshot_journal_scope_event', scopeColumns),
  `CREATE TRIGGER snapshot_journal_scope_apply INSTEAD OF INSERT ON snapshot_journal_scope_event BEGIN INSERT INTO snapshot_journal_scope(${scopeColumns}) VALUES(${eventValues(scopeColumns)}) ON CONFLICT(${scopeKey}) DO UPDATE SET revision=excluded.revision,present=excluded.present; END`,
  eventView('snapshot_journal_physical_event', physicalColumns + ',fresh'),
  `CREATE TRIGGER snapshot_journal_physical_apply INSTEAD OF INSERT ON snapshot_journal_physical_event BEGIN INSERT INTO snapshot_journal_physical(${physicalColumns}) VALUES(${eventValues(physicalColumns)}) ON CONFLICT(${physicalKey}) DO UPDATE SET revision=excluded.revision,generation=CASE WHEN NEW.fresh THEN excluded.generation ELSE snapshot_journal_physical.generation END,present=excluded.present; END`
])
export const SNAPSHOT_JOURNAL_SQLITE_METADATA_DDL = [
  `CREATE TABLE snapshot_journal_physical(tableId INTEGER NOT NULL,id1 INTEGER NOT NULL,id2 INTEGER NOT NULL,exactText TEXT COLLATE BINARY NOT NULL,revision INTEGER NOT NULL,generation INTEGER NOT NULL,present INTEGER NOT NULL,PRIMARY KEY(${physicalKey}))`,
  `CREATE TABLE snapshot_journal_scope(tableId INTEGER NOT NULL,userId INTEGER NOT NULL,id1 INTEGER NOT NULL,id2 INTEGER NOT NULL,exactText TEXT COLLATE BINARY NOT NULL,revision INTEGER NOT NULL,present INTEGER NOT NULL,PRIMARY KEY(${scopeKey}))`,
  'CREATE INDEX snapshot_journal_scope_page ON snapshot_journal_scope(userId,tableId,revision,id1,id2,exactText)',
  'CREATE INDEX snapshot_journal_physical_page ON snapshot_journal_physical(tableId,revision,id1,id2,exactText)'
]
/** Authored derived metadata only. Operational and raw-private source tables
 * keep their physical rowids; these two journals are addressed by exact keys. */
export const SNAPSHOT_JOURNAL_SQLITE_COMPACT_METADATA_DDL = SNAPSHOT_JOURNAL_SQLITE_METADATA_DDL.map(sql =>
  sql.startsWith('CREATE TABLE ') ? sql + ' WITHOUT ROWID' : sql
)
export const SNAPSHOT_JOURNAL_SQLITE_SHARED_ADVANCE_DDL = [
  'CREATE VIEW snapshot_journal_advance_event (event) AS SELECT NULL WHERE 0',
  `CREATE TRIGGER snapshot_journal_advance_apply INSTEAD OF INSERT ON snapshot_journal_advance_event BEGIN SELECT CASE WHEN NEW.event IS NOT 1 THEN RAISE(ABORT,'Invalid snapshot journal advance event') END; ${tick}END`
]
/** SQL data construction only: one exact clock update at the original point in
 * every observer. No caller-supplied layout or flag grants installation. */
export function snapshotJournalSharedClockObserverSql(
  definitions: readonly string[],
  delegatedEvents = false,
  projectedSources = false
): string[] {
  return [
    ...SNAPSHOT_JOURNAL_SQLITE_SHARED_ADVANCE_DDL,
    ...(delegatedEvents
      ? projectedSources
        ? SNAPSHOT_JOURNAL_SQLITE_SHARED_SOURCE_EVENT_DDL
        : SNAPSHOT_JOURNAL_SQLITE_SHARED_EVENT_DDL
      : []),
    ...definitions.map(sql => {
      if (
        delegatedEvents &&
        /^CREATE TRIGGER snapshot_journal_(?:(scope|physical)_\d+_(INSERT|UPDATE|DELETE)|packed_(?:text_)?\d+_(INSERT|DELETE)) .* BEGIN INSERT INTO snapshot_journal_(member|source|pointer)_event\([^;]+; END$/s.test(
          sql
        )
      )
        return sql
      if (!sql.startsWith('CREATE TRIGGER snapshot_journal_') || sql.split(tick).length !== 2)
        throw new WERR_INVALID_OPERATION('Unexpected source journal clock emitter')
      return sql.replace(tick, 'INSERT INTO snapshot_journal_advance_event(event) VALUES(1); ')
    })
  ]
}
const tuple = (table: string, prefix: string) => {
  const key = numeric.find(source => source.table === table)?.key
  if (key) return [prefix + '.' + q(key), '0', "''"]
  if (table === 'tx_labels_map') return [prefix + '.txLabelId', prefix + '.transactionId', "''"]
  if (table === 'output_tags_map') return [prefix + '.outputTagId', prefix + '.outputId', "''"]
  return [prefix + '.certificateId', '0', prefix + '.fieldName']
}
const scopeUpsert = (select: string, shared = false) =>
  shared
    ? `INSERT INTO snapshot_journal_scope_event(${scopeColumns}) ${select}; `
    : `INSERT INTO snapshot_journal_scope(${scopeKey},revision,present) ${select} ON CONFLICT(${scopeKey}) DO UPDATE SET revision=excluded.revision,present=excluded.present; `
const exactWhere = (table: string, prefix: string, alias: string, shared = false) => {
  const left = tuple(table, prefix),
    right = tuple(table, alias)
  return left
    .flatMap((key, i) =>
      shared && key === right[i] && (key === '0' || key === "''")
        ? []
        : [`CAST(${key} AS BLOB) IS CAST(${right[i]} AS BLOB)`]
    )
    .join(' AND ')
}
/** Native equality admits the declared point index; the byte residual keeps
 * generation identity exact even for NOCASE/RTRIM certificate-field keys. */
const sourceWhere = (table: string, prefix: string, alias: string, shared = false) => {
  const left = tuple(table, prefix),
    right = tuple(table, alias)
  const indexed = right.flatMap((key, i) => (key.startsWith(alias + '.') ? [`${key}=${left[i]}`] : []))
  return indexed.join(' AND ') + ' AND ' + exactWhere(table, prefix, alias, shared)
}
function keyGuard(key: string[], owner?: string, signed = false, shared = false): string {
  const [id1, id2, text] = key
  const integer = (value: string, minimum: number) =>
    `(typeof(${value})='integer' AND ${value} BETWEEN ${minimum} AND 9007199254740991)`
  const valid = [
    integer(id1, signed ? -9007199254740991 : 1),
    ...(shared && id2 === '0' ? [] : [integer(id2, 0)]),
    ...(shared && text === "''" ? [] : [`(typeof(${text})='text' AND length(CAST(${text} AS BLOB))<=400)`]),
    ...(owner ? [integer(owner, 1)] : [])
  ].join(' AND ')
  return shared
    ? `INSERT INTO snapshot_journal_guard_event(valid) VALUES(${valid}); `
    : `UPDATE snapshot_journal_clock SET enabled=0,reason='key-out-of-range' WHERE id=1 AND enabled=1 AND NOT (${valid}); `
}

function sourceScope(tableId: number, table: string, prefix: string, current: string[], shared = false): string {
  if (tableId < 8) {
    return scopeUpsert(
      `SELECT ${tableId},s.userId,s.${q(numeric[tableId].key)},0,'',${revision},1 FROM ${q(table)} s WHERE ${sourceWhere(table, prefix, 's', shared)} AND ${writable}`,
      shared
    )
  } else if (tableId === 10 || tableId === 11) {
    return scopeUpsert(
      `SELECT ${tableId},snapshotUserId,snapshotLeftId,snapshotRightId,'',${revision},1 FROM ${names.relation} WHERE snapshotTableId=${tableId - 10} AND snapshotLeftId=${current[0]} AND snapshotRightId=${current[1]} AND ${writable}`,
      shared
    )
  } else if (tableId === 12) {
    return scopeUpsert(
      `SELECT 12,snapshotUserId,snapshotCertificateId,0,snapshotFieldName,${revision},1 FROM ${names.certificate} WHERE snapshotCertificateId=${current[0]} AND snapshotFieldName=${current[2]} AND ${writable}`,
      shared
    )
  }
  return ''
}
function freshGeneration(event: string, table: string, shared = false): string {
  if (event === 'INSERT') return '1'
  if (event === 'UPDATE') return `NOT (${exactWhere(table, 'OLD', 'NEW', shared)})`
  return '0'
}
function physicalTrigger(tableId: number, table: string, event: string, changed: string, shared = false): string {
  const prefix = event === 'DELETE' ? 'OLD' : 'NEW',
    current = tuple(table, prefix)
  const regenerate = freshGeneration(event, table, shared)
  const writePhysical = (p: string, fresh: string) =>
    shared
      ? `INSERT INTO snapshot_journal_physical_event(${physicalColumns},fresh) SELECT ${tableId},${tuple(table, p).join(',')},${revision},${revision},EXISTS(SELECT 1 FROM ${q(table)} s WHERE ${sourceWhere(table, p, 's', shared)}),${fresh} WHERE ${writable}; `
      : `INSERT INTO snapshot_journal_physical(${physicalKey},revision,generation,present) SELECT ${tableId},${tuple(table, p).join(',')},${revision},${revision},EXISTS(SELECT 1 FROM ${q(table)} s WHERE ${sourceWhere(table, p, 's')}) WHERE ${writable} ON CONFLICT(${physicalKey}) DO UPDATE SET revision=excluded.revision,generation=CASE WHEN ${fresh} THEN excluded.generation ELSE snapshot_journal_physical.generation END,present=excluded.present; `
  let body = keyGuard(current, tableId < 8 ? prefix + '.userId' : undefined, tableId === 7, shared)
  if (event === 'UPDATE')
    body += keyGuard(tuple(table, 'OLD'), tableId < 8 ? 'OLD.userId' : undefined, tableId === 7, shared)
  body += tick
  if (event === 'UPDATE') body += writePhysical('OLD', '0')
  body += writePhysical(prefix, regenerate)
  body += sourceScope(tableId, table, prefix, current, shared)
  return `CREATE TRIGGER snapshot_journal_physical_${tableId}_${event} AFTER ${event} ON ${q(table)} ${event === 'UPDATE' ? 'WHEN ' + changed : ''} BEGIN ${body} END`
}

const memberEventColumns = 'tableId,userId,id1,id2,exactText,present'
const sourceEventColumns = 'event,tableId,id1,id2,exactText,userId,oldId1,oldId2,oldExactText,oldUserId,fresh'
function eventKey(prior = false): string[] {
  return prior ? ['NEW.oldId1', 'NEW.oldId2', 'NEW.oldExactText'] : ['NEW.id1', 'NEW.id2', 'NEW.exactText']
}
/** Each branch keeps the source's complete indexed equality plus its exact
 * byte residual. The event values carry original source cells, not a verdict. */
function eventPoint(table: string, prior = false): string {
  const source = tuple(table, 's'),
    key = eventKey(prior)
  return [
    ...source.flatMap((part, i) => (part.startsWith('s.') ? [`${part}=${key[i]}`] : [])),
    ...source.map((part, i) => `CAST(${part} AS BLOB)=CAST(${key[i]} AS BLOB)`)
  ].join(' AND ')
}
/** Non-materialized current source rows. Certificate fields retain their own
 * point query below so the source's declared field collation remains indexed.
 * These projections contain keys/owners only; no payload or cached verdict. */
const projectedSourceRows = 'snapshot_journal_source_rows'
export const SNAPSHOT_JOURNAL_SQLITE_SOURCE_ROWS_DDL =
  `CREATE VIEW ${projectedSourceRows} (tableId,id1,id2,exactText,userId) AS ` +
  snapshotJournalSqliteSources
    .slice(0, 12)
    .map(
      (table, tableId) =>
        `SELECT ${tableId},${tuple(table, 's').join(',')},${tableId < 8 ? 's.userId' : 'NULL'} FROM ${q(table)} s`
    )
    .join(' UNION ALL ')
function projectedPoint(prior = false): string {
  const key = eventKey(prior),
    columns = ['s.id1', 's.id2', 's.exactText']
  return (
    `s.tableId=NEW.tableId AND ` +
    columns
      .flatMap((column, index) => [`${column}=${key[index]}`, `CAST(${column} AS BLOB)=CAST(${key[index]} AS BLOB)`])
      .join(' AND ')
  )
}
function eventPresence(prior = false, projectedSources = false): string {
  if (projectedSources)
    return `EXISTS(SELECT 1 FROM ${projectedSourceRows} s WHERE ${projectedPoint(prior)} UNION ALL SELECT 1 FROM certificate_fields s WHERE NEW.tableId=12 AND ${eventPoint('certificate_fields', prior)})`

  return (
    'EXISTS(' +
    snapshotJournalSqliteSources
      .map(
        (table, tableId) => `SELECT 1 FROM ${q(table)} s WHERE NEW.tableId=${tableId} AND ${eventPoint(table, prior)}`
      )
      .join(' UNION ALL ') +
    ')'
  )
}
function eventOwnerGuard(prior = false): string {
  const [id1, id2, text] = eventKey(prior),
    owner = prior ? 'NEW.oldUserId' : 'NEW.userId'
  return `(typeof(${id1})='integer' AND ${id1} BETWEEN CASE WHEN NEW.tableId=7 THEN -9007199254740991 ELSE 1 END AND 9007199254740991) AND (typeof(${id2})='integer' AND ${id2} BETWEEN 0 AND 9007199254740991) AND (typeof(${text})='text' AND length(CAST(${text} AS BLOB))<=400) AND (NEW.tableId>=8 OR (typeof(${owner})='integer' AND ${owner} BETWEEN 1 AND 9007199254740991))`
}
function eventSourceScope(projectedSources = false): string {
  const projections = projectedSources
    ? [
        `SELECT s.tableId,s.userId,s.id1,0,'',${revision},1 FROM ${projectedSourceRows} s WHERE s.tableId BETWEEN 0 AND 7 AND ${projectedPoint()} AND ${writable}`
      ]
    : numeric
        .slice(0, 8)
        .map(
          (source, tableId) =>
            `SELECT ${tableId},s.userId,s.${q(source.key)},0,'',${revision},1 FROM ${q(source.table)} s WHERE NEW.tableId=${tableId} AND ${eventPoint(source.table)} AND ${writable}`
        )
  for (const tableId of [10, 11])
    projections.push(
      `SELECT ${tableId},snapshotUserId,snapshotLeftId,snapshotRightId,'',${revision},1 FROM ${names.relation} WHERE NEW.tableId=${tableId} AND snapshotTableId=${tableId - 10} AND snapshotLeftId=NEW.id1 AND snapshotRightId=NEW.id2 AND ${writable}`
    )
  projections.push(
    `SELECT 12,snapshotUserId,snapshotCertificateId,0,snapshotFieldName,${revision},1 FROM ${names.certificate} WHERE NEW.tableId=12 AND snapshotCertificateId=NEW.id1 AND snapshotFieldName=NEW.exactText AND ${writable}`
  )
  return scopeUpsert(projections.join(' UNION ALL '), true)
}
const pointerSourceIds = [0, 1, 2, 6, 7, 8, 9] as const
const pointerField = (column: string) => `(SELECT s.${q(column)} FROM certificate_fields s WHERE s.rowid=NEW.rowId)`
function pointerOwner(projectedSources = false): string {
  if (projectedSources)
    return `CASE WHEN NEW.tableId=12 THEN ${pointerField('userId')} ELSE (SELECT s.userId FROM ${projectedSourceRows} s WHERE s.tableId=NEW.tableId AND s.id1=NEW.rowId) END`
  return (
    'CASE NEW.tableId ' +
    pointerSourceIds
      .filter(id => id < 8)
      .map(id => {
        const source = numeric[id]
        return `WHEN ${id} THEN (SELECT s.userId FROM ${q(source.table)} s WHERE s.${q(source.key)}=NEW.rowId)`
      })
      .join(' ') +
    ` WHEN 12 THEN ${pointerField('userId')} END`
  )
}
function pointerValidity(projectedSources = false): string {
  const id = `CASE WHEN NEW.tableId=12 THEN ${pointerField('certificateId')} ELSE NEW.rowId END`,
    text = `CASE WHEN NEW.tableId=12 THEN ${pointerField('fieldName')} ELSE '' END`,
    owner = pointerOwner(projectedSources)
  return `(typeof(${id})='integer' AND ${id} BETWEEN CASE WHEN NEW.tableId=7 THEN -9007199254740991 ELSE 1 END AND 9007199254740991) AND (typeof(${text})='text' AND length(CAST(${text} AS BLOB))<=400) AND (NEW.tableId IN (8,9) OR (typeof(${owner})='integer' AND ${owner} BETWEEN 1 AND 9007199254740991))`
}
function pointerPhysical(projectedSources = false): string {
  const rows = projectedSources
    ? [
        `SELECT s.tableId,NEW.rowId,0,'',${revision},${revision},1,0 FROM ${projectedSourceRows} s WHERE s.tableId=NEW.tableId AND s.id1=NEW.rowId AND ${writable}`
      ]
    : pointerSourceIds.map(id => {
        const source = numeric[id]
        return `SELECT ${id},NEW.rowId,0,'',${revision},${revision},1,0 FROM ${q(source.table)} s WHERE NEW.tableId=${id} AND s.${q(source.key)}=NEW.rowId AND ${writable}`
      })
  rows.push(
    `SELECT 12,s.certificateId,0,s.fieldName,${revision},${revision},1,0 FROM certificate_fields s WHERE NEW.tableId=12 AND s.rowid=NEW.rowId AND ${writable}`
  )
  return `INSERT INTO snapshot_journal_physical_event(${physicalColumns},fresh) ${rows.join(' UNION ALL ')}; `
}
function pointerScope(projectedSources = false): string {
  const rows = projectedSources
    ? [
        `SELECT s.tableId,s.userId,NEW.rowId,0,'',${revision},1 FROM ${projectedSourceRows} s WHERE s.tableId IN (0,1,2,6,7) AND s.tableId=NEW.tableId AND s.id1=NEW.rowId AND ${writable}`
      ]
    : pointerSourceIds
        .filter(id => id < 8)
        .map(id => {
          const source = numeric[id]
          return `SELECT ${id},s.userId,NEW.rowId,0,'',${revision},1 FROM ${q(source.table)} s WHERE NEW.tableId=${id} AND s.${q(source.key)}=NEW.rowId AND ${writable}`
        })
  rows.push(
    `SELECT 12,m.snapshotUserId,s.certificateId,0,s.fieldName,${revision},1 FROM certificate_fields s JOIN ${names.certificate} m ON m.snapshotCertificateId=s.certificateId AND CAST(m.snapshotFieldName AS BLOB)=CAST(s.fieldName AS BLOB) WHERE NEW.tableId=12 AND s.rowid=NEW.rowId AND ${writable}`
  )
  return scopeUpsert(rows.join(' UNION ALL '), true)
}
/** Complete event statements are shared only by the fresh authored family.
 * OLD physical state is written before NEW; source scope follows both, exactly
 * as in the individual observers. No helper stores rows or adds B-tree roots. */
function sharedEventDdl(projectedSources = false): string[] {
  return [
    eventView('snapshot_journal_member_event', memberEventColumns),
    `CREATE TRIGGER snapshot_journal_member_apply INSTEAD OF INSERT ON snapshot_journal_member_event BEGIN ${keyGuard(eventKey(), 'NEW.userId', false, true)}${tick}${scopeUpsert(`SELECT ${eventValues(memberEventColumns.split(',').slice(0, 5).join(','))},${revision},NEW.present WHERE ${writable}`, true)} END`,
    eventView('snapshot_journal_source_event', sourceEventColumns),
    `CREATE TRIGGER snapshot_journal_source_apply INSTEAD OF INSERT ON snapshot_journal_source_event BEGIN SELECT CASE WHEN typeof(NEW.event)!='integer' OR NEW.event NOT IN (1,2,3) OR typeof(NEW.tableId)!='integer' OR NEW.tableId NOT BETWEEN 0 AND 12 THEN RAISE(ABORT,'Invalid snapshot journal source event') END; INSERT INTO snapshot_journal_guard_event(valid) VALUES(${eventOwnerGuard()}); INSERT INTO snapshot_journal_guard_event(valid) SELECT ${eventOwnerGuard(true)} WHERE NEW.event=2; ${tick}INSERT INTO snapshot_journal_physical_event(${physicalColumns},fresh) SELECT NEW.tableId,${eventKey(true).join(',')},${revision},${revision},${eventPresence(true, projectedSources)},0 WHERE NEW.event=2 AND ${writable}; INSERT INTO snapshot_journal_physical_event(${physicalColumns},fresh) SELECT NEW.tableId,${eventKey().join(',')},${revision},${revision},${eventPresence(false, projectedSources)},NEW.fresh WHERE ${writable}; ${eventSourceScope(projectedSources)} END`,
    eventView('snapshot_journal_pointer_event', 'tableId,rowId'),
    `CREATE TRIGGER snapshot_journal_pointer_apply INSTEAD OF INSERT ON snapshot_journal_pointer_event BEGIN SELECT CASE WHEN typeof(NEW.tableId)!='integer' OR NEW.tableId NOT IN (0,1,2,6,7,8,9,12) THEN RAISE(ABORT,'Invalid snapshot journal pointer event') END; INSERT INTO snapshot_journal_guard_event(valid) VALUES(${pointerValidity(projectedSources)}); ${tick}${pointerPhysical(projectedSources)}${pointerScope(projectedSources)} END`
  ].map(sql => sql.replace(tick, 'INSERT INTO snapshot_journal_advance_event(event) VALUES(1); '))
}
/** Exact historical event family remains available for occupied generations. */
export const SNAPSHOT_JOURNAL_SQLITE_SHARED_EVENT_DDL = Object.freeze(sharedEventDdl())
/** Fresh complete family also owns the read-only source projection definition. */
export const SNAPSHOT_JOURNAL_SQLITE_SHARED_SOURCE_EVENT_DDL = Object.freeze([
  SNAPSHOT_JOURNAL_SQLITE_SOURCE_ROWS_DDL,
  ...sharedEventDdl(true)
])
/** Fresh family DATA only. Every event view has this exact, complete fixed
 * column order and no defaults. Positional INSERT preserves the same cells and
 * statement order without persisting the repeated column list in each emitter.
 * Keep the historical generators unchanged for occupied complete generations.
 * This transformation does not grant source, generation or write authority. */
export function snapshotJournalPositionalEventSql(definitions: readonly string[]): string[] {
  const columns = [
    ['guard', 'valid'],
    ['scope', scopeColumns],
    ['physical', physicalColumns + ',fresh'],
    ['advance', 'event'],
    ['member', memberEventColumns],
    ['source', sourceEventColumns],
    ['pointer', 'tableId,rowId']
  ] as const
  return definitions.map(sql => {
    if (!sql.startsWith('CREATE TRIGGER snapshot_journal_')) return sql
    // Sync-state physical IDs already admit safe signed integers. Its derived
    // membership must use the same range; every other source remains positive.
    // Occupied historical families do not pass through this fresh transform.
    if (sql.startsWith('CREATE TRIGGER snapshot_journal_member_apply '))
      sql = sql.replace(
        'NEW.id1 BETWEEN 1 AND 9007199254740991',
        'NEW.id1 BETWEEN CASE WHEN NEW.tableId=7 THEN -9007199254740991 ELSE 1 END AND 9007199254740991'
      )
    for (const [name, fields] of columns)
      sql = sql.replaceAll(
        `INSERT INTO snapshot_journal_${name}_event(${fields})`,
        `INSERT INTO snapshot_journal_${name}_event`
      )
    return sql
  })
}
export const SNAPSHOT_JOURNAL_SQLITE_POSITIONAL_SOURCE_EVENT_DDL = Object.freeze(
  snapshotJournalPositionalEventSql(SNAPSHOT_JOURNAL_SQLITE_SHARED_SOURCE_EVENT_DDL)
)
function sharedSourceTrigger(tableId: number, table: string, event: string, changed: string): string {
  const prefix = event === 'DELETE' ? 'OLD' : 'NEW',
    owner = tableId < 8 ? `${prefix}.userId` : 'NULL',
    old =
      event === 'UPDATE'
        ? [...tuple(table, 'OLD'), tableId < 8 ? 'OLD.userId' : 'NULL']
        : ['NULL', 'NULL', 'NULL', 'NULL'],
    ordinal = ['INSERT', 'UPDATE', 'DELETE'].indexOf(event) + 1,
    values = [
      String(ordinal),
      String(tableId),
      ...tuple(table, prefix),
      owner,
      ...old,
      freshGeneration(event, table, true)
    ]
  return `CREATE TRIGGER snapshot_journal_physical_${tableId}_${event} AFTER ${event} ON ${q(table)} ${event === 'UPDATE' ? 'WHEN ' + changed : ''} BEGIN INSERT INTO snapshot_journal_source_event(${sourceEventColumns}) VALUES(${values.join(',')}); END`
}

/** Logical pointer replacement is a real source change even when every
 * physical main-row marker/metadata byte stays equal. These exact observers
 * belong to the same complete generation as the original main-row observers.
 * A main-row delete already records its tombstone, so a cascaded pointer delete
 * whose actual main row is gone does not turn that tombstone into a live row. */
export function snapshotJournalPackedPointerObserverSql(text = false, shared = false, sharedEvents = false): string[] {
  const definitions: string[] = []
  const sources = text
    ? ([
        [0, 0, 'transactions', 'transactionId'],
        [2, 9, 'proven_tx_reqs', 'provenTxReqId'],
        [3, 1, 'outputs', 'outputId'],
        [4, 6, 'commissions', 'commissionId'],
        [5, 7, 'sync_states', 'syncStateId'],
        [6, 2, 'certificates', 'certificateId']
      ] as const)
    : ([
        [0, 0, 'transactions', 'transactionId'],
        [1, 8, 'proven_txs', 'provenTxId'],
        [2, 9, 'proven_tx_reqs', 'provenTxReqId'],
        [3, 1, 'outputs', 'outputId'],
        [4, 6, 'commissions', 'commissionId']
      ] as const)
  for (const [packedId, tableId, table, key] of sources) {
    for (const event of ['INSERT', 'DELETE'] as const) {
      const prefix = event === 'DELETE' ? 'OLD' : 'NEW',
        id = prefix + '.rowId',
        point = `s.${q(key)}=${id}`,
        owner = tableId < 8 ? `(SELECT s.userId FROM ${q(table)} s WHERE ${point})` : undefined
      let body = keyGuard([id, '0', "''"], owner, tableId === 7, shared) + tick
      body += shared
        ? `INSERT INTO snapshot_journal_physical_event(${physicalColumns},fresh) SELECT ${tableId},${id},0,'',${revision},${revision},1,0 WHERE ${writable}; `
        : `INSERT INTO snapshot_journal_physical(${physicalKey},revision,generation,present) SELECT ${tableId},${id},0,'',${revision},${revision},1 WHERE ${writable} ON CONFLICT(${physicalKey}) DO UPDATE SET revision=excluded.revision,present=1; `
      if (tableId < 8)
        body += scopeUpsert(
          `SELECT ${tableId},s.userId,${id},0,'',${revision},1 FROM ${q(table)} s WHERE ${point} AND ${writable}`,
          shared
        )
      definitions.push(
        `CREATE TRIGGER snapshot_journal_packed_${text ? 'text_' : ''}${packedId}_${event} AFTER ${event} ON ${text ? nativePackedTextTables.fields : nativePackedTables.fields} WHEN ${prefix}.tableId=${packedId} AND EXISTS(SELECT 1 FROM ${q(table)} s WHERE ${point}) BEGIN ${sharedEvents ? `INSERT INTO snapshot_journal_pointer_event(tableId,rowId) VALUES(${tableId},${id});` : body} END`
      )
    }
  }
  if (text)
    for (const event of ['INSERT', 'DELETE'] as const) {
      const prefix = event === 'DELETE' ? 'OLD' : 'NEW',
        point = `s.rowid=${prefix}.rowId`,
        value = (column: string): string => `(SELECT s.${q(column)} FROM certificate_fields s WHERE ${point})`,
        keys = [value('certificateId'), '0', value('fieldName')]
      let body = keyGuard(keys, value('userId'), false, shared) + tick
      body += shared
        ? `INSERT INTO snapshot_journal_physical_event(${physicalColumns},fresh) SELECT 12,s.certificateId,0,s.fieldName,${revision},${revision},1,0 FROM certificate_fields s WHERE ${point} AND ${writable}; `
        : `INSERT INTO snapshot_journal_physical(${physicalKey},revision,generation,present) SELECT 12,s.certificateId,0,s.fieldName,${revision},${revision},1 FROM certificate_fields s WHERE ${point} AND ${writable} ON CONFLICT(${physicalKey}) DO UPDATE SET revision=excluded.revision,present=1; `
      body += scopeUpsert(
        `SELECT 12,m.snapshotUserId,s.certificateId,0,s.fieldName,${revision},1 FROM certificate_fields s JOIN ${names.certificate} m ON m.snapshotCertificateId=s.certificateId AND CAST(m.snapshotFieldName AS BLOB)=CAST(s.fieldName AS BLOB) WHERE ${point} AND ${writable}`,
        shared
      )
      definitions.push(
        `CREATE TRIGGER snapshot_journal_packed_text_7_${event} AFTER ${event} ON ${nativePackedTextTables.fields} WHEN ${prefix}.tableId=7 AND EXISTS(SELECT 1 FROM certificate_fields s WHERE ${point}) BEGIN ${sharedEvents ? `INSERT INTO snapshot_journal_pointer_event(tableId,rowId) VALUES(12,${prefix}.rowId);` : body} END`
      )
    }
  return definitions
}

/** Read one bounded group of table columns in one fresh SQLite statement.
 * The result belongs only to this observer construction; it is never retained
 * as schema, generation or commit authority. Other drivers retain the original
 * per-table PRAGMA path. */
interface ObservedColumns {
  table: string
  columns: Array<{ name: string }>
}
async function readObserverColumns(k: Knex): Promise<ObservedColumns[] | undefined> {
  const tables = [...snapshotJournalSqliteSources]
  if (
    (k.client.config.client !== 'better-sqlite3' && !isOwnedNativeSqlite(k)) ||
    tables.length === 0 ||
    tables.length > 16
  )
    return undefined
  const selected = tables.map((_, i) => `SELECT ${i} ordinal, ? name`).join(' UNION ALL ')
  const rows: Array<{ ordinal: string; name: string }> = await k.raw(
    `SELECT CAST(s.ordinal AS TEXT) ordinal,p.name FROM (${selected}) s CROSS JOIN pragma_table_info(s.name) p ORDER BY s.ordinal,p.cid`,
    tables
  )
  const observed: ObservedColumns[] = tables.map(table => ({ table, columns: [] }))
  const byOrdinal = new Map(observed.map((value, index) => [String(index), value]))
  for (const { ordinal, name } of rows) byOrdinal.get(ordinal)?.columns.push({ name })
  return observed
}

async function observerColumns(
  k: Knex,
  observed: ObservedColumns[] | undefined,
  tableId: number,
  table: string
): Promise<Array<{ name: string }>> {
  const selected = observed?.[tableId]
  return selected?.table === table ? selected.columns : await k.raw('PRAGMA table_info(??)', [table])
}

/** Prepare observers only after the caller validates the completed v2 source generation. */
export async function snapshotJournalSqliteObserverSql(
  k: Knex,
  sharedEffects = false,
  sharedEvents = false,
  nativeCells = false
): Promise<string[]> {
  if (!['sqlite3', 'better-sqlite3'].includes(k.client.config.client) && !isOwnedNativeSqlite(k))
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
        sharedEvents
          ? `CREATE TRIGGER snapshot_journal_scope_${i}_${event} AFTER ${event} ON ${q(source.table)} BEGIN INSERT INTO snapshot_journal_member_event(${memberEventColumns}) VALUES(${[...fields, event === 'DELETE' ? '0' : source.present(p)].join(',')}); END`
          : `CREATE TRIGGER snapshot_journal_scope_${i}_${event} AFTER ${event} ON ${q(source.table)} BEGIN ${keyGuard(fields.slice(2), fields[1], false, sharedEffects)}${tick}${scopeUpsert('SELECT ' + selected + ' WHERE ' + writable, sharedEffects)} END`
      )
    }
  const observed = await readObserverColumns(k)
  await runInSeries(snapshotJournalSqliteSources.entries(), async ([tableId, table]) => {
    const columns: Array<{ name: string }> = await observerColumns(k, observed, tableId, table)
    if (columns.length === 0) throw new WERR_INVALID_OPERATION('Missing snapshot journal source')
    const changed = snapshotSqliteCellsChanged(
      columns.map(({ name }) => name),
      nativeCells
    )
    for (const event of ['INSERT', 'UPDATE', 'DELETE'])
      definitions.push(
        sharedEvents
          ? sharedSourceTrigger(tableId, table, event, changed)
          : physicalTrigger(tableId, table, event, changed, sharedEffects)
      )
  })
  if (isOwnedNativeSqlite(k)) {
    // Root callers obtain a real finite read transaction for schema inspection;
    // an existing actual transaction retains its original view. No cached flag.
    const packed = k.isTransaction
      ? await hasBrc38NativePackedSchema(k as Knex.Transaction)
      : await k.transaction(async trx => await hasBrc38NativePackedSchema(trx))
    if (packed) definitions.push(...snapshotJournalPackedPointerObserverSql(false, sharedEffects, sharedEvents))
    const text = k.isTransaction
      ? await hasBrc38NativePackedTextSchema(k as Knex.Transaction)
      : await k.transaction(async trx => await hasBrc38NativePackedTextSchema(trx))
    if (text) definitions.push(...snapshotJournalPackedPointerObserverSql(true, sharedEffects, sharedEvents))
  }
  return definitions
}
