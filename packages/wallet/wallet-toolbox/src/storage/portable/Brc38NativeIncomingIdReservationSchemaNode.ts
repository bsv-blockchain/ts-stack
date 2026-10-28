import type { Knex } from 'knex'
import { isBrc38OwnedPublishedNativeSqlite } from './Brc38PublishedProfileNode'
import { ownedNativeRootIdentity } from '../schema/ownedNativeSqliteConnectionsNode'

export const brc38NativeIncomingIdReservationBudget = 'brc38_incoming_id_budget'
export const brc38NativeIncomingIdReservations = 'brc38_incoming_id_ranges'
const budget = brc38NativeIncomingIdReservationBudget,
  ranges = brc38NativeIncomingIdReservations,
  prefix = 'brc38_incoming_id_',
  definitions = Object.freeze([
    `CREATE TABLE ${budget}(slot INTEGER PRIMARY KEY CHECK(slot=1),maximumRows INTEGER NOT NULL CHECK(typeof(maximumRows)='integer' AND maximumRows BETWEEN 1 AND 10000000),records INTEGER NOT NULL CHECK(typeof(records)='integer' AND records BETWEEN 0 AND maximumRows))`,
    `CREATE TABLE ${ranges}(bindingSha256 TEXT NOT NULL CHECK(typeof(bindingSha256)='text' AND length(bindingSha256)=64),tableId INTEGER NOT NULL CHECK(typeof(tableId)='integer' AND tableId BETWEEN 0 AND 9),sourceEpoch TEXT NOT NULL CHECK(typeof(sourceEpoch)='text' AND length(sourceEpoch)=36),primaryEpoch TEXT NOT NULL CHECK(typeof(primaryEpoch)='text' AND length(primaryEpoch) BETWEEN 1 AND 19),userId INTEGER NOT NULL CHECK(typeof(userId)='integer' AND userId BETWEEN 1 AND 9007199254740991),first INTEGER NOT NULL CHECK(typeof(first)='integer' AND first BETWEEN 1 AND 9007199254740991),count INTEGER NOT NULL CHECK(typeof(count)='integer' AND count BETWEEN 1 AND 40000000 AND first<=9007199254740991-count+1),expiresAt INTEGER NOT NULL CHECK(typeof(expiresAt)='integer' AND expiresAt BETWEEN 1 AND 9007199254740991),PRIMARY KEY(bindingSha256,tableId))`,
    `CREATE INDEX brc38_incoming_id_expiry ON ${ranges}(expiresAt,bindingSha256,tableId)`,
    `CREATE TRIGGER ${budget}_insert BEFORE INSERT ON ${budget} WHEN NEW.records!=0 OR NOT EXISTS(SELECT 1 FROM brc38_local_baseline_clock WHERE slot=1 AND maximumRows=NEW.maximumRows) BEGIN SELECT RAISE(ABORT,'Incoming ID reservation original capacity differs'); END`,
    `CREATE TRIGGER ${budget}_update BEFORE UPDATE ON ${budget} WHEN NEW.slot IS NOT OLD.slot OR NEW.maximumRows IS NOT OLD.maximumRows OR abs(NEW.records-OLD.records)!=1 BEGIN SELECT RAISE(ABORT,'Incoming ID reservation capacity differs'); END`,
    `CREATE TRIGGER ${budget}_delete BEFORE DELETE ON ${budget} BEGIN SELECT RAISE(ABORT,'Incoming ID reservation budget requires profile retirement'); END`,
    `CREATE TRIGGER ${ranges}_insert BEFORE INSERT ON ${ranges} WHEN NOT EXISTS(SELECT 1 FROM ${budget} WHERE slot=1 AND records<maximumRows) OR NOT EXISTS(SELECT 1 FROM brc38_local_baseline_clock WHERE slot=1 AND epoch=NEW.sourceEpoch AND enabled=1 AND complete=1) BEGIN SELECT RAISE(ABORT,'Incoming ID range scope or original capacity differs'); END`,
    `CREATE TRIGGER ${ranges}_charge AFTER INSERT ON ${ranges} BEGIN UPDATE ${budget} SET records=records+1 WHERE slot=1; END`,
    `CREATE TRIGGER ${ranges}_update BEFORE UPDATE ON ${ranges} BEGIN SELECT RAISE(ABORT,'Incoming ID ranges are immutable'); END`,
    `CREATE TRIGGER ${ranges}_delete BEFORE DELETE ON ${ranges} WHEN OLD.expiresAt>CAST(strftime('%s','now') AS INTEGER)*1000 BEGIN SELECT RAISE(ABORT,'Unexpired incoming ID range cannot be removed'); END`,
    `CREATE TRIGGER ${ranges}_release AFTER DELETE ON ${ranges} BEGIN UPDATE ${budget} SET records=records-1 WHERE slot=1; END`
  ])
function actual(k: Knex.Transaction, writer = false): void {
  if (
    !k.isTransaction ||
    k.isCompleted() ||
    !isBrc38OwnedPublishedNativeSqlite(k) ||
    (writer && ownedNativeRootIdentity(k)?.slot !== 0)
  )
    throw new Error('Incoming ID ranges require the actual published native transaction')
}
export async function hasBrc38NativeIncomingIdReservationSchema(k: Knex.Transaction): Promise<boolean> {
  actual(k)
  const all = (await k('sqlite_schema')
    .whereRaw('substr(name,1,?)=?', [prefix.length, prefix])
    .count({ count: '*' })
    .first()) as { count: number } | undefined
  if (all?.count === 0) return false
  if (all?.count !== definitions.length) throw new Error('Incoming ID reservation schema differs')
  for (const sql of definitions) {
    const [, type, name] = /^CREATE (TABLE|TRIGGER|INDEX) (\w+)/.exec(sql)!,
      value = (await k('sqlite_schema')
        .where({ type: type.toLowerCase(), name })
        .whereRaw('CAST(sql AS BLOB)=CAST(? AS BLOB)', [sql])
        .count({ count: '*' })
        .first()) as { count: number } | undefined
    if (value?.count !== 1) throw new Error('Incoming ID reservation exact definition differs')
  }
  const objects = (await k('sqlite_schema').whereIn('tbl_name', [budget, ranges]).count({ count: '*' }).first()) as
      { count: number } | undefined,
    index = (await k('sqlite_schema')
      .where({ name: `sqlite_autoindex_${ranges}_1`, type: 'index', tbl_name: ranges })
      .whereNull('sql')
      .count({ count: '*' })
      .first()) as { count: number } | undefined
  if (objects?.count !== definitions.length + 1 || index?.count !== 1)
    throw new Error('Incoming ID reservation object inventory differs')
  actual(k)
  return true
}
/** Explicit source-addition migration only; ordinary source readers and range
 * allocation cannot install this persistence behind an existing receipt. */
export async function installBrc38NativeIncomingIdReservationSchema(
  k: Knex.Transaction,
  maximumRows: number
): Promise<void> {
  actual(k, true)
  if (
    !Number.isSafeInteger(maximumRows) ||
    maximumRows < 1 ||
    maximumRows > 10000000 ||
    (await hasBrc38NativeIncomingIdReservationSchema(k))
  )
    throw new Error('Incoming ID reservation installation differs')
  for (const sql of definitions) await k.raw(sql)
  await k(budget).insert({ slot: 1, maximumRows, records: 0 })
  if (!(await hasBrc38NativeIncomingIdReservationSchema(k)))
    throw new Error('Incoming ID reservation installation is incomplete')
}
