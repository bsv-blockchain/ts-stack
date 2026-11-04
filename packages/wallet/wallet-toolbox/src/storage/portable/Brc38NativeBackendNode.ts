import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import type { Row } from './Brc38PublishedProfileReceiptNode'

export interface Brc38NativeComponentBuild {
  readonly platform: string
  readonly architecture: string
  readonly bytes: number
  readonly sha256: string
}
export interface Brc38NativeBackendRecord {
  readonly protocol: 'brc38-native-backend/v1'
  readonly phase: 'DELETE_ACTIVATING' | 'DELETE_ACTIVE' | 'WAL_ACTIVATING' | 'WAL'
  readonly fixedSha256: string
  readonly copySha256: string
  readonly copyBytes: number
  readonly componentBuild: Brc38NativeComponentBuild
}
const table = 'profile_native_backend'
const schema =
  'CREATE TABLE profile_native_backend(slot INTEGER PRIMARY KEY CHECK(slot=1),recordJson TEXT NOT NULL CHECK(length(CAST(recordJson AS BLOB))<=4096),recordSha256 TEXT NOT NULL CHECK(length(CAST(recordSha256 AS BLOB))=64))'
function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
async function registeredSchema(db: Knex): Promise<boolean> {
  const rows: Array<{ type: string; sql: string | null }> = await db('sqlite_schema')
    .where({ name: table })
    .orWhere({ tbl_name: table })
    .select('type', db.raw('CASE WHEN length(CAST(sql AS BLOB)) <= 8192 THEN sql ELSE NULL END AS sql'))
    .limit(2)
  if (rows.length === 0) return false
  if (rows.length !== 1 || rows[0].type !== 'table' || rows[0].sql !== schema)
    throw new Error('Native backend transition schema differs')
  return true
}
/** Stock readers refuse a forward transition before opening the wallet or changing
 * its header. Table presence alone selects no native owner or grants authority. */
export async function assertNoBrc38NativeBackend(db: Knex): Promise<void> {
  const rows = await db('sqlite_schema').where({ name: table }).select('name').limit(1)
  if (rows.length) throw new Error('Published profile requires its forward native backend policy')
}
/** Data validation only. Actual Root/profile/producer lifetime is checked separately. */
export async function readBrc38NativeBackend(
  db: Knex,
  row: Row,
  build: Brc38NativeComponentBuild
): Promise<Brc38NativeBackendRecord | undefined> {
  if (!(await registeredSchema(db))) return undefined
  const records: Array<{ recordJson: string | null; recordSha256: string | null }> = await db(table)
    .select(
      db.raw('CASE WHEN length(CAST(recordJson AS BLOB)) <= 4096 THEN recordJson ELSE NULL END AS recordJson'),
      db.raw('CASE WHEN length(CAST(recordSha256 AS BLOB)) = 64 THEN recordSha256 ELSE NULL END AS recordSha256')
    )
    .limit(2)
  if (
    records.length !== 1 ||
    typeof records[0].recordJson !== 'string' ||
    hash(records[0].recordJson) !== records[0].recordSha256
  )
    throw new Error('Native backend transition digest differs')
  const record = JSON.parse(records[0].recordJson) as Brc38NativeBackendRecord
  if (
    record.protocol !== 'brc38-native-backend/v1' ||
    !['DELETE_ACTIVATING', 'DELETE_ACTIVE', 'WAL_ACTIVATING', 'WAL'].includes(record.phase) ||
    record.fixedSha256 !== row.fixedSha256 ||
    record.copySha256 !== row.copySha256 ||
    record.copyBytes !== row.copyBytes ||
    JSON.stringify(record.componentBuild) !== JSON.stringify(build) ||
    row.state === 'RECEIVING' ||
    (record.phase !== 'DELETE_ACTIVATING' && row.state !== 'ACTIVE')
  )
    throw new Error('Native backend original receipt or phase differs')
  return Object.freeze({ ...record, componentBuild: Object.freeze({ ...record.componentBuild }) })
}
/** Called only inside the real catalog transaction by the private profile. This
 * SQL helper itself conveys no activation, session or journal authority. */
export async function writeBrc38NativeBackend(
  trx: Knex.Transaction,
  previous: Brc38NativeBackendRecord | undefined,
  record: Brc38NativeBackendRecord
): Promise<void> {
  const json = JSON.stringify(record)
  if (Buffer.byteLength(json) > 4096) throw new Error('Native backend record exceeds its fixed bound')
  if (previous === undefined) {
    if (await registeredSchema(trx)) throw new Error('Native backend transition is already registered')
    await trx.raw(schema)
    await trx(table).insert({ slot: 1, recordJson: json, recordSha256: hash(json) })
  } else {
    if (
      !(await registeredSchema(trx)) ||
      (await trx(table)
        .where({ slot: 1, recordSha256: hash(JSON.stringify(previous)) })
        .update({ recordJson: json, recordSha256: hash(json) })) !== 1
    )
      throw new Error('Native backend transition changed before commit')
  }
}
