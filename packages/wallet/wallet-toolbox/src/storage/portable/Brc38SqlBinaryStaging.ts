import { readBrc38SqlFieldSchemaCounts } from './Brc38SqlFieldSchemaBatch'
import { verifyBrc38SourceSealFieldDefinitions } from './Brc38AuthenticatedSourceSealNode'
import {
  installBrc38SqlStructuredPrefixGuards,
  verifyBrc38SqlStructuredPrefixGuards,
  readBrc38SqlPrefixSchemaVersion
} from './Brc38SqlStructuredPrefixGuards'
import { visitBrc38SqlProvisionalStructuredChunkWindows } from './Brc38SqlStructuredChunkWindowNode'
import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import type { Brc38StageTable } from './Brc38SemanticStage'
import { brc38JsonBinaryField, type Brc38JsonStreamedField } from './Brc38JsonBinaryFields'
import { detachBrc38PrivateChunk } from './Brc38PrivateChunkPipe'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

const metadataTable = 'private_binary_fields',
  chunksTable = 'private_binary_chunks'
const metadataSql = `CREATE TABLE private_binary_fields(tableName TEXT NOT NULL,position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position>=0),field TEXT NOT NULL CHECK(length(CAST(field AS BLOB))<=128),encoding TEXT NOT NULL CHECK(encoding IN ('base64','number-array')),maximumBytes INTEGER NOT NULL CHECK(typeof(maximumBytes)='integer' AND maximumBytes>=0),bytes INTEGER NOT NULL CHECK(typeof(bytes)='integer' AND bytes>=0 AND bytes<=maximumBytes),chunks INTEGER NOT NULL CHECK(typeof(chunks)='integer' AND chunks>=0),state TEXT NOT NULL CHECK(state IN ('writing','complete')),sha256 TEXT CHECK((state='writing' AND sha256 IS NULL) OR (state='complete' AND length(CAST(sha256 AS BLOB))=64)),PRIMARY KEY(tableName,position,field))`
const chunksSql = `CREATE TABLE private_binary_chunks(tableName TEXT NOT NULL,position INTEGER NOT NULL,field TEXT NOT NULL,offset INTEGER NOT NULL CHECK(typeof(offset)='integer' AND offset>=0),bytes INTEGER NOT NULL CHECK(typeof(bytes)='integer' AND bytes>=1 AND bytes<=65536),payload BLOB NOT NULL CHECK(typeof(payload)='blob' AND length(payload)=bytes),sha256 TEXT NOT NULL CHECK(length(CAST(sha256 AS BLOB))=64),PRIMARY KEY(tableName,position,field,offset))`
interface FieldRow {
  tableName: Brc38StageTable
  position: number
  field: string
  encoding: Brc38JsonStreamedField['encoding']
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
  throw new Error('Private binary staging content or coordinate differs')
}
function integer(value: number, maximum = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) invalid()
}
function coordinate(table: Brc38StageTable, position: number, field: string): Coordinate {
  integer(position, 1000000000)
  if (!brc38JsonBinaryField(table, field)) invalid()
  return { tableName: table, position, field }
}
/** Native definitions and all metadata are freshly read in the caller-owned
 * private transaction. This helper never owns a pool, profile or admission. */
