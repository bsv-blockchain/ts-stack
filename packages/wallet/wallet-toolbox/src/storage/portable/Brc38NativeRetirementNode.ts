import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import { readBrc38NativeCatalog, brc38NativeOriginalCatalogSchema } from './Brc38NativeCatalogNode'
import { readForwardOriginalProfileRow, type Row } from './Brc38PublishedProfileReceiptNode'
import { snapshotJournalRevision, type SnapshotJournalRevision } from '../snapshot/journal/SnapshotJournalRevision'

/** Durable handoff DATA, never permission to retire a provider or select its
 * target. The owning controller must validate the genuine prepared target and
 * retain its actual source writer and manager queue before calling the writer.
 * This internal component is deliberately absent from package entry points. */
export interface Brc38NativeRetirementRecord {
  readonly protocol: 'brc38-native-retirement/v1'
  readonly decisionId: string
  readonly source: Readonly<{
    fixedSha256: string
    copySha256: string
    copyBytes: number
    epoch: string
    revision: SnapshotJournalRevision
    primaryEpoch: SnapshotJournalRevision
  }>
  readonly target: Readonly<{
    rootId: string
    profileId: string
    fixedSha256: string
    copySha256: string
    copyBytes: number
  }>
}
const schema =
  'CREATE TABLE profile_retired(slot INTEGER PRIMARY KEY CHECK(slot=1),originalSha256 TEXT NOT NULL CHECK(length(CAST(originalSha256 AS BLOB))=64),recordJson TEXT NOT NULL CHECK(length(CAST(recordJson AS BLOB))<=4096),recordSha256 TEXT NOT NULL CHECK(length(CAST(recordSha256 AS BLOB))=64))'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const digest = /^[0-9a-f]{64}$/
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
function originalDigest(row: Row): string {
  return hash(JSON.stringify([row.state, row.fixedJson, row.fixedSha256, row.copySha256, row.copyBytes]))
}
function invalid(): never {
  throw new Error('Native source retirement data or original receipt differs')
}
export function copyBrc38NativeRetirement(value: Brc38NativeRetirementRecord): Readonly<Brc38NativeRetirementRecord> {
  const source = value.source,
    target = value.target
  if (
    value.protocol !== 'brc38-native-retirement/v1' ||
    !uuid.test(value.decisionId) ||
    source === undefined ||
    target === undefined ||
    !uuid.test(source.epoch) ||
    !uuid.test(target.rootId) ||
    !uuid.test(target.profileId) ||
    ![source.fixedSha256, source.copySha256, target.fixedSha256, target.copySha256].every(
      v => typeof v === 'string' && digest.test(v)
    ) ||
    ![source.copyBytes, target.copyBytes].every(v => Number.isSafeInteger(v) && v >= 4096) ||
    source.fixedSha256 === target.fixedSha256
  )
    invalid()
  const revision = snapshotJournalRevision(source.revision),
    primaryEpoch = snapshotJournalRevision(source.primaryEpoch)
  return Object.freeze({
    protocol: value.protocol,
    decisionId: value.decisionId,
    source: Object.freeze({
      fixedSha256: source.fixedSha256,
      copySha256: source.copySha256,
      copyBytes: source.copyBytes,
      epoch: source.epoch,
      revision,
      primaryEpoch
    }),
    target: Object.freeze({
      rootId: target.rootId,
      profileId: target.profileId,
      fixedSha256: target.fixedSha256,
      copySha256: target.copySha256,
      copyBytes: target.copyBytes
    })
  })
}
async function present(db: Knex): Promise<boolean> {
  const rows = await db('sqlite_schema').where({ name: 'profile_retired' }).select('name').limit(1)
  return rows.length !== 0
}
/** Bounded durable recovery read. Invalid, empty, coexisting or changed forward
 * namespaces refuse; the old provider must never be activated from this DATA. */
