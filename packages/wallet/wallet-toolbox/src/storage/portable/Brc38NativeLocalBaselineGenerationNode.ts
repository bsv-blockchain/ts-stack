import { brc38NativeLocalBaselinePointerGroup } from './Brc38NativeLocalBaselinePointerGroup'
import { brc38NativeLocalBaselineCompactObserverNames } from './Brc38NativeLocalBaselineObserverNames'
import { brc38NativeLocalBaselinePointerProjection } from './Brc38NativeLocalBaselinePointerProjection'
import {
  brc38NativeLocalEpochRecoveryTable as recoveryTable,
  brc38NativeLocalEpochRecoveryDefinitions as recoveryDefinitions,
  brc38NativeLocalEpochRecoverySourceDefinitions
} from './Brc38NativeLocalEpochRecoverySchema'
import { hasBrc38NativeLocalPackedLayout } from './Brc38NativeLocalPackedLayoutNode'
import { brc38NativeLocalPackedSources } from './Brc38NativeLocalPackedLayout'
import type { Knex } from 'knex'
import { randomUUID } from 'node:crypto'
import { ownedNativeRootIdentity } from '../schema/ownedNativeSqliteConnectionsNode'
import {
  brc38NativeLocalBaselineTables,
  brc38NativeLocalBaselineTableCount as tableCount,
  type Brc38NativeLocalBaselineTable
} from './Brc38NativeLocalBaselineTables'
import { snapshotJournalRevision, type SnapshotJournalRevision } from '../snapshot/journal/SnapshotJournalRevision'
import { hasBrc38NativePackedSchema, nativePackedTables } from './Brc38NativePackedSchemaNode'
import { hasBrc38NativePackedTextSchema, nativePackedTextTables } from './Brc38NativePackedTextSchemaNode'
import { nativePackedTextSources } from './Brc38NativePackedTextSources'

export const brc38NativeLocalBaselineGenerationMigration = '2026-10-07-004 native local baseline mutation journal'
const clock = 'brc38_local_baseline_clock',
  rows = 'brc38_local_baseline_rows',
  prefix = 'brc38_local_baseline_',
  safeMinimum = '-9007199254740991',
  safeMaximum = '9007199254740991',
  enabled = `(SELECT enabled FROM ${clock} WHERE slot=1)=1`,
  revision = `(SELECT revision FROM ${clock} WHERE slot=1)`
const definitions = [
  `CREATE TABLE ${clock}(slot INTEGER PRIMARY KEY CHECK(slot=1),protocol TEXT NOT NULL CHECK(protocol='brc38-local-baseline-journal/v2'),epoch TEXT NOT NULL CHECK(length(CAST(epoch AS BLOB))=36),revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=0),ceiling INTEGER NOT NULL CHECK(typeof(ceiling)='integer' AND ceiling>=revision),maximumRows INTEGER NOT NULL CHECK(typeof(maximumRows)='integer' AND maximumRows BETWEEN 1 AND 10000000),records INTEGER NOT NULL CHECK(typeof(records)='integer' AND records BETWEEN 0 AND maximumRows),enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),reason TEXT CHECK((enabled=1 AND reason IS NULL) OR (enabled=0 AND reason IS NOT NULL AND reason IN ('capacity-exhausted','revision-exhausted','key-out-of-range'))),bootstrapTable INTEGER NOT NULL CHECK(bootstrapTable BETWEEN 0 AND ${tableCount}),afterRowId INTEGER CHECK(afterRowId IS NULL OR (typeof(afterRowId)='integer' AND afterRowId BETWEEN ${safeMinimum} AND ${safeMaximum})),complete INTEGER NOT NULL CHECK(complete IN (0,1) AND (complete=0 OR (bootstrapTable=${tableCount} AND afterRowId IS NULL))))`,
  `CREATE TABLE ${rows}(tableId INTEGER NOT NULL CHECK(typeof(tableId)='integer' AND tableId BETWEEN 0 AND ${tableCount - 1}),rowId INTEGER NOT NULL CHECK(typeof(rowId)='integer' AND rowId BETWEEN ${safeMinimum} AND ${safeMaximum}),revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=0),generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation BETWEEN 0 AND revision),present INTEGER NOT NULL CHECK(present IN (0,1)),PRIMARY KEY(tableId,rowId))`,
  `CREATE INDEX brc38_local_baseline_revision ON ${rows}(revision,tableId,rowId)`,
  `CREATE INDEX brc38_local_baseline_present_revision ON ${rows}(present,revision,tableId,rowId)`,
  `CREATE INDEX brc38_local_baseline_deleted_order ON ${rows}(present,tableId,revision,rowId)`,
  `CREATE TRIGGER brc38_local_baseline_clock_delete_guard BEFORE DELETE ON ${clock} BEGIN SELECT RAISE(ABORT,'Local baseline epoch cannot be deleted while owned'); END`,
  `CREATE TRIGGER brc38_local_baseline_clock_update_guard BEFORE UPDATE ON ${clock} WHEN NEW.slot IS NOT OLD.slot OR NEW.protocol IS NOT OLD.protocol OR NEW.epoch IS NOT OLD.epoch OR NEW.ceiling IS NOT OLD.ceiling OR NEW.maximumRows IS NOT OLD.maximumRows OR NEW.revision<OLD.revision OR NEW.records<OLD.records OR NEW.enabled>OLD.enabled OR NEW.complete<OLD.complete OR NEW.bootstrapTable<OLD.bootstrapTable OR NEW.bootstrapTable>OLD.bootstrapTable+1 OR (NEW.bootstrapTable=OLD.bootstrapTable AND OLD.afterRowId IS NOT NULL AND (NEW.afterRowId IS NULL OR NEW.afterRowId<OLD.afterRowId)) OR (NEW.bootstrapTable!=OLD.bootstrapTable AND NEW.afterRowId IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Local baseline original epoch or progress differs'); END`,
  `CREATE TRIGGER brc38_local_baseline_rows_insert_guard BEFORE INSERT ON ${rows} WHEN NOT ${enabled} OR NOT EXISTS(SELECT 1 FROM ${clock} WHERE slot=1 AND records<maximumRows AND NEW.revision=revision) BEGIN SELECT RAISE(ABORT,'Local baseline original row reservation differs'); END`,
  `CREATE TRIGGER brc38_local_baseline_rows_insert_charge AFTER INSERT ON ${rows} BEGIN UPDATE ${clock} SET records=records+1 WHERE slot=1; END`,
  `CREATE TRIGGER brc38_local_baseline_rows_update_guard BEFORE UPDATE ON ${rows} WHEN NEW.tableId IS NOT OLD.tableId OR NEW.rowId IS NOT OLD.rowId OR NEW.revision<OLD.revision OR NEW.revision!=${revision} OR NEW.generation!=CASE WHEN OLD.present=0 AND NEW.present=1 THEN NEW.revision ELSE OLD.generation END BEGIN SELECT RAISE(ABORT,'Local baseline physical generation differs'); END`,
  `CREATE TRIGGER brc38_local_baseline_rows_delete_guard BEFORE DELETE ON ${rows} BEGIN SELECT RAISE(ABORT,'Local baseline tombstone is retained by its epoch'); END`
]
/** A disabled local epoch refuses capture/reconciliation; source application
 * mutations keep their ordinary behavior. Capacity/key exhaustion cannot
 * silently admit an incomplete baseline or allocate unbounded tombstones. */
