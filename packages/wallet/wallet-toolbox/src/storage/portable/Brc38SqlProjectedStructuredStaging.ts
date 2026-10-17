import { visitBrc38SqlStructuredChunkWindows } from './Brc38SqlStructuredChunkWindowNode'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'
import { isBrc38OwnedPrivateNativeSqlite, isBrc38OwnedPrivateNativeWriter } from './KnexBrc38StagingStore'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { requireBrc38PackedRead } from './Brc38NativePackedSchemaNode'
import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import type { Brc38StageTable } from './Brc38SemanticStage'
import { brc38JsonStructuredField, type Brc38JsonStructuredField } from './Brc38JsonStructuredFields'
import { detachBrc38PrivateChunk } from './Brc38PrivateChunkPipe'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

const metadataTable = 'private_projected_structured_fields',
  chunksTable = 'private_projected_structured_chunks'
const metadataSql = `CREATE TABLE private_projected_structured_fields(tableName TEXT NOT NULL,position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position>=0),field TEXT NOT NULL CHECK((tableName='provenTxReqs' AND field='notify') OR (tableName='syncStates' AND field='syncMap')),encoding TEXT NOT NULL CHECK(encoding='utf8-json'),sourceBytes INTEGER NOT NULL CHECK(typeof(sourceBytes)='integer' AND sourceBytes BETWEEN 2 AND 1000000000),sourceSha256 TEXT NOT NULL CHECK(typeof(sourceSha256)='text' AND length(CAST(sourceSha256 AS BLOB))=64),maximumBytes INTEGER NOT NULL CHECK(typeof(maximumBytes)='integer' AND maximumBytes BETWEEN 2 AND 1000000000),bytes INTEGER NOT NULL CHECK(typeof(bytes)='integer' AND bytes>=0 AND bytes<=maximumBytes),chunks INTEGER NOT NULL CHECK(typeof(chunks)='integer' AND chunks>=0),state TEXT NOT NULL CHECK(state IN ('writing','complete')),sha256 TEXT CHECK((state='writing' AND sha256 IS NULL) OR (state='complete' AND bytes>=2 AND length(CAST(sha256 AS BLOB))=64)),PRIMARY KEY(tableName,position,field))`
const chunksSql = `CREATE TABLE private_projected_structured_chunks(tableName TEXT NOT NULL,position INTEGER NOT NULL,field TEXT NOT NULL,offset INTEGER NOT NULL CHECK(typeof(offset)='integer' AND offset>=0),bytes INTEGER NOT NULL CHECK(typeof(bytes)='integer' AND bytes>=1 AND bytes<=65536),payload BLOB NOT NULL CHECK(typeof(payload)='blob' AND length(payload)=bytes),sha256 TEXT NOT NULL CHECK(length(CAST(sha256 AS BLOB))=64),PRIMARY KEY(tableName,position,field,offset))`
interface FieldRow {
  tableName: Brc38StageTable
  position: number
  field: string
  encoding: Brc38JsonStructuredField['encoding']
  sourceBytes: number
  sourceSha256: string
  maximumBytes: number
  bytes: number
  chunks: number
  state: 'writing' | 'complete'
  sha256: string | null
}
interface Coordinate {
  tableName: Brc38StageTable
  position: number
  field: string
}
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
function invalid(): never {
  throw new Error('Private projected structured content or coordinate differs')
}
function integer(value: number, maximum = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) invalid()
}
function coordinate(table: Brc38StageTable, position: number, field: string): Coordinate {
  integer(position, 1000000000)
  if (
    !brc38JsonStructuredField(table, field) ||
    !((table === 'provenTxReqs' && field === 'notify') || (table === 'syncStates' && field === 'syncMap'))
  )
    invalid()
  return { tableName: table, position, field }
}
/** Derived inactive notify/sync-map projection bytes only; raw and canonical source families remain independently immutable. Completion hashes actual content; the original indexed
 * semantic validator must still check every visible value before admission.
 * Native definitions and all metadata are freshly read in the caller-owned
 * private transaction. This helper never owns a pool, profile or admission. */
