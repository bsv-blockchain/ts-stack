import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import {
  readOriginalProfileRow,
  readForwardOriginalProfileRow,
  type Row,
  type State
} from './Brc38PublishedProfileReceiptNode'

// A new namespace is the minimum-reader fence. Legacy readers query only profile
// and therefore reject before opening the wallet. The original receipt stays
// immutable; no table name or data helper conveys native activation authority.
const originalSchema =
  "CREATE TABLE profile_original(slot INTEGER PRIMARY KEY CHECK(slot=1),state TEXT NOT NULL CHECK(state IN ('READY','ACTIVATING','ACTIVE')),fixedJson TEXT NOT NULL CHECK(length(CAST(fixedJson AS BLOB))<=8192),fixedSha256 TEXT NOT NULL CHECK(length(CAST(fixedSha256 AS BLOB))=64),copySha256 TEXT NOT NULL CHECK(length(CAST(copySha256 AS BLOB))=64),copyBytes INTEGER NOT NULL CHECK(copyBytes>=4096))"
export const brc38NativeOriginalCatalogSchema = originalSchema
const progressSchema =
  "CREATE TABLE profile_native(slot INTEGER PRIMARY KEY CHECK(slot=1),state TEXT NOT NULL CHECK(state IN ('ACTIVATING','ACTIVE')),originalSha256 TEXT NOT NULL CHECK(length(CAST(originalSha256 AS BLOB))=64))"
function originalDigest(row: Row): string {
  return createHash('sha256')
    .update(JSON.stringify([row.state, row.fixedJson, row.fixedSha256, row.copySha256, row.copyBytes]))
    .digest('hex')
}
async function layout(db: Knex): Promise<boolean> {
  const rows: Array<{ name: string; type: string; sql: string | null }> = await db('sqlite_schema')
    .whereIn('name', ['profile', 'profile_original', 'profile_native'])
    .orWhereIn('tbl_name', ['profile_original', 'profile_native'])
    .select('name', 'type', db.raw('CASE WHEN length(CAST(sql AS BLOB))<=8192 THEN sql ELSE NULL END AS sql'))
    .limit(4)
  if (rows.length === 1 && rows[0].name === 'profile' && rows[0].type === 'table') return false
  if (
    rows.length !== 2 ||
    !rows.some(row => row.name === 'profile_original' && row.type === 'table' && row.sql === originalSchema) ||
    !rows.some(row => row.name === 'profile_native' && row.type === 'table' && row.sql === progressSchema)
  )
    throw new Error('Native forward catalog layout differs')
  return true
}
/** Bounded data validation. Exact schemas and original receipt digest/lineage
 * are required independently of the actual Root/profile/producer lifetime. */
export async function readBrc38NativeCatalog(db: Knex): Promise<Row | undefined> {
  if (!(await layout(db))) return undefined
  const original = await readForwardOriginalProfileRow(db)
  const rows: Array<{ state: State | null; originalSha256: string | null }> = await db('profile_native')
    .where({ slot: 1 })
    .select(
      db.raw('CASE WHEN length(CAST(state AS BLOB))<=16 THEN state ELSE NULL END AS state'),
      db.raw('CASE WHEN length(CAST(originalSha256 AS BLOB))=64 THEN originalSha256 ELSE NULL END AS originalSha256')
    )
    .limit(2)
  const progress = rows[0]
  if (
    rows.length !== 1 ||
    original.state === 'RECEIVING' ||
    !['ACTIVATING', 'ACTIVE'].includes(progress?.state ?? '') ||
    progress.originalSha256 !== originalDigest(original) ||
    (original.state === 'ACTIVE' && progress.state !== 'ACTIVE')
  )
    throw new Error('Native forward progress or original receipt differs')
  return { ...original, state: progress.state! }
}
/** The private owner calls this inside its real catalog transaction, before
 * the backend record and wallet write admission. Rollback retains legacy READY. */
export async function migrateBrc38NativeCatalog(trx: Knex.Transaction, expected: Row): Promise<void> {
  if (await layout(trx)) throw new Error('Native forward catalog is already migrated')
  const original = await readOriginalProfileRow(trx)
  if (original.state === 'RECEIVING' || originalDigest(original) !== originalDigest(expected))
    throw new Error('Original receipt changed before native catalog migration')
  await trx.raw(originalSchema)
  await trx('profile_original').insert({ slot: 1, ...original })
  await trx.raw(progressSchema)
  await trx('profile_native').insert({
    slot: 1,
    state: original.state === 'ACTIVE' ? 'ACTIVE' : 'ACTIVATING',
    originalSha256: originalDigest(original)
  })
  await trx.schema.dropTable('profile')
  const migrated = await readBrc38NativeCatalog(trx)
  if (
    migrated === undefined ||
    migrated.fixedJson !== original.fixedJson ||
    migrated.copySha256 !== original.copySha256 ||
    migrated.copyBytes !== original.copyBytes
  )
    throw new Error('Native migration changed original copy lineage')
}