const advance = `UPDATE ${clock} SET enabled=CASE WHEN revision>=ceiling THEN 0 ELSE enabled END,reason=CASE WHEN revision>=ceiling THEN 'revision-exhausted' ELSE reason END,revision=CASE WHEN revision<ceiling THEN revision+1 ELSE revision END WHERE slot=1 AND enabled=1; `
function observe(
  tableId: number | string,
  context: 'OLD' | 'NEW',
  present: 0 | 1,
  condition = '1',
  physicalRow?: string
): string {
  const rowId = physicalRow ?? `${context}.rowid`,
    point = `tableId=${tableId} AND rowId=${rowId}`
  return (
    `UPDATE ${clock} SET enabled=0,reason='key-out-of-range' WHERE slot=1 AND enabled=1 AND (${condition}) AND (typeof(${rowId})!='integer' OR ${rowId}<${safeMinimum} OR ${rowId}>${safeMaximum}); ` +
    `UPDATE ${clock} SET enabled=0,reason='capacity-exhausted' WHERE slot=1 AND enabled=1 AND (${condition}) AND records>=maximumRows AND NOT EXISTS(SELECT 1 FROM ${rows} WHERE ${point}); ` +
    // UPDATE existing identities separately: SQLite BEFORE INSERT triggers
    // also run on UPSERT conflicts and must not consume a new reservation.
    `UPDATE ${rows} SET revision=${revision},generation=CASE WHEN present=0 AND ${present}=1 THEN ${revision} ELSE generation END,present=${present} WHERE ${point} AND ${enabled} AND (${condition}); ` +
    `INSERT INTO ${rows}(tableId,rowId,revision,generation,present) SELECT ${tableId},${rowId},${revision},${revision},${present} WHERE ${enabled} AND (${condition}) AND NOT EXISTS(SELECT 1 FROM ${rows} WHERE ${point}); `
  )
}
function directSourceObservers(tableId: number, table: Brc38NativeLocalBaselineTable): readonly string[] {
  return [
    `CREATE TRIGGER brc38_local_baseline_${table}_insert AFTER INSERT ON ${table} BEGIN ${advance}${observe(tableId, 'NEW', 1)}END`,
    `CREATE TRIGGER brc38_local_baseline_${table}_delete AFTER DELETE ON ${table} BEGIN ${advance}${observe(tableId, 'OLD', 0)}END`,
    `CREATE TRIGGER brc38_local_baseline_${table}_update AFTER UPDATE ON ${table} BEGIN ${advance}${observe(tableId, 'OLD', 0, 'OLD.rowid IS NOT NEW.rowid')}${observe(tableId, 'NEW', 1)}END`
  ]
}
for (const [tableId, table] of brc38NativeLocalBaselineTables.entries())
  definitions.push(...directSourceObservers(tableId, table))
const eventView = 'brc38_local_baseline_event'
function emitEvent(tableId: number, oldRowId: string, newRowId: string, present: 0 | 1): string {
  return `INSERT INTO ${eventView}(tableId,oldRowId,newRowId,present) VALUES(${tableId},${oldRowId},${newRowId},${present}); `
}
// v3 stores the complete original observer once. Its view has no rows/root
// page, and the native authorizer accepts inserts only from freshly exact
// canonical source observers. It cannot be called as a user-supplied event.
const sharedDefinitions = [
  ...definitions
    .slice(0, 11)
    .map(sql => sql.replace('brc38-local-baseline-journal/v2', 'brc38-local-baseline-journal/v3')),
  `CREATE VIEW ${eventView}(tableId,oldRowId,newRowId,present) AS SELECT NULL,NULL,NULL,NULL WHERE 0`,
  `CREATE TRIGGER brc38_local_baseline_event_dispatch INSTEAD OF INSERT ON ${eventView} BEGIN SELECT CASE WHEN typeof(NEW.tableId)!='integer' OR NEW.tableId NOT BETWEEN 0 AND ${tableCount - 1} OR typeof(NEW.present)!='integer' OR NEW.present NOT IN (0,1) OR NOT ((NEW.present=0 AND typeof(NEW.oldRowId)='integer' AND NEW.newRowId IS NULL) OR (NEW.present=1 AND typeof(NEW.newRowId)='integer' AND (NEW.oldRowId IS NULL OR typeof(NEW.oldRowId)='integer'))) THEN RAISE(ABORT,'Local baseline source event differs') END; ${advance}${observe('NEW.tableId', 'OLD', 0, 'NEW.oldRowId IS NOT NULL AND (NEW.present=0 OR NEW.oldRowId IS NOT NEW.newRowId)', 'NEW.oldRowId')}${observe('NEW.tableId', 'NEW', 1, 'NEW.present=1', 'NEW.newRowId')}END`
]
for (const [tableId, table] of brc38NativeLocalBaselineTables.entries()) {
  // New receipt rows use the original direct SQL observer and its exact quota,
  // generation and rollback guards. Existing kernel dispatch coordinates stay
  // unchanged; no new executable pin or event-emission authority is required.
  if (table === 'internalize_receipts') {
    sharedDefinitions.push(...directSourceObservers(tableId, table))
    continue
  }
  sharedDefinitions.push(
    `CREATE TRIGGER brc38_local_baseline_${table}_insert AFTER INSERT ON ${table} BEGIN ${emitEvent(tableId, 'NULL', 'NEW.rowid', 1)}END`,
    `CREATE TRIGGER brc38_local_baseline_${table}_delete AFTER DELETE ON ${table} BEGIN ${emitEvent(tableId, 'OLD.rowid', 'NULL', 0)}END`,
    `CREATE TRIGGER brc38_local_baseline_${table}_update AFTER UPDATE ON ${table} BEGIN ${emitEvent(tableId, 'OLD.rowid', 'NEW.rowid', 1)}END`
  )
}
// Only derived coordinates use this clustered primary tree. All original
// operational source tables retain their physical rowids. Keep the historical
// v3 family intact for occupied roots; mixed families fail exact comparison.
const eventColumns = '(tableId,oldRowId,newRowId,present)',
  compactDefinitions = sharedDefinitions.map((sql, index) =>
    index === 1
      ? `${sql} WITHOUT ROWID`
      : sql.replace(`INSERT INTO ${eventView}${eventColumns}`, `INSERT INTO ${eventView}`)
  )
