import type { Knex } from 'knex'
import { isBrc38OwnedPrivateNativeSqlite, isBrc38OwnedPrivateNativeWriter } from './KnexBrc38StagingStore'
import {
  brc38NativeLocalBaselineTables,
  brc38NativeLocalBaselineTableCount as tableCount
} from './Brc38NativeLocalBaselineTables'
import { snapshotJournalRevision, type SnapshotJournalRevision } from '../snapshot/journal/SnapshotJournalRevision'

export const brc38PrivateLocalCandidateStateTable = 'brc38_private_local_candidate_state'
export const brc38PrivateLocalCandidatePointTable = 'brc38_private_local_candidate_points'
const state = brc38PrivateLocalCandidateStateTable,
  points = brc38PrivateLocalCandidatePointTable,
  prefix = 'brc38_private_local_candidate_',
  safe = '9007199254740991'
const emptyTable = (id: number): string =>
  `NOT EXISTS(SELECT 1 FROM ${brc38NativeLocalBaselineTables[id]} LIMIT 1) AND NOT EXISTS(SELECT 1 FROM ${points} WHERE tableId=${id} LIMIT 1)`
const allEmpty = brc38NativeLocalBaselineTables.map((_, id) => `(${emptyTable(id)})`).join(' AND ')
const clearAdvance = brc38NativeLocalBaselineTables
  .map((_, id) => `(OLD.clearTable=${id} AND ${emptyTable(id)})`)
  .join(' OR ')
