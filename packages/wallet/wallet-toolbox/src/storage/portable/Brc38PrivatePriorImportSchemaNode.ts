import type { Knex } from 'knex'
import { isBrc38OwnedPrivateNativeSqlite, isBrc38OwnedPrivateNativeWriter } from './KnexBrc38StagingStore'
import { isBrc38OwnedPublishedNativeSqlite } from './Brc38PublishedProfileNode'
import { brc38NativePriorImportTables } from './Brc38NativePriorImportTables'
import {
  brc38PrivateLocalCandidateStateTable as candidate,
  brc38PrivateLocalCandidatePriorPointGuard
} from './Brc38PrivateLocalCandidateJournalNode'

export const brc38PrivatePriorImportBudget = 'brc38_local_prior_import_budget'
export const brc38PrivatePriorImportRows = 'brc38_local_prior_import_rows'
export const brc38PrivatePriorImportChunks = 'brc38_local_prior_import_chunks'
const prefix = 'brc38_local_prior_import_',
  budget = brc38PrivatePriorImportBudget,
  rows = brc38PrivatePriorImportRows,
  chunks = brc38PrivatePriorImportChunks,
  count = brc38NativePriorImportTables.length,
  context = `EXISTS(SELECT 1 FROM ${candidate} c JOIN ${budget} b ON b.slot=1 WHERE c.slot=1 AND c.phase='RECOVERY' AND c.bindingSha256=b.bindingSha256 AND c.sourceSha256=b.sourceSha256 AND c.maximumRows=b.maximumRows)`,
  definitions = Object.freeze([
    `CREATE TABLE ${budget}(slot INTEGER PRIMARY KEY CHECK(slot=1),bindingSha256 TEXT NOT NULL CHECK(length(bindingSha256)=64),sourceSha256 TEXT NOT NULL CHECK(length(sourceSha256)=64),sourceLineageSha256 TEXT NOT NULL CHECK(length(sourceLineageSha256)=64),maximumRows INTEGER NOT NULL CHECK(typeof(maximumRows)='integer' AND maximumRows BETWEEN 1 AND 10000000),maximumLogicalBytes INTEGER NOT NULL CHECK(typeof(maximumLogicalBytes)='integer' AND maximumLogicalBytes BETWEEN 1 AND 9007199254740991),records INTEGER NOT NULL CHECK(typeof(records)='integer' AND records BETWEEN 0 AND maximumRows),logicalBytes INTEGER NOT NULL CHECK(typeof(logicalBytes)='integer' AND logicalBytes BETWEEN 0 AND maximumLogicalBytes),copyTable INTEGER NOT NULL CHECK(copyTable BETWEEN 0 AND ${count + 1}),afterRowId INTEGER CHECK(afterRowId IS NULL OR (typeof(afterRowId)='integer' AND afterRowId BETWEEN -9007199254740991 AND 9007199254740991)))`,
    `CREATE TABLE ${rows}(sourceLineageSha256 TEXT NOT NULL CHECK(length(sourceLineageSha256)=64),tableId INTEGER NOT NULL CHECK(typeof(tableId)='integer' AND tableId BETWEEN 0 AND ${count - 1}),copyRowId INTEGER NOT NULL CHECK(typeof(copyRowId)='integer' AND copyRowId BETWEEN -9007199254740991 AND 9007199254740991),sourceRowId INTEGER NOT NULL CHECK(typeof(sourceRowId)='integer' AND sourceRowId BETWEEN -9007199254740991 AND 9007199254740991),metadataJson TEXT NOT NULL CHECK(typeof(metadataJson)='text' AND length(CAST(metadataJson AS BLOB)) BETWEEN 2 AND 1048576),metadataSha256 TEXT NOT NULL CHECK(length(metadataSha256)=64),fieldKind TEXT NOT NULL CHECK(fieldKind IN ('none','blob','text')),bytes INTEGER NOT NULL CHECK(typeof(bytes)='integer' AND bytes BETWEEN 0 AND 16777216),sha256 TEXT CHECK((fieldKind='none' AND sha256 IS NULL AND bytes=0) OR (fieldKind!='none' AND bytes>=1 AND length(sha256)=64)),accepted INTEGER NOT NULL CHECK(typeof(accepted)='integer' AND accepted BETWEEN 0 AND bytes),chunks INTEGER NOT NULL CHECK(typeof(chunks)='integer' AND chunks BETWEEN 0 AND bytes),state TEXT NOT NULL CHECK(state IN ('PENDING','SEALED') AND (state='PENDING' OR accepted=bytes)),PRIMARY KEY(sourceLineageSha256,tableId,sourceRowId))`,
    `CREATE TABLE ${chunks}(sourceLineageSha256 TEXT NOT NULL CHECK(length(sourceLineageSha256)=64),tableId INTEGER NOT NULL,sourceRowId INTEGER NOT NULL,offset INTEGER NOT NULL CHECK(typeof(offset)='integer' AND offset>=0),bytes INTEGER NOT NULL CHECK(typeof(bytes)='integer' AND bytes BETWEEN 1 AND 16384),payload BLOB NOT NULL CHECK(typeof(payload)='blob' AND length(payload)=bytes),sha256 TEXT NOT NULL CHECK(length(sha256)=64),PRIMARY KEY(sourceLineageSha256,tableId,sourceRowId,offset),FOREIGN KEY(sourceLineageSha256,tableId,sourceRowId) REFERENCES ${rows}(sourceLineageSha256,tableId,sourceRowId))`,
    `CREATE TRIGGER ${budget}_insert BEFORE INSERT ON ${budget} BEGIN SELECT CASE WHEN NEW.records!=0 OR NEW.logicalBytes!=0 OR NEW.copyTable!=0 OR NEW.afterRowId IS NOT NULL OR NOT EXISTS(SELECT 1 FROM ${candidate} WHERE slot=1 AND phase='RECOVERY' AND bindingSha256=NEW.bindingSha256 AND sourceSha256=NEW.sourceSha256 AND maximumRows=NEW.maximumRows) OR NEW.maximumLogicalBytes!=json_extract((SELECT limitsJson FROM private_binding WHERE slot=1),'$[1]') THEN RAISE(ABORT,'Prior import original candidate reservation differs') END; END`,
    `CREATE TRIGGER ${budget}_update BEFORE UPDATE ON ${budget} WHEN OLD.copyTable=${count + 1} OR NOT ${context} OR NEW.slot IS NOT OLD.slot OR NEW.bindingSha256 IS NOT OLD.bindingSha256 OR NEW.sourceSha256 IS NOT OLD.sourceSha256 OR NEW.sourceLineageSha256 IS NOT OLD.sourceLineageSha256 OR NEW.maximumRows IS NOT OLD.maximumRows OR NEW.maximumLogicalBytes IS NOT OLD.maximumLogicalBytes OR NEW.records<OLD.records OR NEW.records>OLD.records+1 OR NEW.logicalBytes<OLD.logicalBytes OR NEW.copyTable<OLD.copyTable OR NEW.copyTable>OLD.copyTable+1 OR (NEW.copyTable=OLD.copyTable AND OLD.afterRowId IS NOT NULL AND (NEW.afterRowId IS NULL OR NEW.afterRowId<OLD.afterRowId)) OR (NEW.copyTable!=OLD.copyTable AND (NEW.afterRowId IS NOT NULL OR EXISTS(SELECT 1 FROM ${rows} WHERE state!='SEALED' LIMIT 1))) BEGIN SELECT RAISE(ABORT,'Prior import original bounds or cursor differ'); END`,
    `CREATE TRIGGER ${budget}_delete BEFORE DELETE ON ${budget} BEGIN SELECT RAISE(ABORT,'Prior import custody requires owned physical retirement'); END`,
    `CREATE TRIGGER ${rows}_insert BEFORE INSERT ON ${rows} BEGIN SELECT CASE WHEN NOT ${context} OR NEW.state!='PENDING' OR NEW.accepted!=0 OR NEW.chunks!=0 OR NOT EXISTS(SELECT 1 FROM ${budget} b JOIN ${candidate} c ON c.slot=1 WHERE b.slot=1 AND ((b.copyTable=NEW.tableId AND b.sourceLineageSha256=NEW.sourceLineageSha256 AND NEW.copyRowId=NEW.sourceRowId) OR b.copyTable=${count}) AND (b.afterRowId IS NULL OR NEW.copyRowId>b.afterRowId) AND b.records+c.records<b.maximumRows AND 512+length(CAST(NEW.metadataJson AS BLOB))+NEW.bytes<=b.maximumLogicalBytes-b.logicalBytes) THEN RAISE(ABORT,'Prior import row scope, prefix or quota differs') END; END`,
    `CREATE TRIGGER ${rows}_charge AFTER INSERT ON ${rows} BEGIN UPDATE ${budget} SET records=records+1,logicalBytes=logicalBytes+512+length(CAST(NEW.metadataJson AS BLOB))+NEW.bytes WHERE slot=1; END`,
    `CREATE TRIGGER ${rows}_update BEFORE UPDATE ON ${rows} WHEN NOT ${context} OR NEW.sourceLineageSha256 IS NOT OLD.sourceLineageSha256 OR NEW.tableId IS NOT OLD.tableId OR NEW.sourceRowId IS NOT OLD.sourceRowId OR NEW.copyRowId IS NOT OLD.copyRowId OR NEW.metadataJson IS NOT OLD.metadataJson OR NEW.metadataSha256 IS NOT OLD.metadataSha256 OR NEW.fieldKind IS NOT OLD.fieldKind OR NEW.bytes IS NOT OLD.bytes OR NEW.sha256 IS NOT OLD.sha256 OR NOT ((OLD.state='PENDING' AND NEW.state='PENDING' AND NEW.accepted>OLD.accepted AND NEW.chunks=OLD.chunks+1) OR (OLD.state='PENDING' AND NEW.state='SEALED' AND OLD.accepted=OLD.bytes AND NEW.accepted=OLD.accepted AND NEW.chunks=OLD.chunks)) BEGIN SELECT RAISE(ABORT,'Prior import immutable content or prefix differs'); END`,
    `CREATE TRIGGER ${rows}_seal AFTER UPDATE OF state ON ${rows} WHEN OLD.state='PENDING' AND NEW.state='SEALED' BEGIN UPDATE ${budget} SET afterRowId=NEW.copyRowId WHERE slot=1 AND ((copyTable=NEW.tableId AND sourceLineageSha256=NEW.sourceLineageSha256) OR copyTable=${count}); SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'Prior import seal cursor differs') END; END`,
    `CREATE TRIGGER ${rows}_delete BEFORE DELETE ON ${rows} BEGIN SELECT RAISE(ABORT,'Prior import originals require owned physical retirement'); END`,
    `CREATE TRIGGER ${chunks}_insert BEFORE INSERT ON ${chunks} BEGIN SELECT CASE WHEN NOT ${context} OR NOT EXISTS(SELECT 1 FROM ${rows} WHERE sourceLineageSha256=NEW.sourceLineageSha256 AND tableId=NEW.tableId AND sourceRowId=NEW.sourceRowId AND state='PENDING' AND accepted=NEW.offset AND NEW.bytes<=bytes-accepted) OR NOT EXISTS(SELECT 1 FROM ${budget} WHERE slot=1 AND 512<=maximumLogicalBytes-logicalBytes) THEN RAISE(ABORT,'Prior import chunk prefix or quota differs') END; END`,
    `CREATE TRIGGER ${chunks}_charge AFTER INSERT ON ${chunks} BEGIN UPDATE ${rows} SET accepted=accepted+NEW.bytes,chunks=chunks+1 WHERE sourceLineageSha256=NEW.sourceLineageSha256 AND tableId=NEW.tableId AND sourceRowId=NEW.sourceRowId; UPDATE ${budget} SET logicalBytes=logicalBytes+512 WHERE slot=1; END`,
    `CREATE TRIGGER ${chunks}_update BEFORE UPDATE ON ${chunks} BEGIN SELECT RAISE(ABORT,'Prior import chunks are immutable'); END`,
    `CREATE TRIGGER ${chunks}_delete BEFORE DELETE ON ${chunks} BEGIN SELECT RAISE(ABORT,'Prior import chunks require owned physical retirement'); END`,
    brc38PrivateLocalCandidatePriorPointGuard.sql
  ])