export async function readBrc38NativeRetirement(db: Knex): Promise<Readonly<Brc38NativeRetirementRecord> | undefined> {
  if (!(await present(db))) return undefined
  const objects: Array<{ name: string; type: string; sql: string | null }> = await db('sqlite_schema')
    .whereIn('name', ['profile', 'profile_original', 'profile_native', 'profile_retired'])
    .orWhereIn('tbl_name', ['profile_original', 'profile_retired'])
    .select('name', 'type', db.raw('CASE WHEN length(CAST(sql AS BLOB))<=8192 THEN sql ELSE NULL END AS sql'))
    .limit(4)
  if (
    objects.length !== 2 ||
    !objects.some(
      v => v.name === 'profile_original' && v.type === 'table' && v.sql === brc38NativeOriginalCatalogSchema
    ) ||
    !objects.some(v => v.name === 'profile_retired' && v.type === 'table' && v.sql === schema)
  )
    invalid()
  const original = await readForwardOriginalProfileRow(db)
  const rows: Array<{ originalSha256: string | null; recordJson: string | null; recordSha256: string | null }> =
    await db('profile_retired')
      .where({ slot: 1 })
      .select(
        db.raw('CASE WHEN length(CAST(originalSha256 AS BLOB))=64 THEN originalSha256 ELSE NULL END AS originalSha256'),
        db.raw('CASE WHEN length(CAST(recordJson AS BLOB))<=4096 THEN recordJson ELSE NULL END AS recordJson'),
        db.raw('CASE WHEN length(CAST(recordSha256 AS BLOB))=64 THEN recordSha256 ELSE NULL END AS recordSha256')
      )
      .limit(2)
  const row = rows[0]
  if (
    rows.length !== 1 ||
    typeof row.recordJson !== 'string' ||
    hash(row.recordJson) !== row.recordSha256 ||
    original.state === 'RECEIVING' ||
    row.originalSha256 !== originalDigest(original)
  )
    invalid()
  const record = copyBrc38NativeRetirement(JSON.parse(row.recordJson) as Brc38NativeRetirementRecord)
  if (
    JSON.stringify(record) !== row.recordJson ||
    record.source.fixedSha256 !== original.fixedSha256 ||
    record.source.copySha256 !== original.copySha256 ||
    record.source.copyBytes !== original.copyBytes
  )
    invalid()
  return record
}
/** ONE catalog transaction: replace the active progress namespace with the
 * immutable retirement decision. Earlier readers cannot reopen it. A rollback
 * preserves native ACTIVE; an exact committed replay preserves the same target
 * and decision. There is no reverse migration or expiry/quota renewal. */
export async function writeBrc38NativeRetirement(
  trx: Knex.Transaction,
  selected: Brc38NativeRetirementRecord
): Promise<Readonly<Brc38NativeRetirementRecord>> {
  if (trx.isTransaction !== true || trx.isCompleted()) invalid()
  const record = copyBrc38NativeRetirement(selected),
    json = JSON.stringify(record)
  if (Buffer.byteLength(json) > 4096) invalid()
  const previous = await readBrc38NativeRetirement(trx)
  if (previous !== undefined) {
    if (JSON.stringify(previous) !== json) invalid()
    return previous
  }
  const current = await readBrc38NativeCatalog(trx),
    original = await readForwardOriginalProfileRow(trx)
  if (
    current?.state !== 'ACTIVE' ||
    record.source.fixedSha256 !== current.fixedSha256 ||
    record.source.copySha256 !== current.copySha256 ||
    record.source.copyBytes !== current.copyBytes
  )
    invalid()
  await trx.raw(schema)
  await trx('profile_retired').insert({
    slot: 1,
    originalSha256: originalDigest(original),
    recordJson: json,
    recordSha256: hash(json)
  })
  await trx.schema.dropTable('profile_native')
  const actual = await readBrc38NativeRetirement(trx)
  if (actual === undefined || JSON.stringify(actual) !== json) invalid()
  return actual
}