const definitions = Object.freeze([
  `CREATE TABLE ${state}(slot INTEGER PRIMARY KEY CHECK(slot=1),protocol TEXT NOT NULL CHECK(protocol='brc38-private-local-candidate/v3'),bindingSha256 TEXT NOT NULL CHECK(length(bindingSha256)=64 AND bindingSha256 NOT GLOB '*[^0-9a-f]*'),sourceSha256 TEXT NOT NULL CHECK(length(sourceSha256)=64 AND sourceSha256 NOT GLOB '*[^0-9a-f]*'),epoch TEXT NOT NULL CHECK(length(CAST(epoch AS BLOB))=36),baseRevision INTEGER NOT NULL CHECK(typeof(baseRevision)='integer' AND baseRevision>=0),caughtUpRevision INTEGER NOT NULL CHECK(typeof(caughtUpRevision)='integer' AND caughtUpRevision>=baseRevision),maximumRows INTEGER NOT NULL CHECK(typeof(maximumRows)='integer' AND maximumRows BETWEEN 1 AND 10000000),records INTEGER NOT NULL CHECK(typeof(records)='integer' AND records BETWEEN 0 AND maximumRows),phase TEXT NOT NULL CHECK(phase IN ('COPY','DELTA','RECOVERY','CLEAR')),rebuilds INTEGER NOT NULL CHECK(typeof(rebuilds)='integer' AND rebuilds BETWEEN 0 AND 3),clearTable INTEGER CHECK(clearTable IS NULL OR (typeof(clearTable)='integer' AND clearTable BETWEEN -1 AND ${tableCount - 1})),copyTable INTEGER NOT NULL CHECK(typeof(copyTable)='integer' AND copyTable BETWEEN 0 AND ${tableCount}),afterRowId INTEGER CHECK(afterRowId IS NULL OR (typeof(afterRowId)='integer' AND afterRowId BETWEEN -${safe} AND ${safe})),deltaPass TEXT CHECK(deltaPass IS NULL OR deltaPass IN ('PRESENT','TOMBSTONE')),deltaHighWater INTEGER CHECK(deltaHighWater IS NULL OR (typeof(deltaHighWater)='integer' AND deltaHighWater>=caughtUpRevision)),deltaRevision INTEGER CHECK(deltaRevision IS NULL OR (typeof(deltaRevision)='integer' AND deltaRevision>caughtUpRevision AND deltaRevision<=deltaHighWater)),deltaTable INTEGER CHECK(deltaTable IS NULL OR (typeof(deltaTable)='integer' AND deltaTable BETWEEN 0 AND ${tableCount - 1})),deltaRowId INTEGER CHECK(deltaRowId IS NULL OR (typeof(deltaRowId)='integer' AND deltaRowId BETWEEN -${safe} AND ${safe})),lastOperationSha256 TEXT CHECK(lastOperationSha256 IS NULL OR (length(lastOperationSha256)=64 AND lastOperationSha256 NOT GLOB '*[^0-9a-f]*')),CHECK((deltaTable IS NULL AND deltaRowId IS NULL AND deltaRevision IS NULL) OR (deltaTable IS NOT NULL AND deltaRowId IS NOT NULL AND deltaRevision IS NOT NULL)),CHECK((phase='CLEAR' AND clearTable IS NOT NULL AND deltaPass IS NULL AND deltaHighWater IS NULL AND deltaRevision IS NULL) OR (phase!='CLEAR' AND clearTable IS NULL AND ((phase='COPY' AND copyTable<${tableCount} AND deltaPass IS NULL AND deltaHighWater IS NULL AND deltaRevision IS NULL) OR (phase='DELTA' AND copyTable=${tableCount} AND afterRowId IS NULL AND ((deltaPass IS NULL AND deltaHighWater IS NULL AND deltaTable IS NULL) OR (deltaPass IS NOT NULL AND deltaHighWater IS NOT NULL))) OR (phase='RECOVERY' AND copyTable=${tableCount} AND afterRowId IS NULL AND deltaPass IS NULL AND deltaHighWater IS NULL AND deltaRevision IS NULL)))))`,
  `CREATE TABLE ${points}(tableId INTEGER NOT NULL CHECK(typeof(tableId)='integer' AND tableId BETWEEN 0 AND ${tableCount - 1}),rowId INTEGER NOT NULL CHECK(typeof(rowId)='integer' AND rowId BETWEEN -${safe} AND ${safe}),revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=0),generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation BETWEEN 0 AND revision),present INTEGER NOT NULL CHECK(present IN (0,1)),contentSha256 TEXT CHECK((present=0 AND contentSha256 IS NULL) OR (present=1 AND contentSha256 IS NOT NULL AND typeof(contentSha256)='text' AND length(contentSha256)=64 AND contentSha256 NOT GLOB '*[^0-9a-f]*')),PRIMARY KEY(tableId,rowId))`,
  `CREATE TRIGGER ${state}_delete BEFORE DELETE ON ${state} BEGIN SELECT RAISE(ABORT,'Private local candidate requires owned retirement'); END`,
  `CREATE TRIGGER ${state}_update BEFORE UPDATE ON ${state} WHEN NEW.slot IS NOT OLD.slot OR NEW.protocol IS NOT OLD.protocol OR NEW.bindingSha256 IS NOT OLD.bindingSha256 OR NEW.sourceSha256 IS NOT OLD.sourceSha256 OR NEW.epoch IS NOT OLD.epoch OR NEW.baseRevision IS NOT OLD.baseRevision OR NEW.maximumRows IS NOT OLD.maximumRows OR NEW.caughtUpRevision<OLD.caughtUpRevision OR (OLD.phase!='CLEAR' AND NEW.phase!='CLEAR' AND (NEW.records<OLD.records OR NEW.rebuilds!=OLD.rebuilds OR NEW.copyTable<OLD.copyTable OR NEW.copyTable>OLD.copyTable+1 OR (NEW.copyTable=OLD.copyTable AND OLD.afterRowId IS NOT NULL AND (NEW.afterRowId IS NULL OR NEW.afterRowId<OLD.afterRowId)) OR (NEW.copyTable!=OLD.copyTable AND NEW.afterRowId IS NOT NULL) OR (OLD.phase='COPY' AND NEW.phase='RECOVERY') OR (OLD.phase='DELTA' AND NEW.phase='COPY') OR (OLD.phase='RECOVERY' AND NEW.phase!='RECOVERY' AND NOT (NEW.phase='DELTA' AND NEW.deltaPass='PRESENT' AND NEW.deltaHighWater>OLD.caughtUpRevision AND NEW.deltaTable IS NULL AND NEW.deltaRevision IS NULL)) OR (NEW.caughtUpRevision!=OLD.caughtUpRevision AND NOT (OLD.phase='DELTA' AND OLD.deltaPass='TOMBSTONE' AND NEW.phase='RECOVERY' AND NEW.caughtUpRevision=OLD.deltaHighWater)) OR (OLD.phase='DELTA' AND NEW.phase='RECOVERY' AND NOT (OLD.deltaPass='TOMBSTONE' AND NEW.caughtUpRevision=OLD.deltaHighWater)) OR (OLD.deltaHighWater IS NOT NULL AND NEW.phase='DELTA' AND (NEW.deltaHighWater IS NULL OR NEW.deltaHighWater<OLD.deltaHighWater)) OR (OLD.deltaHighWater IS NOT NULL AND NEW.deltaHighWater>OLD.deltaHighWater AND (NEW.deltaPass!='PRESENT' OR NEW.deltaTable IS NOT NULL OR NEW.deltaRevision IS NOT NULL)) OR (OLD.deltaHighWater IS NULL AND NEW.deltaHighWater IS NOT NULL AND NEW.deltaPass!='PRESENT') OR (NEW.deltaHighWater=OLD.deltaHighWater AND OLD.deltaPass='PRESENT' AND NEW.deltaPass='TOMBSTONE' AND NEW.deltaTable IS NOT NULL) OR (NEW.deltaHighWater=OLD.deltaHighWater AND OLD.deltaPass='TOMBSTONE' AND NEW.deltaPass!='TOMBSTONE') OR (NEW.deltaHighWater=OLD.deltaHighWater AND NEW.deltaPass=OLD.deltaPass AND OLD.deltaTable IS NOT NULL AND (NEW.deltaTable IS NULL OR (OLD.deltaPass='PRESENT' AND (NEW.deltaRevision<OLD.deltaRevision OR (NEW.deltaRevision=OLD.deltaRevision AND (NEW.deltaTable<OLD.deltaTable OR (NEW.deltaTable=OLD.deltaTable AND NEW.deltaRowId<OLD.deltaRowId))))) OR (OLD.deltaPass='TOMBSTONE' AND (NEW.deltaTable>OLD.deltaTable OR (NEW.deltaTable=OLD.deltaTable AND (NEW.deltaRevision<OLD.deltaRevision OR (NEW.deltaRevision=OLD.deltaRevision AND NEW.deltaRowId<OLD.deltaRowId))))))))) OR (OLD.phase!='CLEAR' AND NEW.phase='CLEAR' AND (NEW.rebuilds!=OLD.rebuilds+1 OR NEW.clearTable!=${tableCount - 1} OR NEW.records!=OLD.records OR NEW.copyTable!=OLD.copyTable OR NEW.afterRowId IS NOT OLD.afterRowId OR NEW.caughtUpRevision!=OLD.caughtUpRevision)) OR (OLD.phase='CLEAR' AND NEW.phase='CLEAR' AND (NEW.rebuilds!=OLD.rebuilds OR NEW.copyTable!=OLD.copyTable OR NEW.afterRowId IS NOT OLD.afterRowId OR NEW.caughtUpRevision!=OLD.caughtUpRevision OR NEW.records>OLD.records OR NEW.records<OLD.records-1 OR NOT (NEW.clearTable=OLD.clearTable OR (NEW.clearTable=OLD.clearTable-1 AND (${clearAdvance}))))) OR (OLD.phase='CLEAR' AND NEW.phase!='CLEAR' AND NOT (NEW.phase='COPY' AND OLD.clearTable=-1 AND OLD.records=0 AND NEW.records=0 AND NEW.rebuilds=OLD.rebuilds AND NEW.copyTable=0 AND NEW.afterRowId IS NULL AND NEW.caughtUpRevision=OLD.caughtUpRevision AND ${allEmpty})) BEGIN SELECT RAISE(ABORT,'Private local candidate original binding or progress differs'); END`,
  `CREATE TRIGGER ${points}_insert_guard BEFORE INSERT ON ${points} WHEN NOT EXISTS(SELECT 1 FROM ${state} WHERE slot=1 AND phase IN ('COPY','DELTA') AND records<maximumRows) BEGIN SELECT RAISE(ABORT,'Private local candidate original point reservation differs'); END`,
  `CREATE TRIGGER ${points}_insert_charge AFTER INSERT ON ${points} BEGIN UPDATE ${state} SET records=records+1 WHERE slot=1; END`,
  `CREATE TRIGGER ${points}_update BEFORE UPDATE ON ${points} WHEN NEW.tableId IS NOT OLD.tableId OR NEW.rowId IS NOT OLD.rowId OR NEW.revision<OLD.revision OR NEW.generation<OLD.generation OR (NEW.generation!=OLD.generation AND NEW.generation<=OLD.revision) OR (OLD.present=0 AND NEW.present=1 AND NEW.generation=OLD.generation) OR NOT EXISTS(SELECT 1 FROM ${state} WHERE slot=1 AND phase IN ('COPY','DELTA')) BEGIN SELECT RAISE(ABORT,'Private local candidate point generation differs'); END`,
  `CREATE TRIGGER ${points}_delete BEFORE DELETE ON ${points} WHEN NOT EXISTS(SELECT 1 FROM ${state} WHERE slot=1 AND phase='CLEAR' AND clearTable=OLD.tableId AND records>0) BEGIN SELECT RAISE(ABORT,'Private local candidate points remain owned'); END`,
  `CREATE TRIGGER ${points}_delete_charge AFTER DELETE ON ${points} BEGIN UPDATE ${state} SET records=records-1 WHERE slot=1; END`
])
/** Optional prior-import extension owned by the candidate point table. Its
 * exact source definition is shared with the installer; the journal accepts
 * neither a same-name replacement nor any unrelated attached object. */