function actual(k: Knex.Transaction, write = false): void {
  if (
    k.isTransaction !== true ||
    k.isCompleted() ||
    !(write
      ? isBrc38OwnedPrivateNativeWriter(k)
      : isBrc38OwnedPrivateNativeSqlite(k) || isBrc38OwnedPublishedNativeSqlite(k))
  )
    throw new Error('Prior import custody requires its actual private transaction')
}
/** Fresh exact definitions, including all implicit indexes and unknown triggers.
 * Matching schema/counters confer no source, semantic or publication authority. */
export async function hasBrc38PrivatePriorImportSchema(k: Knex.Transaction): Promise<boolean> {
  actual(k)
  const total = (await k('sqlite_schema')
    .whereRaw('substr(name,1,?)=?', [prefix.length, prefix])
    .count({ count: '*' })
    .first()) as { count: unknown } | undefined
  if (total?.count === 0) return false
  if (total?.count !== definitions.length) throw new Error('Prior import custody schema differs')
  // Compare all fixed source definitions in one fresh SQLite query. Keep the
  // original prefix, complete-family and implicit-primary-index checks below;
  // the result is local to this actual transaction and is never a cached grant.
  const exact = (await k('sqlite_schema')
    .where(query => {
      for (const sql of definitions) {
        const match = /^CREATE (TABLE|TRIGGER) (\w+)/.exec(sql)!
        void query.orWhere(part => {
          void part
            .where({ name: match[2], type: match[1].toLowerCase() })
            .whereRaw('CAST(sql AS BLOB)=CAST(? AS BLOB)', [sql])
        })
      }
    })
    .count({ count: '*' })
    .first()) as { count: unknown } | undefined
  if (exact?.count !== definitions.length) throw new Error('Prior import custody exact definition differs')
  const all = (await k('sqlite_schema')
    .where(function () {
      void this.whereIn('tbl_name', [budget, rows, chunks]).orWhere('name', 'brc38_local_prior_import_point_guard')
    })
    .count({ count: '*' })
    .first()) as { count: unknown } | undefined
  if (all?.count !== definitions.length + 2) throw new Error('Prior import custody has an extra object')
  for (const name of [rows, chunks]) {
    const index = (await k('sqlite_schema')
      .where({ name: `sqlite_autoindex_${name}_1`, type: 'index', tbl_name: name })
      .whereNull('sql')
      .count({ count: '*' })
      .first()) as { count: unknown } | undefined
    if (index?.count !== 1) throw new Error('Prior import custody primary index differs')
  }
  actual(k)
  return true
}
export async function installBrc38PrivatePriorImportSchema(k: Knex.Transaction): Promise<void> {
  actual(k, true)
  if (await hasBrc38PrivatePriorImportSchema(k)) return
  for (const sql of definitions) {
    actual(k, true)
    await k.raw(sql)
  }
  if (!(await hasBrc38PrivatePriorImportSchema(k))) throw new Error('Prior import custody installation differs')
}