const guards = [
  `CREATE TRIGGER private_projected_structured_fields_insert_guard BEFORE INSERT ON private_projected_structured_fields BEGIN SELECT CASE WHEN NEW.state!='writing' OR NEW.bytes!=0 OR NEW.chunks!=0 OR NEW.sha256 IS NOT NULL OR NOT EXISTS(SELECT 1 FROM metadata WHERE slot=1 AND state='sealed' AND 256+length(CAST(NEW.field AS BLOB))<=json_extract((SELECT limitsJson FROM private_binding WHERE slot=1),'$[1]')-logicalBytes) OR NOT EXISTS(SELECT 1 FROM private_structured_fields WHERE tableName=NEW.tableName AND position=NEW.position AND field=NEW.field AND state='complete' AND bytes=NEW.sourceBytes AND sha256=NEW.sourceSha256) OR NOT EXISTS(SELECT 1 FROM rows WHERE tableName=NEW.tableName AND position=NEW.position) THEN RAISE(ABORT,'Private projected source or original quota differs') END; END`,
  `CREATE TRIGGER private_projected_structured_fields_insert_charge AFTER INSERT ON private_projected_structured_fields BEGIN UPDATE metadata SET logicalBytes=logicalBytes+256+length(CAST(NEW.field AS BLOB)) WHERE slot=1; END`,
  `CREATE TRIGGER private_projected_structured_fields_update_guard BEFORE UPDATE ON private_projected_structured_fields BEGIN SELECT CASE WHEN NEW.tableName IS NOT OLD.tableName OR NEW.position IS NOT OLD.position OR NEW.field IS NOT OLD.field OR NEW.encoding IS NOT OLD.encoding OR NEW.sourceBytes IS NOT OLD.sourceBytes OR NEW.sourceSha256 IS NOT OLD.sourceSha256 OR NEW.maximumBytes IS NOT OLD.maximumBytes OR NOT ((OLD.state='writing' AND NEW.state='writing' AND NEW.bytes=OLD.bytes+(SELECT bytes FROM private_projected_structured_chunks WHERE tableName=OLD.tableName AND position=OLD.position AND field=OLD.field AND offset=OLD.bytes) AND NEW.chunks=OLD.chunks+1 AND NEW.sha256 IS NULL) OR (OLD.state='writing' AND NEW.state='complete' AND NEW.bytes=OLD.bytes AND NEW.chunks=OLD.chunks)) THEN RAISE(ABORT,'Private projection identity or completion differs') END; END`,
  `CREATE TRIGGER private_projected_structured_fields_delete_guard BEFORE DELETE ON private_projected_structured_fields BEGIN SELECT RAISE(ABORT,'Private projected content requires owned source retirement'); END`,
  `CREATE TRIGGER private_projected_structured_chunks_insert_guard BEFORE INSERT ON private_projected_structured_chunks BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM private_projected_structured_fields WHERE tableName=NEW.tableName AND position=NEW.position AND field=NEW.field AND state='writing' AND bytes=NEW.offset AND NEW.bytes<=maximumBytes-bytes) OR NOT EXISTS(SELECT 1 FROM metadata WHERE slot=1 AND state='sealed' AND NEW.bytes+128<=json_extract((SELECT limitsJson FROM private_binding WHERE slot=1),'$[1]')-logicalBytes) THEN RAISE(ABORT,'Private projection prefix or original quota differs') END; END`,
  `CREATE TRIGGER private_projected_structured_chunks_insert_charge AFTER INSERT ON private_projected_structured_chunks BEGIN UPDATE private_projected_structured_fields SET bytes=bytes+NEW.bytes,chunks=chunks+1 WHERE tableName=NEW.tableName AND position=NEW.position AND field=NEW.field; UPDATE metadata SET logicalBytes=logicalBytes+NEW.bytes+128 WHERE slot=1; END`,
  `CREATE TRIGGER private_projected_structured_chunks_update_guard BEFORE UPDATE ON private_projected_structured_chunks BEGIN SELECT RAISE(ABORT,'Private projected chunk postimages are immutable'); END`,
  `CREATE TRIGGER private_projected_structured_chunks_delete_guard BEFORE DELETE ON private_projected_structured_chunks BEGIN SELECT RAISE(ABORT,'Private projected chunks require owned source retirement'); END`
]
async function schema(k: Knex, create = false): Promise<boolean> {
  requireBrc38PackedRead(k as Knex.Transaction)
  await verifyBrc38AuthenticatedSourceSeal(k)
  const total = (await k('sqlite_schema')
    .whereIn('tbl_name', [metadataTable, chunksTable])
    .count({ count: '*' })
    .first()) as { count: unknown } | undefined
  if (total?.count === 0) {
    if (!create) return false
    if (!isBrc38OwnedPrivateNativeWriter(k as Knex.Transaction)) invalid()
    await k.raw(metadataSql)
    await k.raw(chunksSql)
    for (const sql of guards) await k.raw(sql)
    return await schema(k)
  }
  if (total?.count !== 4 + guards.length) invalid()
  for (const [name, type, sql] of [
    [metadataTable, 'table', metadataSql],
    [chunksTable, 'table', chunksSql],
    ...guards.map(sql => [sql.split(' ')[2], 'trigger', sql])
  ]) {
    requireBrc38PackedRead(k as Knex.Transaction)
    const actual = (await k('sqlite_schema')
      .where({ name, type })
      .whereRaw('CAST(sql AS BLOB)=CAST(? AS BLOB)', [sql])
      .count({ count: '*' })
      .first()) as { count: unknown } | undefined
    if (actual?.count !== 1) invalid()
  }
  const indexes = (await k('sqlite_schema')
    .where({ type: 'index' })
    .whereNull('sql')
    .whereIn('tbl_name', [metadataTable, chunksTable])
    .whereIn('name', [`sqlite_autoindex_${metadataTable}_1`, `sqlite_autoindex_${chunksTable}_1`])
    .count({ count: '*' })
    .first()) as { count: unknown } | undefined
  if (indexes?.count !== 2) invalid()
  return true
}
async function metadata(k: Knex, selected: Coordinate): Promise<FieldRow> {
  const rows: FieldRow[] = await k(metadataTable)
    .where(selected)
    .select(
      'tableName',
      'position',
      'field',
      'encoding',
      'sourceBytes',
      k.raw('CASE WHEN length(CAST(sourceSha256 AS BLOB))=64 THEN sourceSha256 ELSE NULL END AS sourceSha256'),
      'maximumBytes',
      'bytes',
      'chunks',
      'state',
      k.raw('CASE WHEN length(CAST(sha256 AS BLOB))=64 THEN sha256 ELSE NULL END AS sha256')
    )
    .limit(2)
  if (rows.length !== 1) invalid()
  const row = rows[0]
  integer(row.sourceBytes, 1000000000)
  if (row.sourceBytes < 2 || typeof row.sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(row.sourceSha256)) invalid()
  integer(row.maximumBytes, 1000000000)
  integer(row.bytes, row.maximumBytes)
  integer(row.chunks)
  if (row.maximumBytes < 2) invalid()
  if (
    row.tableName !== selected.tableName ||
    row.position !== selected.position ||
    row.field !== selected.field ||
    row.encoding !== 'utf8-json' ||
    (row.bytes === 0) !== (row.chunks === 0) ||
    row.chunks > row.bytes ||
    (row.state !== 'writing' && row.state !== 'complete') ||
    (row.state === 'complete' && row.bytes < 2) ||
    (row.state === 'writing'
      ? row.sha256 !== null
      : typeof row.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(row.sha256))
  )
    invalid()
  return row
}
/** Install only during the explicit fresh private receiver migration, before
 * its destination generation/schema receipt is captured. Preparation cannot
 * lazily change a destination's admitted schema. */