export const brc38PrivateLocalCandidatePriorPointGuard = Object.freeze({
  name: 'brc38_local_prior_import_point_guard',
  sql: `CREATE TRIGGER brc38_local_prior_import_point_guard BEFORE INSERT ON ${points} WHEN EXISTS(SELECT 1 FROM brc38_local_prior_import_budget b JOIN ${state} c ON c.slot=1 WHERE b.slot=1 AND b.records+c.records>=b.maximumRows) BEGIN SELECT RAISE(ABORT,'Combined prior and local candidate row quota exhausted'); END`
})
function invalid(): never {
  throw new Error('Private local candidate journal differs from its actual owner, exact schema or original progress')
}
function actual(k: Knex.Transaction, write = false): void {
  if (
    k.isTransaction !== true ||
    k.isCompleted() ||
    !(write ? isBrc38OwnedPrivateNativeWriter(k) : isBrc38OwnedPrivateNativeSqlite(k))
  )
    invalid()
}
export interface Brc38PrivateLocalCandidateJournal {
  readonly bindingSha256: string
  readonly sourceSha256: string
  readonly epoch: string
  readonly baseRevision: SnapshotJournalRevision
  readonly caughtUpRevision: SnapshotJournalRevision
  readonly maximumRows: number
  readonly records: number
  readonly phase: 'COPY' | 'DELTA' | 'RECOVERY' | 'CLEAR'
  readonly rebuilds: number
  readonly clearTable: number | null
  readonly copyTable: number
  readonly afterRowId: number | null
  readonly deltaPass: 'PRESENT' | 'TOMBSTONE' | null
  readonly deltaHighWater: SnapshotJournalRevision | null
  readonly deltaRevision: SnapshotJournalRevision | null
  readonly deltaTable: number | null
  readonly deltaRowId: number | null
  readonly lastOperationSha256: string | null
}
/** Exact fresh physical schema only. This grants no current source, profile,
 * primary or semantic admission. All progress and SHA fields are DATA. */
