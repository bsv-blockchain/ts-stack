import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import { fixedProfile, type Row } from './Brc38PublishedProfileReceiptNode'
import { copyBrc38NativeRetirement, type Brc38NativeRetirementRecord } from './Brc38NativeRetirementNode'
import { readBrc38NativeBackend, type Brc38NativeComponentBuild } from './Brc38NativeBackendNode'

/** Durable target lifecycle DATA. It records the forward decision after full
 * native target preparation, before manager selection can expose a writer.
 * Reading this record never creates a source, native owner or manager. */
export interface Brc38ComposedNativeCommit {
  readonly protocol: 'brc38-composed-native-commit/v1'
  readonly retirement: Readonly<Brc38NativeRetirementRecord>
}
const table = 'profile_composed_commit'
const schema =
  'CREATE TABLE profile_composed_commit(slot INTEGER PRIMARY KEY CHECK(slot=1),recordJson TEXT NOT NULL CHECK(length(CAST(recordJson AS BLOB))<=4096),recordSha256 TEXT NOT NULL CHECK(length(CAST(recordSha256 AS BLOB))=64))'
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
function invalid(): never {
  throw new Error('Composed native completed lifecycle or original decision differs')
}
function copy(
  selected: Brc38ComposedNativeCommit,
  row: Row,
  bindingSha256: string
): Readonly<Brc38ComposedNativeCommit> {
  if (selected === null || typeof selected !== 'object' || selected.protocol !== 'brc38-composed-native-commit/v1')
    invalid()
  const retirement = copyBrc38NativeRetirement(selected.retirement),
    fixed = fixedProfile(row, bindingSha256),
    receipt = fixed.composition,
    target = retirement.target,
    source = retirement.source
  if (
    row.state !== 'ACTIVE' ||
    fixed.protocol !== 'brc38-published-profile/v3' ||
    fixed.inventory === undefined ||
    receipt === undefined ||
    retirement.decisionId !== receipt.decisionId ||
    target.rootId !== fixed.inventory.rootId ||
    target.profileId !== fixed.inventory.profileId ||
    target.fixedSha256 !== row.fixedSha256 ||
    target.copySha256 !== row.copySha256 ||
    target.copyBytes !== row.copyBytes ||
    ['fixedSha256', 'copySha256', 'copyBytes', 'epoch', 'revision', 'primaryEpoch'].some(
      key => source[key as keyof typeof source] !== receipt.source[key as keyof typeof source]
    )
  )
    invalid()
  const value = Object.freeze({ protocol: selected.protocol, retirement })
  if (Buffer.byteLength(JSON.stringify(value)) > 4096 || JSON.stringify(value) !== JSON.stringify(selected)) invalid()
  return value
}
async function registered(db: Knex): Promise<boolean> {
  const objects = (await db('sqlite_schema')
    .where({ name: table })
    .orWhere({ tbl_name: table })
    .select('type', db.raw('CASE WHEN length(CAST(sql AS BLOB))<=8192 THEN sql ELSE NULL END AS sql'))
    .limit(2)) as Array<{ type: string; sql: string | null }>
  if (objects.length === 0) return false
  if (objects.length !== 1 || objects[0].type !== 'table' || objects[0].sql !== schema) invalid()
  return true
}
export async function readBrc38ComposedNativeCommit(
  db: Knex,
  row: Row,
  build: Brc38NativeComponentBuild,
  bindingSha256: string
): Promise<Readonly<Brc38ComposedNativeCommit> | undefined> {
  if (!(await registered(db))) return undefined
  if ((await readBrc38NativeBackend(db, row, build))?.phase !== 'WAL') invalid()
  const values = (await db(table)
    .select(
      db.raw('CASE WHEN slot=1 AND length(CAST(recordJson AS BLOB))<=4096 THEN recordJson ELSE NULL END AS recordJson'),
      db.raw('CASE WHEN length(CAST(recordSha256 AS BLOB))=64 THEN recordSha256 ELSE NULL END AS recordSha256')
    )
    .limit(2)) as Array<{ recordJson: string | null; recordSha256: string | null }>
  const value = values[0]
  if (values.length !== 1 || typeof value.recordJson !== 'string' || hash(value.recordJson) !== value.recordSha256)
    invalid()
  const result = copy(JSON.parse(value.recordJson) as Brc38ComposedNativeCommit, row, bindingSha256)
  if (JSON.stringify(result) !== value.recordJson) invalid()
  return result
}
/** The actual native controller supplies its genuine catalog transaction only
 * after full reconstruction. Exact replay is idempotent; a different decision
 * refuses. This SQL writer itself grants no semantic or activation authority. */
export async function writeBrc38ComposedNativeCommit(
  trx: Knex.Transaction,
  row: Row,
  build: Brc38NativeComponentBuild,
  bindingSha256: string,
  retirement: Brc38NativeRetirementRecord
): Promise<Readonly<Brc38ComposedNativeCommit>> {
  if (trx.isTransaction !== true || trx.isCompleted()) invalid()
  const selected = copy({ protocol: 'brc38-composed-native-commit/v1', retirement }, row, bindingSha256),
    previous = await readBrc38ComposedNativeCommit(trx, row, build, bindingSha256)
  if (previous !== undefined) {
    if (JSON.stringify(previous) !== JSON.stringify(selected)) invalid()
    return previous
  }
  if ((await readBrc38NativeBackend(trx, row, build))?.phase !== 'WAL') invalid()
  const json = JSON.stringify(selected)
  await trx.raw(schema)
  await trx(table).insert({ slot: 1, recordJson: json, recordSha256: hash(json) })
  const actual = await readBrc38ComposedNativeCommit(trx, row, build, bindingSha256)
  if (JSON.stringify(actual) !== json) invalid()
  return actual!
}
