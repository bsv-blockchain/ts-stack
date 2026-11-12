import { readBrc38SqlFieldSchemaCounts } from './Brc38SqlFieldSchemaBatch'
import { requireBrc38PackedRead } from './Brc38NativePackedSchemaNode'
import {
  visitBrc38SqlStructuredChunkWindows,
  visitBrc38SqlProvisionalStructuredChunkWindows
} from './Brc38SqlStructuredChunkWindowNode'
import {
  installBrc38SqlStructuredPrefixGuards,
  verifyBrc38SqlStructuredPrefixGuards,
  readBrc38SqlPrefixSchemaVersion
} from './Brc38SqlStructuredPrefixGuards'
import { verifyBrc38SourceSealFieldDefinitions } from './Brc38AuthenticatedSourceSealNode'
import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import type { Brc38StageTable } from './Brc38SemanticStage'
import { brc38JsonTextField, type Brc38JsonTextField } from './Brc38JsonTextFields'
import { detachBrc38PrivateChunk } from './Brc38PrivateChunkPipe'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

const metadataTable = 'private_text_fields',
  chunksTable = 'private_text_chunks'
const metadataSql = `CREATE TABLE private_text_fields(tableName TEXT NOT NULL,position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position>=0),field TEXT NOT NULL CHECK(length(CAST(field AS BLOB))<=128),encoding TEXT NOT NULL CHECK(encoding='utf8'),maximumBytes INTEGER NOT NULL CHECK(typeof(maximumBytes)='integer' AND maximumBytes BETWEEN 0 AND 1000000000),bytes INTEGER NOT NULL CHECK(typeof(bytes)='integer' AND bytes>=0 AND bytes<=maximumBytes),chunks INTEGER NOT NULL CHECK(typeof(chunks)='integer' AND chunks>=0),state TEXT NOT NULL CHECK(state IN ('writing','complete')),sha256 TEXT CHECK((state='writing' AND sha256 IS NULL) OR (state='complete' AND bytes>=0 AND length(CAST(sha256 AS BLOB))=64)),PRIMARY KEY(tableName,position,field))`
const chunksSql = `CREATE TABLE private_text_chunks(tableName TEXT NOT NULL,position INTEGER NOT NULL,field TEXT NOT NULL,offset INTEGER NOT NULL CHECK(typeof(offset)='integer' AND offset>=0),bytes INTEGER NOT NULL CHECK(typeof(bytes)='integer' AND bytes>=1 AND bytes<=65536),payload BLOB NOT NULL CHECK(typeof(payload)='blob' AND length(payload)=bytes),sha256 TEXT NOT NULL CHECK(length(CAST(sha256 AS BLOB))=64),PRIMARY KEY(tableName,position,field,offset))`
interface FieldRow {
  tableName: Brc38StageTable
  position: number
  field: string
  encoding: Brc38JsonTextField['encoding']
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
  throw new Error('Private scalar TEXT staging content or coordinate differs')
}
function integer(value: number, maximum = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) invalid()
}
function coordinate(table: Brc38StageTable, position: number, field: string): Coordinate {
  integer(position, 1000000000)
  if (!brc38JsonTextField(table, field)) invalid()
  return { tableName: table, position, field }
}
/** Decoded original UTF-8 string bytes only. Completion hashes actual content; fresh fatal UTF-8 decoding verifies every original value before completion.
 * Complete row relationships and authentication still precede admission.
 * Native definitions and all metadata are freshly read in the caller-owned
 * private transaction. This helper never owns a pool, profile or admission. */
async function schema(k: Knex, create = false): Promise<boolean> {
  const actual = await readBrc38SqlFieldSchemaCounts(k, 'text', [
    [metadataTable, metadataSql],
    [chunksTable, chunksSql]
  ])
  if (actual.total === 0) {
    if (!create) return false
    if (!(k as Knex.Transaction).isTransaction) invalid()
    await k.raw(metadataSql)
    await k.raw(chunksSql)
    await installBrc38SqlStructuredPrefixGuards(k as Knex.Transaction, 'text')
    return await schema(k)
  }
  if ((actual.sealCount !== 0 && actual.sealCount !== 6) || actual.sealMatches !== actual.sealCount) {
    // Keep the original failure identity; the scalar result never grants admission.
    await verifyBrc38SourceSealFieldDefinitions(k, 'text')
    invalid()
  }
  if (actual.prefixMatches !== 6) {
    try {
      await verifyBrc38SqlStructuredPrefixGuards(k, 'text')
    } catch {
      invalid()
    }
    invalid()
  }
  if (actual.total !== 10 + actual.sealCount || actual.baseMatches !== 4) invalid()
  return true
}
/** Read-only exact definition check, including empty/partially present families.
 * Absence is DATA; callers decide whether their current inventory requires it. */