const namedDefinitions = brc38NativeLocalBaselineCompactObserverNames(compactDefinitions)
function pointerObservers(
  text: boolean,
  local: boolean,
  shared: boolean,
  compact = false,
  projected = false,
  grouped = false
): readonly string[] {
  const sources = text
      ? nativePackedTextSources.map(source => ({ id: source.id, table: source.sql, key: source.key }))
      : [
          { id: 0, table: 'transactions', key: 'transactionId' },
          { id: 1, table: 'proven_txs', key: 'provenTxId' },
          { id: 2, table: 'proven_tx_reqs', key: 'provenTxReqId' },
          { id: 3, table: 'outputs', key: 'outputId' },
          { id: 4, table: 'commissions', key: 'commissionId' }
        ],
    result: string[] = []
  const complete = [
    ...sources,
    ...(local ? brc38NativeLocalPackedSources.filter(source => source.kind === (text ? 'text' : 'binary')) : [])
  ]
  if (grouped) {
    if (!shared || !compact || !projected) invalid()
    const coordinates = complete.map(source => {
      const tableId = brc38NativeLocalBaselineTables.indexOf(source.table as Brc38NativeLocalBaselineTable)
      if (tableId < 0) invalid()
      return { ...source, tableId }
    })
    return Object.freeze(
      (['INSERT', 'DELETE'] as const).map(event =>
        brc38NativeLocalBaselinePointerGroup(text ? 'text' : 'binary', coordinates, event)
      )
    )
  }
  for (const source of complete) {
    const tableId = brc38NativeLocalBaselineTables.indexOf(source.table as Brc38NativeLocalBaselineTable)
    if (tableId < 0) invalid()
    for (const event of ['INSERT', 'DELETE'] as const) {
      if (projected) {
        if (!shared || !compact) invalid()
        result.push(brc38NativeLocalBaselinePointerProjection(text ? 'text' : 'binary', source, tableId, event))
        continue
      }
      const context = event === 'INSERT' ? 'NEW' : 'OLD',
        point = `s.${source.key}=${context}.rowId`,
        actualRow = `(SELECT s.rowid FROM ${source.table} s WHERE ${point})`,
        originalBody = shared
          ? emitEvent(tableId, 'NULL', actualRow, 1)
          : advance + observe(tableId, 'NEW', 1).replaceAll('NEW.rowid', actualRow)
      const body = compact
        ? originalBody.replace(`INSERT INTO ${eventView}${eventColumns}`, `INSERT INTO ${eventView}`)
        : originalBody
      result.push(
        `CREATE TRIGGER brc38_local_baseline_packed_${text ? 'text' : 'binary'}_${source.id}_${event} AFTER ${event} ON ${text ? nativePackedTextTables.fields : nativePackedTables.fields} WHEN ${context}.tableId=${source.id} AND EXISTS(SELECT 1 FROM ${source.table} s WHERE ${point}) BEGIN ${body}END`
      )
    }
  }
  return result
}
/** Schema-family selection is fresh DATA from this genuine view. A later
 * layout change cannot reuse an earlier schema result or silently lose pointer
 * events; exact observer comparison then refuses the incomplete epoch. */