export async function installBrc38SqlProjectedStructuredSchema(k: Knex.Transaction): Promise<void> {
  if (!isBrc38OwnedPrivateNativeWriter(k) || (await schema(k))) invalid()
  if (!(await schema(k, true))) invalid()
}
/** Actual exact-schema inspection only. It grants no source, writer, profile
 * or semantic admission and never creates an absent projection family. */
export async function hasBrc38SqlProjectedStructuredSchema(k: Knex.Transaction): Promise<boolean> {
  return await schema(k)
}
interface Counters {
  state: string
  logicalBytes: number
  rows: number
}
async function counters(k: Knex, maximum: number): Promise<Counters> {
  const row = await k<Counters & { slot: number }>('metadata').where({ slot: 1 }).first('state', 'logicalBytes', 'rows')
  if (row === undefined || (row.state !== 'staging' && row.state !== 'sealed')) invalid()
  integer(row.logicalBytes, maximum)
  integer(row.rows, 1000000000)
  return row
}
async function chunk(k: Knex, selected: Coordinate, offset: number): Promise<Uint8Array | undefined> {
  const key = { ...selected, offset }
  const extent = (await k(chunksTable)
    .where(key)
    .first(
      'bytes',
      k.raw('length(payload) AS actualBytes'),
      k.raw('typeof(payload) AS kind'),
      k.raw('CASE WHEN length(CAST(sha256 AS BLOB))=64 THEN sha256 ELSE NULL END AS sha256')
    )) as { bytes: number; actualBytes: number; kind: string; sha256: string | null } | undefined
  if (extent === undefined) return undefined
  integer(extent.bytes, 65536)
  if (
    extent.bytes === 0 ||
    extent.kind !== 'blob' ||
    extent.actualBytes !== extent.bytes ||
    typeof extent.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(extent.sha256)
  )
    invalid()
  // Actual native byte/type preflight precedes fetching the one <=64KiB cell.
  const value = (await k(chunksTable).where(key).first('payload')) as { payload: Buffer } | undefined
  if (
    value === undefined ||
    !Buffer.isBuffer(value.payload) ||
    value.payload.byteLength !== extent.bytes ||
    sha(value.payload) !== extent.sha256
  )
    invalid()
  return Uint8Array.from(value.payload)
}
export async function beginBrc38SqlProjectedStructuredField(
  k: Knex.Transaction,
  table: Brc38StageTable,
  position: number,
  field: string,
  encoding: Brc38JsonStructuredField['encoding'],
  maximumBytes: number,
  maximumLogicalBytes: number,
  maximumRows: number,
  source: Brc38JsonStructuredField
): Promise<void> {
  if (!isBrc38OwnedPrivateNativeWriter(k)) invalid()
  const selected = coordinate(table, position, field)
  const sourceBytes = source.bytes,
    sourceSha256 = source.sha256
  if (
    source.field !== field ||
    source.encoding !== 'utf8-json' ||
    !Number.isSafeInteger(sourceBytes) ||
    sourceBytes < 2 ||
    sourceBytes > 1000000000 ||
    !/^[0-9a-f]{64}$/.test(sourceSha256)
  )
    invalid()
  integer(maximumBytes, maximumLogicalBytes)
  if (maximumBytes < 2 || maximumBytes > 1000000000)
    throw new SnapshotResourceLimitError('Private structured object cannot fit its selected byte policy')
  if (encoding !== 'utf8-json') invalid()
  const meta = await counters(k, maximumLogicalBytes)
  if (!(await schema(k))) invalid()
  const existing = await k(metadataTable).where(selected).first('field')
  if (existing !== undefined) {
    const prior = await metadata(k, selected)
    if (
      prior.maximumBytes !== maximumBytes ||
      prior.encoding !== encoding ||
      prior.sourceBytes !== sourceBytes ||
      prior.sourceSha256 !== sourceSha256
    )
      invalid()
    return
  }
  if (meta.state !== 'sealed') invalid()
  integer(maximumRows, 1000000000)
  if (meta.rows > maximumRows) throw new SnapshotResourceLimitError('Private projected source row quota differs')
  const count = (await k('table_counts').where({ tableName: table }).first('rows')) as { rows: number } | undefined
  if (count === undefined || !Number.isSafeInteger(count.rows) || position >= count.rows) invalid()
  // The field's maximum is immutable DATA for exact replay, never a new lease.
  await k(metadataTable).insert({
    ...selected,
    encoding,
    sourceBytes,
    sourceSha256,
    maximumBytes,
    bytes: 0,
    chunks: 0,
    state: 'writing',
    sha256: null
  })
}
export async function appendBrc38SqlProjectedStructuredField(
  k: Knex.Transaction,
  table: Brc38StageTable,
  position: number,
  field: string,
  offset: number,
  input: Uint8Array,
  maximumLogicalBytes: number
): Promise<void> {
  if (!isBrc38OwnedPrivateNativeWriter(k)) invalid()
  const selected = coordinate(table, position, field)
  integer(offset)
  if (!(await schema(k))) invalid()
  const prior = await metadata(k, selected),
    meta = await counters(k, maximumLogicalBytes)
  if (meta.state !== 'sealed') invalid()
  const bytes = Buffer.from(detachBrc38PrivateChunk(input, 65536))
  if (bytes.byteLength < 1 || bytes.byteLength > 65536) invalid()
  if (offset < prior.bytes) {
    const actual = await chunk(k, selected, offset)
    if (actual === undefined || actual.byteLength !== bytes.byteLength || !Buffer.from(actual).equals(bytes)) invalid()
    return
  }
  if (prior.state !== 'writing' || offset !== prior.bytes) invalid()
  if (bytes.byteLength > prior.maximumBytes - prior.bytes)
    throw new SnapshotResourceLimitError('Private structured field byte quota reached')
  await k(chunksTable).insert({ ...selected, offset, bytes: bytes.byteLength, payload: bytes, sha256: sha(bytes) })
  const after = await metadata(k, selected)
  if (after.bytes !== prior.bytes + bytes.byteLength || after.chunks !== prior.chunks + 1) invalid()
}
export async function finishBrc38SqlProjectedStructuredField(
  k: Knex.Transaction,
  table: Brc38StageTable,
  position: number,
  expected: Brc38JsonStructuredField,
  assertActive: () => void,
  maximumReadBytes?: number
): Promise<void> {
  if (!isBrc38OwnedPrivateNativeWriter(k)) invalid()
  const selected = coordinate(table, position, expected.field),
    prior = await verifiedCompleteContent(k, table, position, expected, assertActive, maximumReadBytes)
  if (prior.state === 'complete') {
    if (prior.sha256 !== expected.sha256) invalid()
    return
  }
  if (
    (await k(metadataTable)
      .where({ ...selected, state: 'writing', bytes: prior.bytes, chunks: prior.chunks })
      .update({ state: 'complete', sha256: expected.sha256 })) !== 1
  )
    invalid()
  assertActive()
}
/** Current owned READ hashes immutable chunk postimages, drains, then a short
 * owned writer completes their unchanged metadata. Exact current SQL guards
 * forbid chunk replacement/deletion and admit append-only prefixes; the
 * metadata comparison rejects an append after the read. This operation never
 * returns a reusable completion proof or authorizes another source/profile. */