async function schema(k: Knex, create = false): Promise<boolean> {
  const actual = await readBrc38SqlFieldSchemaCounts(k, 'binary', [
    [metadataTable, metadataSql],
    [chunksTable, chunksSql]
  ])
  if (actual.total === 0) {
    if (!create) return false
    if (!(k as Knex.Transaction).isTransaction) invalid()
    await k.raw(metadataSql)
    await k.raw(chunksSql)
    await installBrc38SqlStructuredPrefixGuards(k as Knex.Transaction, 'binary')
    return await schema(k)
  }
  if ((actual.sealCount !== 0 && actual.sealCount !== 6) || actual.sealMatches !== actual.sealCount) {
    // Keep the original failure identity; the scalar result never grants admission.
    await verifyBrc38SourceSealFieldDefinitions(k, 'binary')
    invalid()
  }
  if (actual.prefixMatches !== 6) {
    await verifyBrc38SqlStructuredPrefixGuards(k, 'binary')
    invalid()
  }
  if (actual.total !== 10 + actual.sealCount || actual.baseMatches !== 4) invalid()
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
      'maximumBytes',
      'bytes',
      'chunks',
      'state',
      k.raw('CASE WHEN length(CAST(sha256 AS BLOB))=64 THEN sha256 ELSE NULL END AS sha256')
    )
    .limit(2)
  if (rows.length !== 1) invalid()
  const row = rows[0]
  integer(row.maximumBytes)
  integer(row.bytes, row.maximumBytes)
  integer(row.chunks)
  if (
    row.tableName !== selected.tableName ||
    row.position !== selected.position ||
    row.field !== selected.field ||
    row.encoding !== (row.field === 'noSendExpiryReclaimRawTx' ? 'number-array' : 'base64') ||
    (row.bytes === 0) !== (row.chunks === 0) ||
    row.chunks > row.bytes ||
    (row.state !== 'writing' && row.state !== 'complete') ||
    (row.state === 'writing'
      ? row.sha256 !== null
      : typeof row.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(row.sha256))
  )
    invalid()
  return row
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
async function charge(k: Knex.Transaction, previous: Counters, bytes: number, maximum: number): Promise<void> {
  if (previous.state !== 'staging') invalid()
  if (bytes > maximum - previous.logicalBytes)
    throw new SnapshotResourceLimitError('Private binary staging logical quota reached')
  if (
    (await k('metadata')
      .where({ slot: 1, state: 'staging', logicalBytes: previous.logicalBytes })
      .update({ logicalBytes: previous.logicalBytes + bytes })) !== 1
  )
    invalid()
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
export async function beginBrc38SqlBinaryField(
  k: Knex.Transaction,
  table: Brc38StageTable,
  position: number,
  field: string,
  encoding: Brc38JsonStreamedField['encoding'],
  maximumBytes: number,
  maximumLogicalBytes: number,
  maximumRows: number
): Promise<void> {
  const selected = coordinate(table, position, field)
  integer(maximumBytes, maximumLogicalBytes)
  if (encoding !== (field === 'noSendExpiryReclaimRawTx' ? 'number-array' : 'base64')) invalid()
  const meta = await counters(k, maximumLogicalBytes)
  await schema(k, true)
  const existing = await k(metadataTable).where(selected).first('field')
  if (existing !== undefined) {
    const prior = await metadata(k, selected)
    if (prior.maximumBytes !== maximumBytes || prior.encoding !== encoding) invalid()
    return
  }
  if (meta.state !== 'staging') invalid()
  if (meta.rows >= maximumRows) throw new SnapshotResourceLimitError('Private binary staging row quota reached')
  const count = (await k('table_counts').where({ tableName: table }).first('rows')) as { rows: number } | undefined
  if (count?.rows !== position) invalid()
  // The field's maximum is immutable DATA for exact replay, never a new lease.
  await charge(k, meta, 256 + Buffer.byteLength(field), maximumLogicalBytes)
  await k(metadataTable).insert({
    ...selected,
    encoding,
    maximumBytes,
    bytes: 0,
    chunks: 0,
    state: 'writing',
    sha256: null
  })
}
export async function appendBrc38SqlBinaryField(
  k: Knex.Transaction,
  table: Brc38StageTable,
  position: number,
  field: string,
  offset: number,
  input: Uint8Array,
  maximumLogicalBytes: number
): Promise<void> {
  const selected = coordinate(table, position, field)
  integer(offset)
  if (!(await schema(k))) invalid()
  const prior = await metadata(k, selected),
    meta = await counters(k, maximumLogicalBytes)
  if (meta.state === 'sealed' && prior.state !== 'complete') invalid()
  const bytes = Buffer.from(detachBrc38PrivateChunk(input, 65536))
  if (bytes.byteLength < 1 || bytes.byteLength > 65536) invalid()
  if (offset < prior.bytes) {
    const actual = await chunk(k, selected, offset)
    if (actual === undefined || actual.byteLength !== bytes.byteLength || !Buffer.from(actual).equals(bytes)) invalid()
    return
  }
  if (prior.state !== 'writing' || offset !== prior.bytes) invalid()
  if (bytes.byteLength > prior.maximumBytes - prior.bytes)
    throw new SnapshotResourceLimitError('Private binary field byte quota reached')
  await charge(k, meta, bytes.byteLength + 128, maximumLogicalBytes)
  await k(chunksTable).insert({ ...selected, offset, bytes: bytes.byteLength, payload: bytes, sha256: sha(bytes) })
  if (
    (await k(metadataTable)
      .where({ ...selected, state: 'writing', bytes: prior.bytes, chunks: prior.chunks })
      .update({ bytes: prior.bytes + bytes.byteLength, chunks: prior.chunks + 1 })) !== 1
  )
    invalid()
}
export async function finishBrc38SqlBinaryField(
  k: Knex.Transaction,
  table: Brc38StageTable,
  position: number,
  expected: Brc38JsonStreamedField,
  assertActive: () => void
): Promise<void> {
  const prior = await verifyCompleteContent(k, table, position, expected, assertActive)
  await markComplete(k, coordinate(table, position, expected.field), prior, expected, assertActive)
}
async function verifyCompleteContent(
  k: Knex.Transaction,
  table: Brc38StageTable,
  position: number,
  expected: Brc38JsonStreamedField,
  assertActive: () => void,
  maximumReadBytes?: number
): Promise<FieldRow> {
  const selected = coordinate(table, position, expected.field)
  integer(expected.bytes)
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
      try {
        digest.update(actual)
        offset += actual.byteLength
      } finally {
        actual.fill(0)
      }
    } else {
      const actual = await visitBrc38SqlProvisionalStructuredChunkWindows(
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
  if (
    (prior.state === 'complete' && prior.sha256 !== expected.sha256) ||
    JSON.stringify(await metadata(k, selected)) !== JSON.stringify(prior)
  )
    invalid()
  return prior
}
async function markComplete(
  k: Knex.Transaction,
  selected: Coordinate,
  prior: FieldRow,
  expected: Brc38JsonStreamedField,
  assertActive: () => void
): Promise<void> {
  assertActive()
  if (!(await schema(k)) || JSON.stringify(await metadata(k, selected)) !== JSON.stringify(prior)) invalid()
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
  const current = await metadata(k, selected)
  if (
    current.state !== 'complete' ||
    current.sha256 !== expected.sha256 ||
    current.bytes !== prior.bytes ||
    current.chunks !== prior.chunks ||
    current.maximumBytes !== prior.maximumBytes ||
    current.encoding !== prior.encoding
  )
    invalid()
  assertActive()
}
/** Initial staging uses the original exclusive source owner and a query-only
 * view. Actual physical chunks hash in allocation-sized windows; that view
 * drains before the short writer compares exact immutable-prefix definitions
 * and unchanged metadata. Returned hashes/counters are comparison DATA only. */
export async function completeBrc38SqlBinaryField(
  withRead: <T>(work: (trx: Knex.Transaction) => Promise<T>) => Promise<T>,
  withWrite: <T>(work: (trx: Knex.Transaction) => Promise<T>) => Promise<T>,
  table: Brc38StageTable,
  position: number,
  input: Brc38JsonStreamedField,
  assertActive: () => void,
  maximumReadBytes: number
): Promise<void> {
  assertActive()
  if (!Number.isSafeInteger(maximumReadBytes) || maximumReadBytes < 1 || maximumReadBytes > 65536) invalid()
  const expected = Object.freeze({
      field: input.field,
      encoding: input.encoding,
      bytes: input.bytes,
      sha256: input.sha256
    }),
    selected = coordinate(table, position, expected.field),
    prior = await withRead(async trx => {
      if (trx.isTransaction !== true) invalid()
      const mode = (await trx.raw('PRAGMA query_only')) as Array<{ query_only: number }>
      if (mode.length !== 1 || mode[0].query_only !== 1) invalid()
      const schemaVersion = await readBrc38SqlPrefixSchemaVersion(trx),
        metadata = await verifyCompleteContent(trx, table, position, expected, assertActive, maximumReadBytes)
      return Object.freeze({ schemaVersion, metadata })
    })
  await withWrite(async trx => {
    if ((await readBrc38SqlPrefixSchemaVersion(trx)) !== prior.schemaVersion) invalid()
    await markComplete(trx, selected, prior.metadata, expected, assertActive)
  })
}
export async function readBrc38SqlBinaryChunk(
  k: Knex,
  table: Brc38StageTable,
  position: number,
  field: string,
  offset: number
): Promise<Readonly<{ descriptor: Brc38JsonStreamedField; offset: number; bytes: Uint8Array }> | undefined> {
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
/** One allocation-bounded window from an actual sealed physical chunk.
 * Chunk/field hashes returned here are DATA; a complete consumer must hash all
 * contiguous windows and compare each whole physical chunk and field itself.
 * The original scalar definitions and current source descriptors are checked
 * before transferring any payload. No whole <=64KiB cell is cloned merely to
 * return a smaller window. */
export async function readBrc38SqlBinaryWindow(
  k: Knex,
  table: Brc38StageTable,
  position: number,
  field: string,
  offset: number,
  maximumReadBytes: number
): Promise<
  | Readonly<{
      descriptor: Readonly<Brc38JsonStreamedField>
      offset: number
      bytes: Uint8Array
      chunk: Readonly<{ offset: number; bytes: number; sha256: string }>
    }>
  | undefined
> {
  const selected = coordinate(table, position, field)
  integer(offset)
  integer(maximumReadBytes, 65536)
  if (maximumReadBytes === 0 || !(await schema(k))) invalid()
  const actual = await metadata(k, selected)
  if (actual.state !== 'complete' || actual.sha256 === null || offset > actual.bytes) invalid()
  if (offset === actual.bytes) return undefined
  const extent = (await k(chunksTable)
    .where(selected)
    .where('offset', '<=', offset)
    .orderBy('offset', 'desc')
    .first('offset', 'bytes', 'sha256', k.raw('typeof(payload) AS kind,length(payload) AS actualBytes'))) as
    { offset: number; bytes: number; sha256: string; kind: string; actualBytes: number } | undefined
  if (
    extent === undefined ||
    !Number.isSafeInteger(extent.offset) ||
    extent.offset < 0 ||
    extent.offset > offset ||
    !Number.isSafeInteger(extent.bytes) ||
    extent.bytes < 1 ||
    extent.bytes > Math.min(65536, actual.bytes - extent.offset) ||
    extent.kind !== 'blob' ||
    extent.actualBytes !== extent.bytes ||
    !/^[0-9a-f]{64}$/.test(extent.sha256)
  )
    invalid()
  const within = offset - extent.offset,
    amount = Math.min(maximumReadBytes, extent.bytes - within)
  if (within >= extent.bytes || amount < 1) invalid()
  const row = (await k(chunksTable)
    .where({ ...selected, offset: extent.offset })
    .first(k.raw('substr(payload,?,?) AS payload', [within + 1, amount]))) as { payload: Uint8Array } | undefined
  try {
    if (!(row?.payload instanceof Uint8Array) || row.payload.byteLength !== amount) invalid()
    return Object.freeze({
      descriptor: Object.freeze({ field, encoding: actual.encoding, bytes: actual.bytes, sha256: actual.sha256 }),
      offset,
      bytes: detachBrc38PrivateChunk(row.payload, amount),
      chunk: Object.freeze({ offset: extent.offset, bytes: extent.bytes, sha256: extent.sha256 })
    })
  } finally {
    if (row?.payload instanceof Uint8Array) row.payload.fill(0)
  }
}

/** Explicit integration fence: private field staging cannot silently become a
 * legacy row import with missing payloads. Remove only with real field-aware
 * semantic/receiver/native activation integration, never from passing framing. */
export async function assertNoBrc38SqlBinaryFields(k: Knex): Promise<void> {
  if ((await schema(k)) && (await k(metadataTable).first('field')) !== undefined)
    throw new Error('Streamed private fields require field-aware semantic and native import activation')
}

export async function readBrc38SqlBinaryDescriptors(
  k: Knex,
  table: Brc38StageTable,
  position: number
): Promise<Readonly<Record<string, Brc38JsonStreamedField>>> {
  integer(position, 1000000000)
  const result: Record<string, Brc38JsonStreamedField> = Object.create(null)
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
export async function verifyBrc38SqlBinaryDescriptors(
  k: Knex.Transaction,
  table: Brc38StageTable,
  position: number,
  expected: Readonly<Record<string, Brc38JsonStreamedField>>,
  assertActive: () => void
): Promise<void> {
  const actual = await readBrc38SqlBinaryDescriptors(k, table, position),
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
    await finishBrc38SqlBinaryField(k, table, position, value, assertActive)
  }
}
/** Every current field is complete before this bounded query-only content
 * pass. This is original content verification, not source/semantic authority.
 * Immutable prefixes and metadata counts are checked again in the writer. */
export async function readAllBrc38SqlBinaryFieldContent(
  k: Knex.Transaction,
  maximumRows: number,
  maximumReadBytes: number,
  assertActive: () => void
): Promise<void> {
  const mode = (await k.raw('PRAGMA query_only')) as Array<{ query_only: number }>
  if (
    mode.length !== 1 ||
    mode[0].query_only !== 1 ||
    !Number.isSafeInteger(maximumReadBytes) ||
    maximumReadBytes < 128 ||
    maximumReadBytes > 65536 ||
    !Number.isSafeInteger(maximumRows) ||
    maximumRows < 1 ||
    maximumRows > 1000000000
  )
    invalid()
  await verifyAllFields(k, maximumRows, assertActive, maximumReadBytes)
}
/** Current exact family definitions/counts only, freshly inspected in the
 * actual view. Existing complete postimages cannot change under these guards;
 * insertion changes counts, and guard replacement changes the DDL generation.
 * These scalar counts are comparison DATA, never content/source authority. */
export async function countBrc38SqlBinaryFieldMetadata(
  k: Knex
): Promise<Readonly<{ fields: number; chunks: number }> | undefined> {
  if (!(await schema(k))) return undefined
  const fields = (await k(metadataTable).count({ count: '*' }).first()) as { count: unknown } | undefined,
    chunks = (await k(chunksTable).count({ count: '*' }).first()) as { count: unknown } | undefined
  if (
    typeof fields?.count !== 'number' ||
    !Number.isSafeInteger(fields.count) ||
    fields.count < 0 ||
    typeof chunks?.count !== 'number' ||
    !Number.isSafeInteger(chunks.count) ||
    chunks.count < 0
  )
    invalid()
  return Object.freeze({ fields: fields.count, chunks: chunks.count })
}
export async function verifyAllBrc38SqlBinaryFields(
  k: Knex.Transaction,
  maximumRows: number,
  assertActive: () => void
): Promise<void> {
  await verifyAllFields(k, maximumRows, assertActive)
}
async function verifyAllFields(
  k: Knex.Transaction,
  maximumRows: number,
  assertActive: () => void,
  maximumReadBytes?: number
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
    const expected = { field: row.field, encoding: row.encoding, bytes: row.bytes, sha256: row.sha256 }
    if (maximumReadBytes === undefined)
      await finishBrc38SqlBinaryField(k, row.tableName, row.position, expected, assertActive)
    else await verifyCompleteContent(k, row.tableName, row.position, expected, assertActive, maximumReadBytes)
    after = selected
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
}

/** Fresh read-only family definition inspection; absence is DATA only. */
export async function hasBrc38SqlBinarySchema(k: Knex): Promise<boolean> {
  return await schema(k)
}