export async function brc38NativeLocalBaselineSourceDefinitions(k: Knex.Transaction): Promise<readonly string[]> {
  actual(k)
  // A present TEXT family already verifies the complete binary family on
  // this same actual transaction. Keep the absent-TEXT binary fallback;
  // no verdict survives this call or replaces the complete observer check.
  const text = await hasBrc38NativePackedTextSchema(k),
    binary = text || (await hasBrc38NativePackedSchema(k)),
    local = await hasBrc38NativeLocalPackedLayout(k)
  const installed = (await k('sqlite_schema').where({ type: 'table', name: clock }).first('sql')) as
    { sql: string } | undefined
  if (installed !== undefined && installed.sql !== definitions[0] && installed.sql !== sharedDefinitions[0]) invalid()
  const installedRows = (await k('sqlite_schema').where({ type: 'table', name: rows }).first('sql')) as
    { sql: string } | undefined
  const shared = installed === undefined || installed.sql === sharedDefinitions[0],
    compact = installed === undefined || installedRows?.sql === compactDefinitions[1]
  if (
    (installed === undefined && installedRows !== undefined) ||
    (installed !== undefined &&
      installedRows?.sql !== definitions[1] &&
      installedRows?.sql !== compactDefinitions[1]) ||
    (!shared && compact)
  )
    invalid()
  // A genuine anchor chooses definition DATA only. Every selected observer
  // still undergoes the complete exact family check below. No occupied family
  // is converted, and a mixed or altered family cannot inherit this selection.
  let named = false
  if (installed !== undefined && shared && compact) {
    const original = compactDefinitions[13],
      current = namedDefinitions[13],
      originalName = /^CREATE TRIGGER ([A-Za-z0-9_]+)/.exec(original)![1],
      currentName = /^CREATE TRIGGER ([A-Za-z0-9_]+)/.exec(current)![1],
      anchors = (await k('main.sqlite_schema')
        .where({ type: 'trigger' })
        .whereIn('name', [originalName, currentName])
        .select('name', 'sql')
        .limit(3)) as Array<{ name: string; sql: unknown }>
    if (anchors.length !== 1) invalid()
    if (anchors[0].name === currentName && anchors[0].sql === current) named = true
    else if (anchors[0].name !== originalName || anchors[0].sql !== original) invalid()
  }
  let projected = installed === undefined,
    grouped = installed === undefined
  if (installed !== undefined && shared && compact && (binary || text)) {
    const legacy = pointerObservers(!binary, local, shared, compact),
      expected = pointerObservers(!binary, local, shared, compact, true),
      groupedExpected = pointerObservers(!binary, local, shared, compact, true, true),
      oldName = /^CREATE TRIGGER ([A-Za-z0-9_]+)/.exec(legacy[0])![1],
      groupName = /^CREATE TRIGGER ([A-Za-z0-9_]+)/.exec(groupedExpected[0])![1],
      anchors = (await k('main.sqlite_schema')
        .where({ type: 'trigger' })
        .whereIn('name', [oldName, groupName])
        .select('name', 'sql')
        .limit(3)) as Array<{ name: string; sql: unknown }>,
      oldAnchor = anchors.find(anchor => anchor.name === oldName),
      groupAnchor = anchors.find(anchor => anchor.name === groupName)
    if (anchors.length !== 1) invalid()
    if (groupAnchor?.sql === groupedExpected[0] && oldAnchor === undefined) {
      grouped = true
      projected = true
    } else if (oldAnchor !== undefined && groupAnchor === undefined) {
      grouped = false
      if (oldAnchor.sql === expected[0]) projected = true
      else if (oldAnchor.sql !== legacy[0]) invalid()
    } else invalid()
  }
  const base = [
    ...(shared ? (compact ? (named ? namedDefinitions : compactDefinitions) : sharedDefinitions) : definitions),
    ...(binary ? pointerObservers(false, local, shared, compact, projected, grouped) : []),
    ...(text ? pointerObservers(true, local, shared, compact, projected, grouped) : [])
  ]
  return (await hasRecoverySchema(k)) ? brc38NativeLocalEpochRecoverySourceDefinitions(base) : Object.freeze(base)
}
function actual(k: Knex.Transaction, write = false): void {
  const owner = ownedNativeRootIdentity(k)
  if (
    k.isTransaction !== true ||
    k.isCompleted() ||
    owner === undefined ||
    (write ? owner.slot !== 0 : ![0, 3].includes(owner.slot))
  )
    throw new Error('Local baseline journal requires its actual current native transaction')
}
function invalid(): never {
  throw new Error('Local baseline original generation, schema or progress differs')
}
export interface Brc38NativeLocalBaselineGeneration {
  readonly epoch: string
  readonly revision: SnapshotJournalRevision
  readonly ceiling: SnapshotJournalRevision
  readonly maximumRows: number
  readonly records: number
  readonly enabled: boolean
  readonly reason: 'capacity-exhausted' | 'revision-exhausted' | 'key-out-of-range' | null
  readonly complete: boolean
  readonly bootstrapTable: number
  readonly afterRowId: number | null
}
export async function hasBrc38NativeLocalBaselineGenerationSchema(k: Knex.Transaction): Promise<boolean> {
  actual(k)
  const objects = (await k('sqlite_schema')
    .whereRaw('substr(name,1,?)=?', [prefix.length, prefix])
    .count({ count: '*' })
    .first()) as { count: number }
  if (objects.count === 0) return false
  const selected = await brc38NativeLocalBaselineSourceDefinitions(k),
    currentExpected = new Map(
      selected.map(sql => {
        const match = /^CREATE (TABLE|INDEX|TRIGGER|VIEW) ([A-Za-z0-9_]+)/.exec(sql)!
        return [match[2], { type: match[1].toLowerCase(), sql }]
      })
    )
  if (objects.count !== currentExpected.size) invalid()
  // Compare every fresh definition inside SQLite with bounded bindings. Both
  // counts must agree so a duplicate cannot mask an absent object. This is
  // comparison DATA for this call, never a retained schema or owner verdict.
  // Use the existing packed-schema 32-definition/32KiB dispatch envelope,
  // within the original 65,537-byte native frame floor. Fresh exact checks,
  // unique-name counts and the complete family/index comparisons remain.
  let batch: Array<{ name: string; type: string; sql: string }> = [],
    bytes = 0
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return
    actual(k)
    const row = (await k('sqlite_schema')
      .where(query => {
        for (const source of batch)
          query.orWhere(part => {
            void part
              .where({ type: source.type, name: source.name })
              .whereRaw('CAST(sql AS BLOB)=CAST(? AS BLOB)', [source.sql])
          })
      })
      .count({ count: '*' })
      .countDistinct({ names: 'name' })
      .first()) as { count: unknown; names: unknown } | undefined
    actual(k)
    if (row?.count !== batch.length || row.names !== batch.length) invalid()
    batch = []
    bytes = 0
  }
  for (const [name, source] of currentExpected) {
    actual(k)
    const amount = Buffer.byteLength(name) + Buffer.byteLength(source.type) + Buffer.byteLength(source.sql)
    if (batch.length !== 0 && (batch.length >= 32 || amount > 32768 - bytes)) await flush()
    batch.push({ name, ...source })
    bytes += amount
    if (amount > 32768) await flush()
  }
  await flush()
  const primary = (await k('sqlite_schema')
    .where({ tbl_name: rows, type: 'index' })
    .whereNull('sql')
    .select('name')
    .limit(2)) as Array<{ name: string }>
  if (selected[1] === compactDefinitions[1]) {
    if (primary.length !== 0) invalid()
  } else if (primary.length !== 1 || primary[0].name !== `sqlite_autoindex_${rows}_1`) invalid()
  actual(k)
  return true
}
export async function readBrc38NativeLocalBaselineGeneration(
  k: Knex.Transaction
): Promise<Readonly<Brc38NativeLocalBaselineGeneration>> {
  actual(k)
  if (!(await hasBrc38NativeLocalBaselineGenerationSchema(k))) invalid()
  return await readBrc38NativeLocalBaselineGenerationData(k)
}
/** @internal Fresh clock DATA only, never schema/source/primary admission.
 * The full reader above verifies every schema on each call. The scoped source
 * facade may use this reader only inside its already authenticated, retained,
 * query-only snapshot; its private transaction never escapes that facade. New
 * snapshots and every mutable transaction still require the full verifier. */
export async function readBrc38NativeLocalBaselineGenerationData(
  k: Knex.Transaction
): Promise<Readonly<Brc38NativeLocalBaselineGeneration>> {
  actual(k)
  const values = (await k(clock)
    .where({ slot: 1 })
    .select(
      'protocol',
      'epoch',
      'maximumRows',
      'records',
      'enabled',
      'reason',
      'complete',
      'bootstrapTable',
      k.raw(
        'CAST(revision AS TEXT) AS revision,CAST(ceiling AS TEXT) AS ceiling,CAST(afterRowId AS TEXT) AS afterRowId'
      )
    )
    .limit(2)) as Array<Record<string, unknown>>
  if (values.length !== 1) invalid()
  const row = values[0],
    safe = (value: unknown, maximum: number): number => {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) invalid()
      return value
    },
    maximumRows = safe(row.maximumRows, 10000000),
    records = safe(row.records, maximumRows),
    bootstrapTable = safe(row.bootstrapTable, tableCount),
    enabledValue = safe(row.enabled, 1),
    complete = safe(row.complete, 1),
    revisionValue = snapshotJournalRevision(row.revision),
    ceiling = snapshotJournalRevision(row.ceiling)
  if (
    !['brc38-local-baseline-journal/v2', 'brc38-local-baseline-journal/v3'].includes(String(row.protocol)) ||
    maximumRows < 1 ||
    typeof row.epoch !== 'string' ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(row.epoch) ||
    BigInt(revisionValue) > BigInt(ceiling) ||
    (row.afterRowId !== null &&
      (typeof row.afterRowId !== 'string' ||
        !/^-?(?:0|[1-9]\d{0,15})$/.test(row.afterRowId) ||
        !Number.isSafeInteger(Number(row.afterRowId)) ||
        String(Number(row.afterRowId)) !== row.afterRowId)) ||
    (complete === 1) !== (bootstrapTable === tableCount) ||
    (complete === 1 && row.afterRowId !== null) ||
    (enabledValue === 1 && row.reason !== null) ||
    (enabledValue === 0 &&
      !['capacity-exhausted', 'revision-exhausted', 'key-out-of-range'].includes(String(row.reason)))
  )
    invalid()
  actual(k)
  return Object.freeze({
    epoch: row.epoch,
    revision: revisionValue,
    ceiling,
    maximumRows,
    records,
    enabled: enabledValue === 1,
    reason: row.reason as Brc38NativeLocalBaselineGeneration['reason'],
    complete: complete === 1,
    bootstrapTable,
    afterRowId: row.afterRowId === null ? null : Number(row.afterRowId)
  })
}
/** Explicit source-owned installation only. Caller first authenticates its
 * profile/primary and admits the finite physical/logical metadata work. No
 * ordinary read silently installs observers or changes the public provider. */