export async function completeBrc38SqlProjectedStructuredField(
  store: KnexBrc38StagingStore,
  withRead: <T>(operation: (trx: Knex.Transaction) => Promise<T>) => Promise<T>,
  withWrite: <T>(operation: (trx: Knex.Transaction) => Promise<T>) => Promise<T>,
  table: Brc38StageTable,
  position: number,
  selected: Brc38JsonStructuredField,
  assertActive: () => void,
  maximumReadBytes: number
): Promise<void> {
  assertActive()
  store.assertPrivateNativeDestination(store.knex)
  if (!isBrc38OwnedPrivateNativeSqlite(store.knex)) invalid()
  const expected = Object.freeze({
      field: selected.field,
      encoding: selected.encoding,
      bytes: selected.bytes,
      sha256: selected.sha256
    }),
    key = coordinate(table, position, expected.field)
  if (!Number.isSafeInteger(maximumReadBytes) || maximumReadBytes < 1 || maximumReadBytes > 65536) invalid()
  const prior = await withRead(async trx => {
    assertActive()
    store.assertPrivateNativeReadTransaction(trx)
    const value = await verifiedCompleteContent(trx, table, position, expected, assertActive, maximumReadBytes)
    if (JSON.stringify(await metadata(trx, key)) !== JSON.stringify(value)) invalid()
    store.assertPrivateNativeReadTransaction(trx)
    assertActive()
    return Object.freeze({ ...value })
  })
  if (prior === undefined) invalid()
  await withWrite(async trx => {
    assertActive()
    store.assertPrivateNativeWriteTransaction(trx)
    if (!isBrc38OwnedPrivateNativeWriter(trx) || !(await schema(trx))) invalid()
    const current = await metadata(trx, key)
    if (JSON.stringify(current) !== JSON.stringify(prior)) invalid()
    if (current.state === 'complete') {
      if (current.sha256 !== expected.sha256) invalid()
    } else if (
      (await trx(metadataTable)
        .where({
          ...key,
          state: 'writing',
          bytes: prior.bytes,
          chunks: prior.chunks,
          sourceBytes: prior.sourceBytes,
          sourceSha256: prior.sourceSha256
        })
        .update({ state: 'complete', sha256: expected.sha256 })) !== 1
    )
      invalid()
    const after = await metadata(trx, key)
    if (
      after.state !== 'complete' ||
      after.bytes !== expected.bytes ||
      after.sha256 !== expected.sha256 ||
      after.chunks !== prior.chunks
    )
      invalid()
    store.assertPrivateNativeWriteTransaction(trx)
    assertActive()
  })
}
/** Read-only complete-content proof under a genuine retained packed actor.
 * It never changes a writing field or supplies writer/semantic admission. */
