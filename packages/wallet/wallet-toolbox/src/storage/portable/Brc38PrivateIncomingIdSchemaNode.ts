import { brc38PrivateLocalCandidateStateTable as candidate } from './Brc38PrivateLocalCandidateJournalNode'
import type { Knex } from 'knex'
import { isBrc38OwnedPrivateNativeSqlite, isBrc38OwnedPrivateNativeWriter } from './KnexBrc38StagingStore'
export const brc38PrivateIncomingIdRanges = 'brc38_private_incoming_id_ranges'
const table = brc38PrivateIncomingIdRanges,
  definitions = Object.freeze([
    `CREATE TABLE ${table}(tableId INTEGER PRIMARY KEY CHECK(typeof(tableId)='integer' AND tableId BETWEEN 0 AND 9),bindingSha256 TEXT NOT NULL CHECK(length(bindingSha256)=64),sourceSha256 TEXT NOT NULL CHECK(length(sourceSha256)=64),sourceEpoch TEXT NOT NULL CHECK(length(sourceEpoch)=36),first INTEGER NOT NULL CHECK(typeof(first)='integer' AND first BETWEEN 1 AND 9007199254740991),count INTEGER NOT NULL CHECK(typeof(count)='integer' AND count BETWEEN 1 AND 40000000 AND first<=9007199254740991-count+1),used INTEGER NOT NULL CHECK(typeof(used)='integer' AND used BETWEEN 0 AND count),expiresAt INTEGER NOT NULL CHECK(typeof(expiresAt)='integer' AND expiresAt BETWEEN 1 AND 9007199254740991))`,
    `CREATE TRIGGER ${table}_insert BEFORE INSERT ON ${table} WHEN NEW.used!=0 OR NOT EXISTS(SELECT 1 FROM ${candidate} WHERE slot=1 AND phase='RECOVERY' AND bindingSha256=NEW.bindingSha256 AND sourceSha256=NEW.sourceSha256 AND epoch=NEW.sourceEpoch) OR NEW.expiresAt!=json_extract((SELECT limitsJson FROM private_binding WHERE slot=1),'$[5]') BEGIN SELECT RAISE(ABORT,'Private incoming ID original source or policy differs'); END`,
    `CREATE TRIGGER ${table}_update BEFORE UPDATE ON ${table} WHEN NOT EXISTS(SELECT 1 FROM ${candidate} WHERE slot=1 AND phase='RECOVERY' AND bindingSha256=OLD.bindingSha256 AND sourceSha256=OLD.sourceSha256 AND epoch=OLD.sourceEpoch) OR NEW.tableId IS NOT OLD.tableId OR NEW.bindingSha256 IS NOT OLD.bindingSha256 OR NEW.sourceSha256 IS NOT OLD.sourceSha256 OR NEW.sourceEpoch IS NOT OLD.sourceEpoch OR NEW.first IS NOT OLD.first OR NEW.count IS NOT OLD.count OR NEW.expiresAt IS NOT OLD.expiresAt OR NEW.used!=OLD.used+1 BEGIN SELECT RAISE(ABORT,'Private incoming ID range or prefix differs'); END`,
    `CREATE TRIGGER ${table}_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Private incoming ID range requires candidate retirement'); END`
  ])
export interface Brc38PrivateIncomingIdRange {
  tableId: number
  bindingSha256: string
  sourceSha256: string
  sourceEpoch: string
  first: number
  count: number
  used: number
  expiresAt: number
}
function actual(k: Knex.Transaction, write = false): void {
  if (
    !k.isTransaction ||
    k.isCompleted() ||
    !(write ? isBrc38OwnedPrivateNativeWriter(k) : isBrc38OwnedPrivateNativeSqlite(k))
  )
    throw new Error('Private incoming ID ranges require their actual transaction')
}
export async function hasBrc38PrivateIncomingIdSchema(k: Knex.Transaction): Promise<boolean> {
  actual(k)
  const all = (await k('sqlite_schema')
    .whereRaw('substr(name,1,?)=?', [table.length, table])
    .count({ count: '*' })
    .first()) as { count: number } | undefined
  if (all?.count === 0) return false
  if (all?.count !== definitions.length) throw new Error('Private incoming ID schema differs')
  for (const sql of definitions) {
    const [, type, name] = /^CREATE (TABLE|TRIGGER) (\w+)/.exec(sql)!,
      value = (await k('sqlite_schema')
        .where({ type: type.toLowerCase(), name })
        .whereRaw('CAST(sql AS BLOB)=CAST(? AS BLOB)', [sql])
        .count({ count: '*' })
        .first()) as { count: number } | undefined
    if (value?.count !== 1) throw new Error('Private incoming ID exact definition differs')
  }
  const objects = (await k('sqlite_schema').where({ tbl_name: table }).count({ count: '*' }).first()) as
    { count: number } | undefined
  if (objects?.count !== definitions.length) throw new Error('Private incoming ID extra object differs')
  actual(k)
  return true
}
export async function installBrc38PrivateIncomingIdSchema(k: Knex.Transaction): Promise<void> {
  actual(k, true)
  if (await hasBrc38PrivateIncomingIdSchema(k)) return
  for (const sql of definitions) await k.raw(sql)
  if (!(await hasBrc38PrivateIncomingIdSchema(k))) throw new Error('Private incoming ID installation differs')
}
export async function readBrc38PrivateIncomingIdRange(
  k: Knex.Transaction,
  tableId: number
): Promise<Brc38PrivateIncomingIdRange | undefined> {
  actual(k)
  if (!(await hasBrc38PrivateIncomingIdSchema(k))) return undefined
  const values = (await k(table)
    .where({ tableId })
    .select('tableId', 'bindingSha256', 'sourceSha256', 'sourceEpoch', 'first', 'count', 'used', 'expiresAt')
    .limit(2)) as Brc38PrivateIncomingIdRange[]
  if (values.length > 1) throw new Error('Private incoming ID range differs')
  const value = values[0]
  if (
    value !== undefined &&
    (!/^[0-9a-f]{64}$/.test(value.bindingSha256) ||
      !/^[0-9a-f]{64}$/.test(value.sourceSha256) ||
      !Number.isSafeInteger(value.first) ||
      value.first < 1 ||
      !Number.isSafeInteger(value.count) ||
      value.count < 1 ||
      !Number.isSafeInteger(value.first + value.count - 1) ||
      !Number.isSafeInteger(value.used) ||
      value.used < 0 ||
      value.used > value.count ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= Date.now())
  )
    throw new Error('Private incoming ID range bounds differ')
  return value
}