export async function installBrc38NativeLocalBaselineGeneration(
  k: Knex.Transaction,
  selected: Readonly<{ maximumRows: number; ceiling: SnapshotJournalRevision }>
): Promise<void> {
  const maximumRows = selected.maximumRows,
    ceiling = snapshotJournalRevision(selected.ceiling),
    epoch = randomUUID()
  actual(k, true)
  if (
    !Number.isSafeInteger(maximumRows) ||
    maximumRows < 1 ||
    maximumRows > 10000000 ||
    ceiling === '0' ||
    (await hasBrc38NativeLocalBaselineGenerationSchema(k))
  )
    invalid()
  for (const table of brc38NativeLocalBaselineTables) {
    const found = (await k('sqlite_schema').where({ type: 'table', name: table }).count({ count: '*' }).first()) as {
      count: number
    }
    if (found.count !== 1) invalid()
    // A true rowid index is required; WITHOUT ROWID tables cannot supply a
    // manufactured physical identity or an OFFSET fallback.
    await k(table).select(k.raw('rowid')).limit(1)
  }
  await k.raw('SAVEPOINT brc38_local_baseline_install')
  try {
    for (const sql of await brc38NativeLocalBaselineSourceDefinitions(k)) {
      actual(k, true)
      await k.raw(sql)
    }
    await k(clock).insert({
      slot: 1,
      protocol: 'brc38-local-baseline-journal/v3',
      epoch,
      revision: 0,
      ceiling,
      maximumRows,
      records: 0,
      enabled: 1,
      reason: null,
      bootstrapTable: 0,
      afterRowId: null,
      complete: 0
    })
    if (!(await hasBrc38NativeLocalBaselineGenerationSchema(k))) invalid()
    await k.raw('RELEASE brc38_local_baseline_install')
  } catch (cause) {
    try {
      await k.raw('ROLLBACK TO brc38_local_baseline_install')
      await k.raw('RELEASE brc38_local_baseline_install')
    } catch (error_) {
      throw new AggregateError([cause, error_], 'Local baseline installation retains actual rollback failure', {
        cause
      })
    }
    throw cause
  }
}
/** One short metadata bootstrap writer. Triggers are already active, so writes
 * below the cursor, deletes and physical key moves remain captured. Existing
 * event records win over bootstrap; a retry cannot replace a newer tombstone. */
export async function copyBrc38NativeLocalBaselineBootstrapPage(
  k: Knex.Transaction,
  maximumRows: number
): Promise<Readonly<Brc38NativeLocalBaselineGeneration>> {
  actual(k, true)
  if (!Number.isSafeInteger(maximumRows) || maximumRows < 1 || maximumRows > 128) invalid()
  // Acquire the genuine writer before selecting its cursor or source rows.
  if (
    (await k(clock)
      .where({ slot: 1 })
      .update({ revision: k.ref('revision') })) !== 1
  )
    invalid()
  const state = await readBrc38NativeLocalBaselineGeneration(k)
  if (!state.enabled) invalid()
  if (state.complete) return state
  const table = brc38NativeLocalBaselineTables[state.bootstrapTable],
    query = k(table).select(k.raw('CAST(rowid AS TEXT) AS rowId')).orderBy(`${table}.rowid`).limit(maximumRows)
  if (state.afterRowId !== null) query.where(`${table}.rowid`, '>', state.afterRowId)
  const page = (await query) as Array<{ rowId: string }>
  for (const [index, row] of page.entries()) {
    const rowId = Number(row.rowId)
    if (
      !Number.isSafeInteger(rowId) ||
      String(rowId) !== row.rowId ||
      (index === 0 ? state.afterRowId !== null && rowId <= state.afterRowId : rowId <= Number(page[index - 1].rowId))
    ) {
      await k(clock).where({ slot: 1 }).update({ enabled: 0, reason: 'key-out-of-range' })
      break
    }
    const key = { tableId: state.bootstrapTable, rowId },
      current = await k(rows).where(key).first('present')
    if (current !== undefined) continue
    const budget = (await k(clock).where({ slot: 1 }).first('records', 'maximumRows')) as {
      records: number
      maximumRows: number
    }
    if (budget.records >= budget.maximumRows) {
      await k(clock).where({ slot: 1 }).update({ enabled: 0, reason: 'capacity-exhausted' })
      break
    }
    await k(rows).insert({ ...key, revision: state.revision, generation: state.revision, present: 1 })
  }
  const current = await readBrc38NativeLocalBaselineGeneration(k)
  if (current.enabled)
    await k(clock)
      .where({ slot: 1 })
      .update(
        page.length === 0
          ? {
              bootstrapTable: state.bootstrapTable + 1,
              afterRowId: null,
              complete: state.bootstrapTable === tableCount - 1 ? 1 : 0
            }
          : { afterRowId: Number(page[page.length - 1].rowId) }
      )
  return await readBrc38NativeLocalBaselineGeneration(k)
}
export interface Brc38NativeLocalBaselineChange {
  readonly table: Brc38NativeLocalBaselineTable
  readonly tableId: number
  readonly rowId: number
  readonly revision: SnapshotJournalRevision
  readonly generation: SnapshotJournalRevision
  readonly present: boolean
}
export async function readBrc38NativeLocalBaselinePhysical(
  k: Knex.Transaction,
  table: Brc38NativeLocalBaselineTable,
  rowId: number
): Promise<Readonly<Brc38NativeLocalBaselineChange> | undefined> {
  const selected = table,
    physical = rowId,
    tableId = brc38NativeLocalBaselineTables.indexOf(selected)
  actual(k)
  if (tableId < 0 || !Number.isSafeInteger(physical)) invalid()
  const state = await readBrc38NativeLocalBaselineGeneration(k)
  if (!state.complete || !state.enabled) invalid()
  const values = (await k(rows)
    .where({ tableId, rowId: physical })
    .select('present', k.raw('CAST(revision AS TEXT) AS revision,CAST(generation AS TEXT) AS generation'))
    .limit(2)) as Array<{ present: number; revision: string; generation: string }>
  if (values.length > 1) invalid()
  if (values.length === 0) return undefined
  const value = values[0],
    revisionValue = snapshotJournalRevision(value.revision),
    generation = snapshotJournalRevision(value.generation)
  if (
    ![0, 1].includes(value.present) ||
    BigInt(revisionValue) > BigInt(state.revision) ||
    BigInt(generation) > BigInt(revisionValue)
  )
    invalid()
  actual(k)
  return Object.freeze({
    table: selected,
    tableId,
    rowId: physical,
    revision: revisionValue,
    generation,
    present: value.present === 1
  })
}
/** Metadata-only high-water interval, from the caller's actual coherent read
 * view. Mutations above the high-water remain for the next interval. Consumers
 * reread real row/field bytes and semantic parents; this is never a row effect,
 * reusable currentness verdict, primary grant or remote admission. */