export async function verifyBrc38SqlProjectedStructuredCompleteField(
  k: Knex.Transaction,
  table: Brc38StageTable,
  position: number,
  expected: Brc38JsonStructuredField,
  assertActive: () => void,
  maximumReadBytes?: number
): Promise<void> {
  requireBrc38PackedRead(k)
  const prior = await verifiedCompleteContent(k, table, position, expected, assertActive, maximumReadBytes)
  if (prior.state !== 'complete' || prior.sha256 !== expected.sha256) invalid()
  const current = await metadata(k, coordinate(table, position, expected.field))
  if (JSON.stringify(current) !== JSON.stringify(prior)) invalid()
  requireBrc38PackedRead(k)
  assertActive()
}
async function verifiedCompleteContent(
  k: Knex.Transaction,
  table: Brc38StageTable,
  position: number,
  expected: Brc38JsonStructuredField,
  assertActive: () => void,
  maximumReadBytes?: number
): Promise<FieldRow> {
  const selected = coordinate(table, position, expected.field)
  if (!Number.isSafeInteger(expected.bytes) || expected.bytes < 2 || expected.bytes > 1000000000) invalid()
  if (!(await schema(k))) invalid()
  const prior = await metadata(k, selected)
  if (prior.encoding !== expected.encoding || prior.bytes !== expected.bytes || !/^[0-9a-f]{64}$/.test(expected.sha256))
    invalid()
  const aggregate = (await k(chunksTable).where(selected).count({ count: '*' }).sum({ bytes: 'bytes' }).first()) as
    { count: number; bytes: number | null } | undefined
  if (aggregate === undefined || aggregate.count !== prior.chunks || (aggregate.bytes ?? 0) !== prior.bytes) invalid()
  assertActive()
  const digest = createHash('sha256')
  let offset = 0
  for (let index = 0; index < prior.chunks; index++) {
    assertActive()
    if (maximumReadBytes === undefined) {
      const actual = await chunk(k, selected, offset)
      if (actual === undefined || actual.byteLength > prior.bytes - offset) invalid()
      digest.update(actual)
      offset += actual.byteLength
    } else {
      const actual = await visitBrc38SqlStructuredChunkWindows(
        k,
        chunksTable,
        { ...selected, offset },
        maximumReadBytes,
        assertActive,
        bytes => {
          digest.update(bytes)
        }
      )
      if (actual.bytes > prior.bytes - offset) invalid()
      offset += actual.bytes
    }
    if (index % 64 === 63) await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
  if (
    offset !== prior.bytes ||
    digest.digest('hex') !== expected.sha256 ||
    (await k(chunksTable).where(selected).where('offset', '>=', offset).first('offset')) !== undefined
  )
    invalid()
  assertActive()
  return prior
}
export async function readBrc38SqlProjectedStructuredChunk(
  k: Knex,
  table: Brc38StageTable,
  position: number,
  field: string,
  offset: number
): Promise<Readonly<{ descriptor: Brc38JsonStructuredField; offset: number; bytes: Uint8Array }> | undefined> {
  const selected = coordinate(table, position, field)
  integer(offset)
  if (!(await schema(k))) return undefined
  const actual = await metadata(k, selected)
  if (actual.state !== 'complete' || actual.sha256 === null || offset > actual.bytes) invalid()
  if (offset === actual.bytes) return undefined
  const bytes = await chunk(k, selected, offset)
  if (bytes === undefined || bytes.byteLength > actual.bytes - offset) invalid()
  return Object.freeze({
    descriptor: Object.freeze({ field, encoding: actual.encoding, bytes: actual.bytes, sha256: actual.sha256 }),
    offset,
    bytes
  })
}
/** One exact arbitrary range, detached from independently verified physical
 * chunks in this actual private view. Expected length/hash are comparison DATA;
 * the enclosing real store still checks owner/schema/expiry and source scope. */
export async function readBrc38SqlProjectedStructuredRange(
  k: Knex,
  table: Brc38StageTable,
  position: number,
  field: string,
  offset: number,
  length: number,
  selected: Brc38JsonStructuredField,
  maximumReadBytes?: number,
  assertActive: () => void = () => {}
): Promise<Uint8Array> {
  if (maximumReadBytes !== undefined) requireBrc38PackedRead(k as Knex.Transaction)
  const expected = {
      field: selected.field,
      encoding: selected.encoding,
      bytes: selected.bytes,
      sha256: selected.sha256
    },
    coordinate_ = coordinate(table, position, field)
  integer(offset, 1000000000)
  integer(length, 65536)
  if (
    maximumReadBytes !== undefined &&
    (!Number.isSafeInteger(maximumReadBytes) ||
      maximumReadBytes < 1 ||
      maximumReadBytes > 65536 ||
      length > maximumReadBytes)
  )
    invalid()
  if (
    length < 1 ||
    expected.field !== field ||
    expected.encoding !== 'utf8-json' ||
    !Number.isSafeInteger(expected.bytes) ||
    expected.bytes < 2 ||
    expected.bytes > 1000000000 ||
    offset > expected.bytes - length ||
    !/^[0-9a-f]{64}$/.test(expected.sha256) ||
    !(await schema(k))
  )
    invalid()
  const current = async () => {
    const value = await metadata(k, coordinate_)
    if (
      value.state !== 'complete' ||
      value.bytes !== expected.bytes ||
      value.sha256 !== expected.sha256 ||
      value.encoding !== expected.encoding
    )
      invalid()
  }
  await current()
  const result = new Uint8Array(length)
  try {
    for (let used = 0; used < length;) {
      const at = offset + used,
        prior = (await k(chunksTable)
          .where(coordinate_)
          .where('offset', '<=', at)
          .select('offset')
          .orderBy('offset', 'desc')
          .limit(1)
          .first()) as { offset: number } | undefined
      if (prior === undefined || !Number.isSafeInteger(prior.offset) || prior.offset < 0 || prior.offset > at) invalid()
      const inside = at - prior.offset
      if (maximumReadBytes === undefined) {
        const value = await chunk(k, coordinate_, prior.offset)
        if (value === undefined || inside >= value.length) invalid()
        const count = Math.min(value.length - inside, length - used)
        result.set(value.subarray(inside, inside + count), used)
        used += count
      } else {
        const remaining = length - used
        let copied = 0
        const actual = await visitBrc38SqlStructuredChunkWindows(
          k as Knex.Transaction,
          chunksTable,
          { ...coordinate_, offset: prior.offset },
          maximumReadBytes,
          assertActive,
          (bytes, start) => {
            const low = Math.max(inside, start),
              high = Math.min(inside + remaining, start + bytes.byteLength)
            if (high > low) {
              result.set(bytes.subarray(low - start, high - start), used + low - inside)
              copied += high - low
            }
          }
        )
        if (inside >= actual.bytes || copied !== Math.min(actual.bytes - inside, remaining)) invalid()
        used += copied
      }
    }
    await current()
    return result
  } catch (error) {
    result.fill(0)
    throw error
  }
}
/** Explicit integration fence: private field staging cannot silently become a
 * legacy row import with missing structured values. Remove only with real field-aware
 * semantic/receiver/native activation integration, never from passing framing. */
export async function assertNoBrc38SqlProjectedStructuredFields(k: Knex): Promise<void> {
  if ((await schema(k)) && (await k(metadataTable).first('field')) !== undefined)
    throw new Error('Streamed structured fields require indexed semantic validation and native import activation')
}

export async function readBrc38SqlProjectedStructuredDescriptors(
  k: Knex,
  table: Brc38StageTable,
  position: number
): Promise<Readonly<Record<string, Brc38JsonStructuredField>>> {
  integer(position, 1000000000)
  const result: Record<string, Brc38JsonStructuredField> = Object.create(null)
  if (!(await schema(k))) return Object.freeze(result)
  const fields: Array<{ field: string }> = await k(metadataTable)
    .where({ tableName: table, position })
    .select('field')
    .orderBy('field')
    .limit(4)
  if (fields.length > 3) invalid()
  for (const { field } of fields) {
    const selected = coordinate(table, position, field),
      row = await metadata(k, selected)
    if (row.state !== 'complete' || row.sha256 === null) invalid()
    result[field] = Object.freeze({ field, encoding: row.encoding, bytes: row.bytes, sha256: row.sha256 })
  }
  return Object.freeze(result)
}
export async function verifyBrc38SqlProjectedStructuredDescriptors(
  k: Knex.Transaction,
  table: Brc38StageTable,
  position: number,
  expected: Readonly<Record<string, Brc38JsonStructuredField>>,
  assertActive: () => void
): Promise<void> {
  const actual = await readBrc38SqlProjectedStructuredDescriptors(k, table, position),
    names = Object.keys(expected)
  if (names.length > 3 || names.length !== Object.keys(actual).length) invalid()
  for (const field of names) {
    const value = expected[field],
      stored = actual[field]
    if (
      stored === undefined ||
      value.field !== field ||
      value.encoding !== stored.encoding ||
      value.bytes !== stored.bytes ||
      value.sha256 !== stored.sha256
    )
      invalid()
    // Metadata/digest equality is DATA, so independently read persisted content
    // again in this actual writer before row/semantic-seal admission.
    await finishBrc38SqlProjectedStructuredField(k, table, position, value, assertActive)
  }
}
export async function verifyAllBrc38SqlProjectedStructuredFields(
  k: Knex.Transaction,
  maximumRows: number,
  assertActive: () => void
): Promise<void> {
  if (!(await schema(k))) return
  let after: Coordinate | undefined,
    examined = 0
  for (;;) {
    assertActive()
    const query = k(metadataTable)
      .select('tableName', 'position', 'field')
      .orderBy('tableName')
      .orderBy('position')
      .orderBy('field')
      .limit(1)
    if (after !== undefined)
      query.whereRaw(
        '(tableName > ? OR (tableName = ? AND position > ?) OR (tableName = ? AND position = ? AND field > ?))',
        [after.tableName, after.tableName, after.position, after.tableName, after.position, after.field]
      )
    const value = (await query).at(0) as Coordinate | undefined
    if (value === undefined) return
    if (++examined > maximumRows * 3) invalid()
    const selected = coordinate(value.tableName, value.position, value.field),
      row = await metadata(k, selected)
    if (
      row.state !== 'complete' ||
      row.sha256 === null ||
      (await k('rows').where({ tableName: row.tableName, position: row.position }).first('position')) === undefined
    )
      invalid()
    await finishBrc38SqlProjectedStructuredField(
      k,
      row.tableName,
      row.position,
      { field: row.field, encoding: row.encoding, bytes: row.bytes, sha256: row.sha256 },
      assertActive
    )
    after = selected
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
}

/** Binding is comparison DATA. Callers also regenerate canonical output from
 * actual raw bytes and compare each persisted output extent on every replay. */
export async function verifyBrc38SqlProjectedStructuredSource(
  k: Knex,
  table: Brc38StageTable,
  position: number,
  source: Brc38JsonStructuredField
): Promise<void> {
  if (!(await schema(k))) invalid()
  const row = await metadata(k, coordinate(table, position, source.field))
  if (row.sourceBytes !== source.bytes || row.sourceSha256 !== source.sha256 || source.encoding !== row.encoding)
    invalid()
}