export async function hasBrc38PrivateLocalCandidateJournal(k: Knex.Transaction): Promise<boolean> {
  actual(k)
  const total = (await k('sqlite_schema')
    .where(query => {
      void query.whereRaw('substr(name,1,?)=?', [prefix.length, prefix]).orWhereIn('tbl_name', [state, points])
    })
    .whereNot(query => {
      void query
        .where({ type: 'trigger', name: brc38PrivateLocalCandidatePriorPointGuard.name, tbl_name: points })
        .whereNotNull('sql')
        .whereRaw('CAST(sql AS BLOB)=CAST(? AS BLOB)', [brc38PrivateLocalCandidatePriorPointGuard.sql])
    })
    .count({ count: '*' })
    .first()) as { count: unknown } | undefined
  if (total?.count === 0) return false
  // Count all attached objects except the exact optional prior-import guard.
  // Nine base definitions and the implicit point index account for all ten.
  if (total?.count !== definitions.length + 1) invalid()
  // All nine fixed definitions fit the original native frame floor together.
  // Compare exact bytes freshly in this view; retain both counts so duplicate
  // names cannot replace an absent original definition. No verdict is cached.
  const current = (await k('sqlite_schema')
    .where(query => {
      for (const sql of definitions) {
        const match = /^CREATE (TABLE|TRIGGER) ([A-Za-z0-9_]+)/.exec(sql)!
        void query.orWhere(part => {
          void part
            .where({ type: match[1].toLowerCase(), name: match[2] })
            .whereRaw('CAST(sql AS BLOB)=CAST(? AS BLOB)', [sql])
        })
      }
    })
    .count({ count: '*' })
    .countDistinct({ names: 'name' })
    .first()) as { count: unknown; names: unknown } | undefined
  if (current?.count !== definitions.length || current.names !== definitions.length) invalid()
  const indexes = (await k('sqlite_schema')
    .where({ tbl_name: points, type: 'index' })
    .select('name', 'sql')
    .limit(2)) as Array<{ name: string; sql: unknown }>
  if (indexes.length !== 1 || indexes[0].name !== `sqlite_autoindex_${points}_1` || indexes[0].sql !== null) invalid()
  actual(k)
  return true
}
export async function readBrc38PrivateLocalCandidateJournal(
  k: Knex.Transaction
): Promise<Readonly<Brc38PrivateLocalCandidateJournal>> {
  if (!(await hasBrc38PrivateLocalCandidateJournal(k))) invalid()
  const rows = (await k(state)
    .where({ slot: 1 })
    .select(
      'protocol',
      'bindingSha256',
      'sourceSha256',
      'epoch',
      'maximumRows',
      'records',
      'phase',
      'rebuilds',
      'clearTable',
      'copyTable',
      'afterRowId',
      'deltaPass',
      'deltaTable',
      'deltaRowId',
      'lastOperationSha256',
      k.raw(
        'CAST(baseRevision AS TEXT) AS baseRevision,CAST(caughtUpRevision AS TEXT) AS caughtUpRevision,CAST(deltaHighWater AS TEXT) AS deltaHighWater,CAST(deltaRevision AS TEXT) AS deltaRevision'
      )
    )
    .limit(2)) as Array<Record<string, unknown>>
  if (rows.length !== 1) invalid()
  const row = rows[0],
    hash = /^[0-9a-f]{64}$/,
    uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,
    integer = (value: unknown, minimum: number, maximum: number): number => {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid()
      return value
    },
    optionalKey = (value: unknown): number | null =>
      value === null ? null : integer(value, -9007199254740991, 9007199254740991)
  if (
    row.protocol !== 'brc38-private-local-candidate/v3' ||
    typeof row.bindingSha256 !== 'string' ||
    !hash.test(row.bindingSha256) ||
    typeof row.sourceSha256 !== 'string' ||
    !hash.test(row.sourceSha256) ||
    typeof row.epoch !== 'string' ||
    !uuid.test(row.epoch) ||
    !['COPY', 'DELTA', 'RECOVERY', 'CLEAR'].includes(String(row.phase)) ||
    (row.deltaPass !== null && !['PRESENT', 'TOMBSTONE'].includes(String(row.deltaPass))) ||
    (row.lastOperationSha256 !== null &&
      (typeof row.lastOperationSha256 !== 'string' || !hash.test(row.lastOperationSha256)))
  )
    invalid()
  const baseRevision = snapshotJournalRevision(row.baseRevision),
    caughtUpRevision = snapshotJournalRevision(row.caughtUpRevision),
    deltaHighWater = row.deltaHighWater === null ? null : snapshotJournalRevision(row.deltaHighWater),
    deltaRevision = row.deltaRevision === null ? null : snapshotJournalRevision(row.deltaRevision),
    maximumRows = integer(row.maximumRows, 1, 10000000),
    records = integer(row.records, 0, maximumRows),
    copyTable = integer(row.copyTable, 0, tableCount),
    rebuilds = integer(row.rebuilds, 0, 3),
    clearTable = row.clearTable === null ? null : integer(row.clearTable, -1, tableCount - 1),
    afterRowId = optionalKey(row.afterRowId),
    deltaRowId = optionalKey(row.deltaRowId),
    deltaTable = row.deltaTable === null ? null : integer(row.deltaTable, 0, tableCount - 1)
  if (
    BigInt(caughtUpRevision) < BigInt(baseRevision) ||
    (deltaHighWater !== null && BigInt(deltaHighWater) < BigInt(caughtUpRevision)) ||
    (deltaRevision !== null &&
      (deltaHighWater === null ||
        BigInt(deltaRevision) <= BigInt(caughtUpRevision) ||
        BigInt(deltaRevision) > BigInt(deltaHighWater))) ||
    (deltaTable === null) !== (deltaRowId === null) ||
    (deltaTable === null) !== (deltaRevision === null) ||
    (row.deltaPass === null) !== (deltaHighWater === null) ||
    (row.phase !== 'DELTA' && row.deltaPass !== null) ||
    (row.phase === 'CLEAR') !== (clearTable !== null) ||
    (row.phase !== 'CLEAR' &&
      (row.phase === 'COPY'
        ? copyTable >= tableCount || deltaHighWater !== null
        : copyTable !== tableCount || afterRowId !== null))
  )
    invalid()
  actual(k)
  return Object.freeze({
    bindingSha256: row.bindingSha256,
    sourceSha256: row.sourceSha256,
    epoch: row.epoch,
    baseRevision,
    caughtUpRevision,
    maximumRows,
    records,
    phase: row.phase as Brc38PrivateLocalCandidateJournal['phase'],
    rebuilds,
    clearTable,
    copyTable,
    afterRowId,
    deltaPass: row.deltaPass as Brc38PrivateLocalCandidateJournal['deltaPass'],
    deltaHighWater,
    deltaRevision,
    deltaTable,
    deltaRowId,
    lastOperationSha256: row.lastOperationSha256 as string | null
  })
}
/** Low-level explicit fresh journal installation. The controller supplies
 * authenticated binding and independently admitted actual source fence DATA.
 * It MUST make point effects and progress atomic in its owned final writer. */