export async function readBrc38NativeLocalBaselineChanges(
  k: Knex.Transaction,
  selected: Readonly<{
    epoch: string
    afterRevision: SnapshotJournalRevision
    highWater: SnapshotJournalRevision
    after?: Readonly<{ revision: SnapshotJournalRevision; tableId: number; rowId: number }>
    maximumRows: number
    presentOnly?: boolean
  }>
): Promise<readonly Readonly<Brc38NativeLocalBaselineChange>[]> {
  const epoch = selected.epoch,
    low = snapshotJournalRevision(selected.afterRevision),
    high = snapshotJournalRevision(selected.highWater),
    maximum = selected.maximumRows,
    presentOnly = selected.presentOnly ?? false,
    cursor =
      selected.after === undefined
        ? undefined
        : Object.freeze({ ...selected.after, revision: snapshotJournalRevision(selected.after.revision) })
  actual(k)
  const state = await readBrc38NativeLocalBaselineGeneration(k)
  if (
    !state.complete ||
    !state.enabled ||
    epoch !== state.epoch ||
    BigInt(low) > BigInt(high) ||
    high !== state.revision ||
    typeof presentOnly !== 'boolean' ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > 128 ||
    (cursor !== undefined &&
      (BigInt(cursor.revision) <= BigInt(low) ||
        BigInt(cursor.revision) > BigInt(high) ||
        !Number.isSafeInteger(cursor.tableId) ||
        cursor.tableId < 0 ||
        cursor.tableId >= tableCount ||
        !Number.isSafeInteger(cursor.rowId)))
  )
    invalid()
  const query = k
    .from(
      k.raw(
        `${rows} INDEXED BY ${presentOnly ? 'brc38_local_baseline_present_revision' : 'brc38_local_baseline_revision'}`
      )
    )
    .whereRaw('revision>CAST(? AS INTEGER) AND revision<=CAST(? AS INTEGER)', [low, high])
    .select(
      'tableId',
      'present',
      k.raw('CAST(rowId AS TEXT) AS rowId,CAST(revision AS TEXT) AS revision,CAST(generation AS TEXT) AS generation')
    )
    .orderBy(`${rows}.revision`)
    .orderBy(`${rows}.tableId`)
    .orderBy(`${rows}.rowId`)
    .limit(maximum)
  if (presentOnly) query.where({ present: 1 })
  if (cursor !== undefined)
    query.whereRaw(`(${rows}.revision,${rows}.tableId,${rows}.rowId)>(CAST(? AS INTEGER),?,?)`, [
      cursor.revision,
      cursor.tableId,
      cursor.rowId
    ])
  const values = (await query) as Array<{
    tableId: number
    rowId: string
    revision: string
    generation: string
    present: number
  }>
  if (values.length > maximum) invalid()
  const result = values.map((row, index) => {
    const rowId = Number(row.rowId),
      revisionValue = snapshotJournalRevision(row.revision),
      generation = snapshotJournalRevision(row.generation)
    if (
      !Number.isSafeInteger(row.tableId) ||
      row.tableId < 0 ||
      row.tableId >= tableCount ||
      !Number.isSafeInteger(rowId) ||
      String(rowId) !== row.rowId ||
      ![0, 1].includes(row.present) ||
      (presentOnly && row.present !== 1) ||
      BigInt(generation) > BigInt(revisionValue) ||
      BigInt(revisionValue) <= BigInt(low) ||
      BigInt(revisionValue) > BigInt(high)
    )
      invalid()
    const previous = index === 0 ? cursor : values[index - 1],
      previousRowId = previous === undefined ? undefined : Number(previous.rowId)
    if (
      previous !== undefined &&
      (BigInt(revisionValue) < BigInt(previous.revision) ||
        (revisionValue === previous.revision &&
          (row.tableId < previous.tableId || (row.tableId === previous.tableId && rowId <= previousRowId!))))
    )
      invalid()
    return Object.freeze({
      table: brc38NativeLocalBaselineTables[row.tableId],
      tableId: row.tableId,
      rowId,
      revision: revisionValue,
      generation,
      present: row.present === 1
    })
  })
  actual(k)
  return Object.freeze(result)
}

/** Second reconciliation pass: latest tombstones in child-before-parent table
 * order. The source factory separately verifies the actual declared DAG. */