export async function hasBrc38SqlTextSchema(k: Knex): Promise<boolean> {
  return await schema(k)
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
  integer(row.maximumBytes, 1000000000)
  integer(row.bytes, row.maximumBytes)
  integer(row.chunks)
  if (row.maximumBytes < 0) invalid()
  if (
    row.tableName !== selected.tableName ||
    row.position !== selected.position ||
    row.field !== selected.field ||
    row.encoding !== 'utf8' ||
    (row.bytes === 0) !== (row.chunks === 0) ||
    row.chunks > row.bytes ||
    (row.state !== 'writing' && row.state !== 'complete') ||
    (row.state === 'complete' && row.bytes < 0) ||
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
    throw new SnapshotResourceLimitError('Private scalar TEXT staging logical quota reached')
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
export async function beginBrc38SqlTextField(
  k: Knex.Transaction,
  table: Brc38StageTable,
  position: number,
  field: string,
  encoding: Brc38JsonTextField['encoding'],
  maximumBytes: number,
  maximumLogicalBytes: number,
  maximumRows: number
): Promise<void> {
  const selected = coordinate(table, position, field)
  integer(maximumBytes, maximumLogicalBytes)
  if (maximumBytes < 0 || maximumBytes > 1000000000)
    throw new SnapshotResourceLimitError('Private scalar TEXT value cannot fit its selected byte policy')
  if (encoding !== 'utf8') invalid()
  const meta = await counters(k, maximumLogicalBytes)
  await schema(k, true)
  const existing = await k(metadataTable).where(selected).first('field')
  if (existing !== undefined) {
    const prior = await metadata(k, selected)
    if (prior.maximumBytes !== maximumBytes || prior.encoding !== encoding) invalid()
    return
  }
  if (meta.state !== 'staging') invalid()
  if (meta.rows >= maximumRows) throw new SnapshotResourceLimitError('Private scalar TEXT staging row quota reached')
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
export async function appendBrc38SqlTextField(
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
    throw new SnapshotResourceLimitError('Private scalar TEXT field byte quota reached')
  await charge(k, meta, bytes.byteLength + 128, maximumLogicalBytes)
  await k(chunksTable).insert({ ...selected, offset, bytes: bytes.byteLength, payload: bytes, sha256: sha(bytes) })
  if (
    (await k(metadataTable)
      .where({ ...selected, state: 'writing', bytes: prior.bytes, chunks: prior.chunks })
      .update({ bytes: prior.bytes + bytes.byteLength, chunks: prior.chunks + 1 })) !== 1
  )
    invalid()
}
export async function finishBrc38SqlTextField(
  k: Knex.Transaction,
  table: Brc38StageTable,
  position: number,
  expected: Brc38JsonTextField,
  assertActive: () => void,
  maximumReadBytes?: number
): Promise<void> {
  const selected = coordinate(table, position, expected.field),
    prior = await verifiedCompleteContent(k, table, position, expected, assertActive, maximumReadBytes)
  await markComplete(k, selected, prior, expected, assertActive)
}
async function verifiedCompleteContent(
  k: Knex.Transaction,
  table: Brc38StageTable,
  position: number,
  expected: Brc38JsonTextField,
  assertActive: () => void,
  maximumReadBytes?: number,
  provisionalRead = false
): Promise<FieldRow> {
  if (maximumReadBytes !== undefined && !provisionalRead) requireBrc38PackedRead(k)
  const selected = coordinate(table, position, expected.field)
  if (!Number.isSafeInteger(expected.bytes) || expected.bytes < 0 || expected.bytes > 1000000000) invalid()
  if (!(await schema(k))) invalid()
  const prior = await metadata(k, selected)
  if (prior.encoding !== expected.encoding || prior.bytes !== expected.bytes || !/^[0-9a-f]{64}$/.test(expected.sha256))
    invalid()
  const aggregate = (await k(chunksTable).where(selected).count({ count: '*' }).sum({ bytes: 'bytes' }).first()) as
    { count: number; bytes: number | null } | undefined
  if (aggregate === undefined || aggregate.count !== prior.chunks || (aggregate.bytes ?? 0) !== prior.bytes) invalid()
  assertActive()
  const digest = createHash('sha256'),
    decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  let offset = 0
  for (let index = 0; index < prior.chunks; index++) {
    assertActive()
    if (maximumReadBytes === undefined) {
      const actual = await chunk(k, selected, offset)
      if (actual === undefined || actual.byteLength > prior.bytes - offset) invalid()
      try {
        digest.update(actual)
        decoder.decode(actual, { stream: true })
        offset += actual.byteLength
      } finally {
        actual.fill(0)
      }
    } else {
      const visit = provisionalRead
        ? visitBrc38SqlProvisionalStructuredChunkWindows
        : visitBrc38SqlStructuredChunkWindows
      const actual = await visit(k, chunksTable, { ...selected, offset }, maximumReadBytes, assertActive, bytes => {
        digest.update(bytes)
        decoder.decode(bytes, { stream: true })
      })
      if (actual.bytes > prior.bytes - offset) invalid()
      offset += actual.bytes
    }
    if (index % 64 === 63) await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
  decoder.decode()
  if (
    offset !== prior.bytes ||
    digest.digest('hex') !== expected.sha256 ||
    (await k(chunksTable).where(selected).where('offset', '>=', offset).first('offset')) !== undefined
  )
    invalid()
  if (prior.state === 'complete' && prior.sha256 !== expected.sha256) invalid()
  if (JSON.stringify(await metadata(k, selected)) !== JSON.stringify(prior)) invalid()
  return prior
}
async function markComplete(
  k: Knex.Transaction,
  selected: Coordinate,
  prior: FieldRow,
  expected: Brc38JsonTextField,
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
  const after = await metadata(k, selected)
  if (
    after.state !== 'complete' ||
    after.sha256 !== expected.sha256 ||
    after.bytes !== prior.bytes ||
    after.chunks !== prior.chunks
  )
    invalid()
  assertActive()
}
/** Actual content is hashed inside the caller's current query-only source
 * view. That transaction drains before a short writer compares unchanged
 * metadata and exact append-only guards. No completion verdict escapes. */
export async function completeBrc38SqlTextField(
  withRead: <T>(work: (trx: Knex.Transaction) => Promise<T>) => Promise<T>,
  withWrite: <T>(work: (trx: Knex.Transaction) => Promise<T>) => Promise<T>,
  table: Brc38StageTable,
  position: number,
  input: Brc38JsonTextField,
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
      const schemaVersion = await readBrc38SqlPrefixSchemaVersion(trx),
        metadata = await verifiedCompleteContent(trx, table, position, expected, assertActive, maximumReadBytes, true)
      return Object.freeze({ schemaVersion, metadata })
    })
  await withWrite(async trx => {
    if ((await readBrc38SqlPrefixSchemaVersion(trx)) !== prior.schemaVersion) invalid()
    await markComplete(trx, selected, prior.metadata, expected, assertActive)
  })
}
export async function readBrc38SqlTextChunk(
  k: Knex,
  table: Brc38StageTable,
  position: number,
  field: string,
  offset: number
): Promise<Readonly<{ descriptor: Brc38JsonTextField; offset: number; bytes: Uint8Array }> | undefined> {
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
export async function readBrc38SqlTextRange(
  k: Knex,
  table: Brc38StageTable,
  position: number,
  field: string,
  offset: number,
  length: number,
  selected: Brc38JsonTextField,
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
    expected.field !== field ||
    expected.encoding !== 'utf8' ||
    !Number.isSafeInteger(expected.bytes) ||
    expected.bytes < 0 ||
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
  if (length === 0) {
    await current()
    return new Uint8Array(0)
  }
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
 * legacy row import with missing scalar TEXT values. Remove only with real field-aware
 * semantic/receiver/native activation integration, never from passing framing. */
export async function assertNoBrc38SqlTextFields(k: Knex): Promise<void> {
  if ((await schema(k)) && (await k(metadataTable).first('field')) !== undefined)
    throw new Error('Streamed scalar TEXT fields require actual string validation and field-aware import activation')
}

export async function readBrc38SqlTextDescriptors(
  k: Knex,
  table: Brc38StageTable,
  position: number
): Promise<Readonly<Record<string, Brc38JsonTextField>>> {
  integer(position, 1000000000)
  const result: Record<string, Brc38JsonTextField> = Object.create(null)
  if (!(await schema(k))) return Object.freeze(result)
  const fields: Array<{ field: string }> = await k(metadataTable)
    .where({ tableName: table, position })
    .select('field')
    .orderBy('field')
    .limit(8)
  if (fields.length > 7) invalid()
  for (const { field } of fields) {
    const selected = coordinate(table, position, field),
      row = await metadata(k, selected)
    if (row.state !== 'complete' || row.sha256 === null) invalid()
    result[field] = Object.freeze({ field, encoding: row.encoding, bytes: row.bytes, sha256: row.sha256 })
  }
  return Object.freeze(result)
}
export async function verifyBrc38SqlTextDescriptors(
  k: Knex.Transaction,
  table: Brc38StageTable,
  position: number,
  expected: Readonly<Record<string, Brc38JsonTextField>>,
  assertActive: () => void
): Promise<void> {
  const actual = await readBrc38SqlTextDescriptors(k, table, position),
    names = Object.keys(expected)
  if (names.length > 7 || names.length !== Object.keys(actual).length) invalid()
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
    await finishBrc38SqlTextField(k, table, position, value, assertActive)
  }
}
/** Every current field is complete before this bounded query-only content
 * pass. This is original content verification, not source/semantic authority.
 * Immutable prefixes and metadata counts are checked again in the writer. */
export async function readAllBrc38SqlTextFieldContent(
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
export async function countBrc38SqlTextFieldMetadata(
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
export async function verifyAllBrc38SqlTextFields(
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
    if (++examined > maximumRows * 7) invalid()
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
      await finishBrc38SqlTextField(k, row.tableName, row.position, expected, assertActive)
    else await verifiedCompleteContent(k, row.tableName, row.position, expected, assertActive, maximumReadBytes, true)
    after = selected
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
}