export async function installBrc38PrivateLocalCandidateJournal(
  k: Knex.Transaction,
  selected: Readonly<{
    bindingSha256: string
    sourceSha256: string
    epoch: string
    revision: SnapshotJournalRevision
    maximumRows: number
  }>
): Promise<void> {
  const input = Object.freeze({ ...selected, revision: snapshotJournalRevision(selected.revision) })
  actual(k, true)
  if (
    typeof input.bindingSha256 !== 'string' ||
    typeof input.sourceSha256 !== 'string' ||
    typeof input.epoch !== 'string' ||
    !/^[0-9a-f]{64}$/.test(input.bindingSha256) ||
    !/^[0-9a-f]{64}$/.test(input.sourceSha256) ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(input.epoch) ||
    !Number.isSafeInteger(input.maximumRows) ||
    input.maximumRows < 1 ||
    input.maximumRows > 10000000 ||
    (await hasBrc38PrivateLocalCandidateJournal(k))
  )
    invalid()
  await k.raw('SAVEPOINT __brc38_local_candidate_journal')
  try {
    for (const sql of definitions) {
      actual(k, true)
      await k.raw(sql)
    }
    await k(state).insert({
      slot: 1,
      protocol: 'brc38-private-local-candidate/v3',
      bindingSha256: input.bindingSha256,
      sourceSha256: input.sourceSha256,
      epoch: input.epoch,
      baseRevision: input.revision,
      caughtUpRevision: input.revision,
      maximumRows: input.maximumRows,
      records: 0,
      phase: 'COPY',
      rebuilds: 0,
      clearTable: null,
      copyTable: 0,
      afterRowId: null,
      deltaPass: null,
      deltaHighWater: null,
      deltaRevision: null,
      deltaTable: null,
      deltaRowId: null,
      lastOperationSha256: null
    })
    const current = await readBrc38PrivateLocalCandidateJournal(k)
    if (
      current.bindingSha256 !== input.bindingSha256 ||
      current.sourceSha256 !== input.sourceSha256 ||
      current.epoch !== input.epoch ||
      current.baseRevision !== input.revision ||
      current.maximumRows !== input.maximumRows ||
      current.records !== 0
    )
      invalid()
    actual(k, true)
    await k.raw('RELEASE __brc38_local_candidate_journal')
  } catch (cause) {
    try {
      await k.raw('ROLLBACK TO __brc38_local_candidate_journal')
      await k.raw('RELEASE __brc38_local_candidate_journal')
    } catch (error_) {
      throw new AggregateError(
        [cause, error_],
        'Local candidate journal installation retains actual rollback failure',
        { cause }
      )
    }
    throw cause
  }
}