export async function readBrc38NativeLocalBaselineTombstones(
  k: Knex.Transaction,
  selected: Readonly<{
    epoch: string
    afterRevision: SnapshotJournalRevision
    highWater: SnapshotJournalRevision
    after?: Readonly<{ tableId: number; revision: SnapshotJournalRevision; rowId: number }>
    maximumRows: number
  }>
): Promise<readonly Readonly<Brc38NativeLocalBaselineChange>[]> {
  const epoch = selected.epoch,
    low = snapshotJournalRevision(selected.afterRevision),
    high = snapshotJournalRevision(selected.highWater),
    maximum = selected.maximumRows,
    cursor =
      selected.after === undefined
        ? undefined
        : Object.freeze({ ...selected.after, revision: snapshotJournalRevision(selected.after.revision) })
  actual(k)
  const state = await readBrc38NativeLocalBaselineGeneration(k)
  if (
    !state.complete ||
    !state.enabled ||
    epoch !== state.epoch ||
    high !== state.revision ||
    BigInt(low) > BigInt(high) ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > 128 ||
    (cursor !== undefined &&
      (!Number.isSafeInteger(cursor.tableId) ||
        cursor.tableId < 0 ||
        cursor.tableId >= tableCount ||
        !Number.isSafeInteger(cursor.rowId) ||
        BigInt(cursor.revision) <= BigInt(low) ||
        BigInt(cursor.revision) > BigInt(high)))
  )
    invalid()
  const result: Readonly<Brc38NativeLocalBaselineChange>[] = []
  // Fixed inventory-count indexed equality/range seeks. Old tombstones outside this
  // interval are never scanned merely to establish reverse table ordering.
  for (let tableId = cursor?.tableId ?? tableCount - 1; tableId >= 0 && result.length < maximum; tableId--) {
    const query = k
      .from(k.raw(`${rows} INDEXED BY brc38_local_baseline_deleted_order`))
      .where({ present: 0, tableId })
      .whereRaw('revision>CAST(? AS INTEGER) AND revision<=CAST(? AS INTEGER)', [low, high])
      .select(
        k.raw('CAST(rowId AS TEXT) AS rowId,CAST(revision AS TEXT) AS revision,CAST(generation AS TEXT) AS generation')
      )
      .orderBy(`${rows}.revision`)
      .orderBy(`${rows}.rowId`)
      .limit(maximum - result.length)
    if (cursor !== undefined && tableId === cursor.tableId)
      query.whereRaw(`(${rows}.revision,${rows}.rowId)>(CAST(? AS INTEGER),?)`, [cursor.revision, cursor.rowId])
    const values = (await query) as Array<{ rowId: string; revision: string; generation: string }>
    for (const row of values) {
      const rowId = Number(row.rowId),
        revision = snapshotJournalRevision(row.revision),
        generation = snapshotJournalRevision(row.generation),
        previous = result.length === 0 ? cursor : result[result.length - 1]
      if (
        result.length >= maximum ||
        !Number.isSafeInteger(rowId) ||
        String(rowId) !== row.rowId ||
        BigInt(revision) <= BigInt(low) ||
        BigInt(revision) > BigInt(high) ||
        BigInt(generation) > BigInt(revision) ||
        (previous !== undefined &&
          (tableId > previous.tableId ||
            (tableId === previous.tableId &&
              (BigInt(revision) < BigInt(previous.revision) ||
                (revision === previous.revision && rowId <= Number(previous.rowId))))))
      )
        invalid()
      result.push(
        Object.freeze({
          table: brc38NativeLocalBaselineTables[tableId],
          tableId,
          rowId,
          revision,
          generation,
          present: false
        })
      )
    }
    actual(k)
  }
  return Object.freeze(result)
}

interface Recovery {
  oldEpoch: string
  newEpoch: string
  maximumRows: number
  ceiling: SnapshotJournalRevision
  phase: 'DRAINING' | 'READY' | 'COMPLETE'
}
async function hasRecoverySchema(k: Knex.Transaction): Promise<boolean> {
  actual(k)
  const total = (await k('sqlite_schema')
    .whereRaw('substr(name,1,?)=?', [recoveryTable.length, recoveryTable])
    .count({ count: '*' })
    .first()) as { count: unknown } | undefined
  if (total?.count === 0) return false
  if (total?.count !== recoveryDefinitions.length) invalid()
  for (const sql of recoveryDefinitions) {
    const match = /^CREATE (TABLE|TRIGGER) ([A-Za-z0-9_]+)/.exec(sql)!
    const value = (await k('sqlite_schema')
      .where({ type: match[1].toLowerCase(), name: match[2] })
      .whereRaw('CAST(sql AS BLOB)=CAST(? AS BLOB)', [sql])
      .count({ count: '*' })
      .first()) as { count: unknown } | undefined
    if (value?.count !== 1) invalid()
  }
  actual(k)
  return true
}
async function recovery(k: Knex.Transaction): Promise<Readonly<Recovery> | undefined> {
  if (!(await hasRecoverySchema(k))) return undefined
  const values = (await k(recoveryTable)
    .where({ slot: 1 })
    .select('protocol', 'oldEpoch', 'newEpoch', 'maximumRows', 'phase', k.raw('CAST(ceiling AS TEXT) AS ceiling'))
    .limit(2)) as Array<Record<string, unknown>>
  if (values.length === 0) return undefined
  if (values.length !== 1) invalid()
  const row = values[0],
    uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
  if (
    row.protocol !== 'brc38-local-epoch-recovery/v1' ||
    typeof row.oldEpoch !== 'string' ||
    !uuid.test(row.oldEpoch) ||
    typeof row.newEpoch !== 'string' ||
    !uuid.test(row.newEpoch) ||
    row.oldEpoch === row.newEpoch ||
    typeof row.maximumRows !== 'number' ||
    !Number.isSafeInteger(row.maximumRows) ||
    row.maximumRows < 1 ||
    row.maximumRows > 10000000 ||
    !['DRAINING', 'READY', 'COMPLETE'].includes(String(row.phase))
  )
    invalid()
  const ceiling = snapshotJournalRevision(row.ceiling)
  if (ceiling === '0') invalid()
  return Object.freeze({
    oldEpoch: row.oldEpoch,
    newEpoch: row.newEpoch,
    maximumRows: row.maximumRows,
    ceiling,
    phase: row.phase as Recovery['phase']
  })
}
/** Explicit recovery entry after NEW source/primary/resources admission by the
 * caller. It cannot renew an old source actor or salvage an old candidate:
 * every candidate bound to oldEpoch must refuse and restart its baseline. */
export async function beginBrc38NativeLocalBaselineEpochRecovery(
  k: Knex.Transaction,
  selected: Readonly<{ expectedEpoch: string; maximumRows: number; ceiling: SnapshotJournalRevision }>
): Promise<Readonly<Recovery>> {
  const expectedEpoch = selected.expectedEpoch,
    maximumRows = selected.maximumRows,
    ceiling = snapshotJournalRevision(selected.ceiling)
  actual(k, true)
  if (!Number.isSafeInteger(maximumRows) || maximumRows < 1 || maximumRows > 10000000 || ceiling === '0') invalid()
  const current = await readBrc38NativeLocalBaselineGeneration(k)
  if (current.enabled || current.epoch !== expectedEpoch) invalid()
  await k.raw('SAVEPOINT __brc38_local_epoch_recovery')
  try {
    if (!(await hasRecoverySchema(k))) {
      // Only two original guards change; all operational observers stay active.
      // The source remains disabled until finite retirement and explicit reset.
      for (const sql of recoveryDefinitions) {
        actual(k, true)
        await k.raw(sql)
      }
      for (const sql of brc38NativeLocalEpochRecoverySourceDefinitions(definitions)) {
        if (
          sql.startsWith('CREATE TRIGGER brc38_local_baseline_clock_update_guard ') ||
          sql.startsWith('CREATE TRIGGER brc38_local_baseline_rows_delete_guard ')
        ) {
          const name = /^CREATE TRIGGER ([A-Za-z0-9_]+)/.exec(sql)![1]
          await k.raw('DROP TRIGGER ??', [name])
          await k.raw(sql)
        } else if (sql.startsWith('CREATE TRIGGER brc38_local_baseline_rows_delete_charge ')) await k.raw(sql)
      }
    }
    const prior = await recovery(k)
    if (prior !== undefined && prior.phase !== 'COMPLETE') {
      if (prior.oldEpoch !== expectedEpoch || prior.maximumRows !== maximumRows || prior.ceiling !== ceiling) invalid()
      await k.raw('RELEASE __brc38_local_epoch_recovery')
      return prior
    }
    if (prior !== undefined) {
      if (
        prior.newEpoch !== expectedEpoch ||
        (await k(recoveryTable).where({ slot: 1, phase: 'COMPLETE' }).delete()) !== 1
      )
        invalid()
    }
    const next = Object.freeze({
      oldEpoch: expectedEpoch,
      newEpoch: randomUUID(),
      maximumRows,
      ceiling,
      phase: 'DRAINING' as const
    })
    await k(recoveryTable).insert({ slot: 1, protocol: 'brc38-local-epoch-recovery/v1', ...next })
    if (
      !(await hasBrc38NativeLocalBaselineGenerationSchema(k)) ||
      JSON.stringify(await recovery(k)) !== JSON.stringify(next)
    )
      invalid()
    actual(k, true)
    await k.raw('RELEASE __brc38_local_epoch_recovery')
    return next
  } catch (cause) {
    try {
      await k.raw('ROLLBACK TO __brc38_local_epoch_recovery')
      await k.raw('RELEASE __brc38_local_epoch_recovery')
    } catch (error_) {
      throw new AggregateError([cause, error_], 'Local epoch recovery entry retains actual rollback failure', {
        cause
      })
    }
    throw cause
  }
}
/** Retire at most128 old metadata points per transaction. Ordinary source
 * application writes continue; none of this disabled epoch admits capture.
 * A persisted READY receipt makes a lost acknowledgement safely repeatable. */
