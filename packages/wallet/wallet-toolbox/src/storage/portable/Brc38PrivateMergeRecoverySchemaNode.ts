import type { Knex } from 'knex'
import { isBrc38OwnedPrivateNativeSqlite, isBrc38OwnedPrivateNativeWriter } from './KnexBrc38StagingStore'
import { brc38PrivateLocalCandidateStateTable as candidate } from './Brc38PrivateLocalCandidateJournalNode'
export const brc38PrivateMergeRecoveryTable = 'brc38_private_merge_recovery'
const table = brc38PrivateMergeRecoveryTable,
  context = `EXISTS(SELECT 1 FROM ${candidate} WHERE slot=1 AND bindingSha256=NEW.bindingSha256 AND sourceSha256=NEW.sourceSha256 AND epoch=NEW.sourceEpoch AND rebuilds=NEW.episode)`,
  definitions = Object.freeze([
    `CREATE TABLE ${table}(slot INTEGER PRIMARY KEY CHECK(slot=1),bindingSha256 TEXT NOT NULL CHECK(length(bindingSha256)=64),sourceSha256 TEXT NOT NULL CHECK(length(sourceSha256)=64),sourceEpoch TEXT NOT NULL CHECK(length(sourceEpoch)=36),episode INTEGER NOT NULL CHECK(typeof(episode)='integer' AND episode BETWEEN 0 AND 3),phase TEXT NOT NULL CHECK(phase IN ('BASELINE','IMPORT')),activeImportId TEXT REFERENCES brc38_import_journal(importId),sourceRevision INTEGER NOT NULL CHECK(typeof(sourceRevision)='integer' AND sourceRevision>=0),CHECK((phase='BASELINE' AND activeImportId IS NULL) OR (phase='IMPORT' AND length(activeImportId)=36)))`,
    `CREATE TRIGGER ${table}_insert BEFORE INSERT ON ${table} WHEN NOT ${context} OR NEW.phase!='BASELINE' OR NEW.activeImportId IS NOT NULL OR NOT EXISTS(SELECT 1 FROM ${candidate} WHERE slot=1 AND phase='RECOVERY' AND caughtUpRevision=NEW.sourceRevision) BEGIN SELECT RAISE(ABORT,'Private merge recovery original baseline differs'); END`,
    `CREATE TRIGGER ${table}_update BEFORE UPDATE ON ${table} WHEN NEW.slot IS NOT OLD.slot OR NEW.bindingSha256 IS NOT OLD.bindingSha256 OR NEW.sourceSha256 IS NOT OLD.sourceSha256 OR NEW.sourceEpoch IS NOT OLD.sourceEpoch OR NOT ${context} OR NOT ((OLD.phase='BASELINE' AND NEW.phase='IMPORT' AND NEW.episode=OLD.episode AND NEW.sourceRevision>=OLD.sourceRevision AND EXISTS(SELECT 1 FROM ${candidate} WHERE slot=1 AND phase='RECOVERY' AND caughtUpRevision=NEW.sourceRevision) AND EXISTS(SELECT 1 FROM brc38_import_journal WHERE importId=NEW.activeImportId AND bindingSha256=NEW.bindingSha256 AND cleanupAllowed=0 AND json_extract(receiptJson,'$.nextRow')=0)) OR (OLD.phase='BASELINE' AND NEW.phase='BASELINE' AND NEW.episode=OLD.episode+1 AND NEW.activeImportId IS NULL AND NEW.sourceRevision>=OLD.sourceRevision AND EXISTS(SELECT 1 FROM ${candidate} WHERE slot=1 AND phase='CLEAR')) OR (OLD.phase='IMPORT' AND NEW.phase='BASELINE' AND NEW.episode=OLD.episode+1 AND NEW.activeImportId IS NULL AND NEW.sourceRevision>OLD.sourceRevision AND EXISTS(SELECT 1 FROM ${candidate} WHERE slot=1 AND phase='CLEAR'))) BEGIN SELECT RAISE(ABORT,'Private merge recovery episode or scope differs'); END`,
    `CREATE TRIGGER ${table}_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Private merge recovery requires candidate retirement'); END`
  ])
function actual(k: Knex.Transaction, writer = false): void {
  if (
    !k.isTransaction ||
    k.isCompleted() ||
    !(writer ? isBrc38OwnedPrivateNativeWriter(k) : isBrc38OwnedPrivateNativeSqlite(k))
  )
    throw new Error('Private merge recovery requires its actual transaction')
}
export interface Brc38PrivateMergeRecovery {
  bindingSha256: string
  sourceSha256: string
  sourceEpoch: string
  episode: number
  phase: 'BASELINE' | 'IMPORT'
  activeImportId: string | null
  sourceRevision: string
}
export async function hasBrc38PrivateMergeRecoverySchema(k: Knex.Transaction): Promise<boolean> {
  actual(k)
  const objects = (await k('sqlite_schema')
    .whereRaw('substr(name,1,?)=?', [table.length, table])
    .count({ count: '*' })
    .first()) as { count: number } | undefined
  if (objects?.count === 0) return false
  if (objects?.count !== definitions.length) throw new Error('Private merge recovery schema differs')
  for (const sql of definitions) {
    const [, type, name] = /^CREATE (TABLE|TRIGGER) (\w+)/.exec(sql)!,
      count = (await k('sqlite_schema')
        .where({ name, type: type.toLowerCase() })
        .whereRaw('CAST(sql AS BLOB)=CAST(? AS BLOB)', [sql])
        .count({ count: '*' })
        .first()) as { count: number } | undefined
    if (count?.count !== 1) throw new Error('Private merge recovery exact definition differs')
  }
  const all = (await k('sqlite_schema').where({ tbl_name: table }).count({ count: '*' }).first()) as
    { count: number } | undefined
  if (all?.count !== definitions.length) throw new Error('Private merge recovery extra object differs')
  actual(k)
  return true
}
export async function installBrc38PrivateMergeRecoverySchema(k: Knex.Transaction): Promise<void> {
  actual(k, true)
  if (await hasBrc38PrivateMergeRecoverySchema(k)) return
  for (const sql of definitions) await k.raw(sql)
  if (!(await hasBrc38PrivateMergeRecoverySchema(k))) throw new Error('Private merge recovery installation differs')
}
export async function readBrc38PrivateMergeRecovery(
  k: Knex.Transaction
): Promise<Brc38PrivateMergeRecovery | undefined> {
  if (!(await hasBrc38PrivateMergeRecoverySchema(k))) return undefined
  const values = (await k(table)
    .where({ slot: 1 })
    .select(
      'bindingSha256',
      'sourceSha256',
      'sourceEpoch',
      'episode',
      'phase',
      'activeImportId',
      k.raw('CAST(sourceRevision AS TEXT) AS sourceRevision')
    )
    .limit(2)) as Brc38PrivateMergeRecovery[]
  if (values.length > 1) throw new Error('Private merge recovery state differs')
  return values[0]
}