export async function retireBrc38NativeLocalBaselineEpochPage(
  k: Knex.Transaction,
  expectedEpoch: string,
  maximumRows: number
): Promise<Readonly<{ remaining: number; ready: boolean; newEpoch: string }>> {
  actual(k, true)
  if (!Number.isSafeInteger(maximumRows) || maximumRows < 1 || maximumRows > 128) invalid()
  const state = await readBrc38NativeLocalBaselineGeneration(k),
    pending = await recovery(k)
  if (
    state.enabled ||
    state.epoch !== expectedEpoch ||
    pending?.oldEpoch !== expectedEpoch ||
    pending.phase === 'COMPLETE'
  )
    invalid()
  await k.raw('SAVEPOINT __brc38_local_epoch_retire')
  try {
    const page = (await k(rows)
      .select('tableId', 'rowId')
      .orderBy('tableId')
      .orderBy('rowId')
      .limit(maximumRows)) as Array<{ tableId: number; rowId: number }>
    if (pending.phase === 'READY' && (page.length !== 0 || state.records !== 0)) invalid()
    for (const point of page) {
      actual(k, true)
      if (
        !Number.isSafeInteger(point.tableId) ||
        point.tableId < 0 ||
        point.tableId >= tableCount ||
        !Number.isSafeInteger(point.rowId) ||
        (await k(rows).where(point).delete()) !== 1
      )
        invalid()
    }
    const after = await readBrc38NativeLocalBaselineGeneration(k)
    if (after.records !== state.records - page.length) invalid()
    const empty = (await k(rows).select('tableId').limit(1)).length === 0
    if (empty !== (after.records === 0)) invalid()
    if (
      empty &&
      pending.phase === 'DRAINING' &&
      (await k(recoveryTable).where({ slot: 1, phase: 'DRAINING' }).update({ phase: 'READY' })) !== 1
    )
      invalid()
    actual(k, true)
    await k.raw('RELEASE __brc38_local_epoch_retire')
    return Object.freeze({ remaining: after.records, ready: empty, newEpoch: pending.newEpoch })
  } catch (cause) {
    try {
      await k.raw('ROLLBACK TO __brc38_local_epoch_retire')
      await k.raw('RELEASE __brc38_local_epoch_retire')
    } catch (error_) {
      throw new AggregateError([cause, error_], 'Local epoch retirement retains actual rollback failure', { cause })
    }
    throw cause
  }
}
/** Exact finite reset after retirement. Existing unsafe physical keys refuse
 * activation using each table's rowid index. The NEW epoch then requires the
 * ordinary bounded all48 bootstrap with observers active before capture. */
export async function activateBrc38NativeLocalBaselineRecoveredEpoch(
  k: Knex.Transaction,
  expectedEpoch: string
): Promise<Readonly<Brc38NativeLocalBaselineGeneration>> {
  actual(k, true)
  const pending = await recovery(k),
    state = await readBrc38NativeLocalBaselineGeneration(k)
  if (pending?.oldEpoch !== expectedEpoch) invalid()
  if (pending.phase === 'COMPLETE') {
    if (state.epoch !== pending.newEpoch) invalid()
    return state
  }
  if (
    pending.phase !== 'READY' ||
    state.enabled ||
    state.epoch !== expectedEpoch ||
    state.records !== 0 ||
    (await k(rows).select('tableId').limit(1)).length !== 0
  )
    invalid()
  for (const table of brc38NativeLocalBaselineTables)
    for (const [operator, bound] of [
      ['<', -9007199254740991],
      ['>', 9007199254740991]
    ] as const) {
      actual(k, true)
      if ((await k(table).where('rowid', operator, bound).select(k.raw('rowid')).limit(1)).length !== 0) invalid()
    }
  await k.raw('SAVEPOINT __brc38_local_epoch_activate')
  try {
    if (
      (await k(clock).where({ slot: 1, epoch: expectedEpoch, enabled: 0, records: 0 }).update({
        epoch: pending.newEpoch,
        revision: 0,
        ceiling: pending.ceiling,
        maximumRows: pending.maximumRows,
        enabled: 1,
        reason: null,
        records: 0,
        complete: 0,
        bootstrapTable: 0,
        afterRowId: null
      })) !== 1 ||
      (await k(recoveryTable).where({ slot: 1, phase: 'READY' }).update({ phase: 'COMPLETE' })) !== 1
    )
      invalid()
    const next = await readBrc38NativeLocalBaselineGeneration(k)
    if (
      !next.enabled ||
      next.complete ||
      next.epoch !== pending.newEpoch ||
      next.revision !== '0' ||
      next.records !== 0
    )
      invalid()
    actual(k, true)
    await k.raw('RELEASE __brc38_local_epoch_activate')
    return next
  } catch (cause) {
    try {
      await k.raw('ROLLBACK TO __brc38_local_epoch_activate')
      await k.raw('RELEASE __brc38_local_epoch_activate')
    } catch (error_) {
      throw new AggregateError([cause, error_], 'Local epoch activation retains actual rollback failure', { cause })
    }
    throw cause
  }
}
