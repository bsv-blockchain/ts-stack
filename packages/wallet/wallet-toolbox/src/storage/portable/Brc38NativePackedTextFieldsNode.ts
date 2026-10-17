import { privateNativeTransactionIdentity } from './Brc38PrivateNativeOwnershipNode'
import { nativePackedTextSources } from './Brc38NativePackedTextSources'
import { retireExpiredBrc38NativePreparedFields } from './Brc38NativePreparedFieldsNode'
import { hasBrc38NativePreparedFieldsSchema, nativePreparedFieldsTable } from './Brc38NativePreparedFieldSchemaNode'
import type { Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import type { Brc38NativeTextRead } from './Brc38NativeBlobProtocol'
import {
  brc38NativePackedTextCoordinate,
  validateBrc38NativePackedTextRead,
  type Brc38NativePackedTextCoordinate,
  type Brc38NativePackedTextRead
} from './Brc38NativeLocalPackedCoordinate'
import { brc38NativeLocalPackedSources } from './Brc38NativeLocalPackedLayout'
import type { Brc38JsonStructuredField } from './Brc38JsonStructuredFields'
import { brc38JsonStructuredField } from './Brc38JsonStructuredFields'
import {
  readBrc38SqlCanonicalStructuredDescriptors,
  readBrc38SqlCanonicalStructuredChunk
} from './Brc38SqlCanonicalStructuredStaging'
import {
  readBrc38SqlProjectedStructuredDescriptors,
  readBrc38SqlProjectedStructuredChunk
} from './Brc38SqlProjectedStructuredStaging'
import { hasBrc38NativePackedTextSchema, nativePackedTextTables as names } from './Brc38NativePackedTextSchemaNode'
import { requireBrc38PackedRead, requireBrc38PackedWriter } from './Brc38NativePackedSchemaNode'
import { isBrc38OwnedPrivateNativeWriter, isBrc38OwnedPrivateNativeSqlite } from './KnexBrc38StagingStore'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'
import { detachBrc38PrivateChunk } from './Brc38PrivateChunkPipe'
import { collectBrc38NativePackedGarbage } from './Brc38NativePackedFieldsNode'
import { nativePackedTables } from './Brc38NativePackedSchemaNode'
import { hashBrc38NativePackedChunkWindows } from './Brc38NativePackedHashWindowNode'

/** Actual readonly private membership, never copied flags or a writer. */
function requirePrivatePackedTextDataRead(k: Knex.Transaction): void {
  requireBrc38PackedRead(k)
  if (!isBrc38OwnedPrivateNativeSqlite(k) || privateNativeTransactionIdentity(k)?.slot !== 3)
    throw new Error('Packed TEXT DATA requires its actual private readonly transaction')
}

const tables: Readonly<Record<number, string>> = Object.fromEntries([
  ...nativePackedTextSources.map(source => [source.id, source.sql]),
  ...brc38NativeLocalPackedSources.filter(source => source.kind === 'text').map(source => [source.id, source.table])
])
const keys: Readonly<Record<number, string>> = Object.fromEntries([
  ...nativePackedTextSources.map(source => [source.id, source.key]),
  ...brc38NativeLocalPackedSources.filter(source => source.kind === 'text').map(source => [source.id, source.key])
])
interface Key {
  tableId: number
  rowId: number
  fieldId: number
}
interface Version {
  sha256: string
  bytes: number
  accepted: number
  chunks: number
  state: 'PENDING' | 'SEALED' | 'RETIRING'
}
function invalid(): never {
  throw new Error('Packed native field differs from its current owned content')
}
const digest = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex')
function key(input: Brc38NativePackedTextCoordinate): Key {
  // Use the independently specified fixed coordinate ABI without allocating
  // payload bytes. A key is DATA and confers no SQL/transaction authority.
  const [tableId, fieldId] = brc38NativePackedTextCoordinate(input)
  return { tableId, rowId: input.rowId, fieldId }
}
async function version(k: Knex.Transaction, sha256: string): Promise<Version | undefined> {
  const rows = (await k(names.versions)
    .where({ sha256 })
    .select('sha256', 'bytes', 'accepted', 'chunks', 'state')
    .limit(2)) as Version[]
  if (rows.length > 1) invalid()
  const row = rows[0]
  if (
    row !== undefined &&
    (row.sha256 !== sha256 ||
      !/^[0-9a-f]{64}$/.test(row.sha256) ||
      !Number.isSafeInteger(row.bytes) ||
      row.bytes < 0 ||
      row.bytes > 1000000000 ||
      !Number.isSafeInteger(row.accepted) ||
      row.accepted < 0 ||
      row.accepted > row.bytes ||
      !Number.isSafeInteger(row.chunks) ||
      row.chunks < 0 ||
      row.chunks > row.bytes ||
      !['PENDING', 'SEALED', 'RETIRING'].includes(row.state))
  )
    invalid()
  return row
}
/** Logical wallet-key coordinates, not SQLite physical rowid transport.
 * Current descriptor DATA only, on the actual retained private/published view.
 * Every caller still admits its actual source/profile/schema/primary context. */
export async function readBrc38NativePackedTextDescriptor(
  k: Knex.Transaction,
  input: Brc38NativePackedTextCoordinate
): Promise<Readonly<{ bytes: number; sha256: string }> | undefined> {
  requireBrc38PackedRead(k)
  const selected = key(input)
  if (!(await hasBrc38NativePackedTextSchema(k))) invalid()
  return await readBrc38NativePackedTextDescriptorContent(k, input, selected)
}
/** DATA only on an actual private query-only lease. The owning factory must
 * freshly admit schema/seal/binding before and after its operation. This does
 * not admit a source or cache a schema verdict. */
export async function readBrc38NativePackedTextDescriptorData(
  k: Knex.Transaction,
  input: Brc38NativePackedTextCoordinate
): Promise<Readonly<{ bytes: number; sha256: string }> | undefined> {
  requirePrivatePackedTextDataRead(k)
  return await readBrc38NativePackedTextDescriptorContent(k, input, key(input))
}
async function readBrc38NativePackedTextDescriptorContent(
  k: Knex.Transaction,
  input: Brc38NativePackedTextCoordinate,
  selected: Key
): Promise<Readonly<{ bytes: number; sha256: string }> | undefined> {
  requireBrc38PackedRead(k)
  const physical = (await k(tables[selected.tableId])
    .where({ [keys[selected.tableId]]: selected.rowId })
    .first(k.raw('typeof(??) AS kind,length(CAST(?? AS BLOB)) AS bytes', [input.field, input.field]))) as
    { kind: string; bytes: number | null } | undefined
  if (physical === undefined || (physical.kind !== 'null' && (physical.kind !== 'text' || physical.bytes !== 0)))
    invalid()
  const rows = (await k(names.fields).where(selected).select('sha256').limit(2)) as Array<{ sha256: string }>
  if (rows.length > 1) invalid()
  if (rows.length === 0) {
    if (physical.kind !== 'null') invalid()
    return undefined
  }
  if (physical.kind === 'null') invalid()
  const value = await version(k, rows[0].sha256)
  if (value === undefined || value.state !== 'SEALED' || value.accepted !== value.bytes) invalid()
  requireBrc38PackedRead(k)
  return Object.freeze({ bytes: value.bytes, sha256: value.sha256 })
}
async function chunk(k: Knex.Transaction, sha256: string, offset: number): Promise<Uint8Array> {
  requireBrc38PackedRead(k)
  const extent = (await k(names.chunks)
    .where({ sha256, offset })
    .first('bytes', 'chunkSha256', k.raw('typeof(payload) AS kind,length(payload) AS actualBytes'))) as
    { bytes: number; actualBytes: number; chunkSha256: string; kind: string } | undefined
  if (
    extent === undefined ||
    !Number.isSafeInteger(extent.bytes) ||
    extent.bytes < 1 ||
    extent.bytes > 65536 ||
    extent.actualBytes !== extent.bytes ||
    extent.kind !== 'blob' ||
    !/^[0-9a-f]{64}$/.test(extent.chunkSha256)
  )
    invalid()
  const row = (await k(names.chunks).where({ sha256, offset }).first('payload')) as { payload: Uint8Array } | undefined
  if (row === undefined || !(row.payload instanceof Uint8Array) || row.payload.byteLength !== extent.bytes) invalid()
  let owned: Uint8Array | undefined
  try {
    owned = detachBrc38PrivateChunk(row.payload, 65536)
    if (digest(owned) !== extent.chunkSha256) invalid()
    requireBrc38PackedRead(k)
    return owned
  } catch (cause) {
    owned?.fill(0)
    throw cause
  } finally {
    row.payload.fill(0)
  }
}
/** Actual SEALED version metadata, without a wallet-row pointer. This is
 * derived-content DATA only; callers separately own source/row/receipt policy. */
export async function readBrc38NativePackedTextVersionDescriptor(
  k: Knex.Transaction,
  sha256: string
): Promise<Readonly<{ bytes: number; sha256: string }>> {
  requireBrc38PackedRead(k)
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256) || !(await hasBrc38NativePackedTextSchema(k)))
    invalid()
  return await readBrc38NativePackedTextVersionDescriptorContent(k, sha256)
}
/** Immutable version DATA only; the original actual source factory owns
 * fresh schema, seal, row/pointer, budget and lifetime admission. */
export async function readBrc38NativePackedTextVersionDescriptorData(
  k: Knex.Transaction,
  sha256: string
): Promise<Readonly<{ bytes: number; sha256: string }>> {
  requirePrivatePackedTextDataRead(k)
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) invalid()
  return await readBrc38NativePackedTextVersionDescriptorContent(k, sha256)
}
async function readBrc38NativePackedTextVersionDescriptorContent(
  k: Knex.Transaction,
  sha256: string
): Promise<Readonly<{ bytes: number; sha256: string }>> {
  requireBrc38PackedRead(k)
  const actual = await version(k, sha256)
  if (actual === undefined || actual.state !== 'SEALED' || actual.accepted !== actual.bytes) invalid()
  requireBrc38PackedRead(k)
  return Object.freeze({ bytes: actual.bytes, sha256: actual.sha256 })
}

/** Bounded actual sealed version extents. Every copied physical chunk is
 * independently hashed, and the same version metadata is compared again.
 * A hash/coordinate cannot create a producer, semantic or row admission. */
export async function readBrc38NativePackedTextVersionExtent(
  k: Knex.Transaction,
  selected: Readonly<{ sha256: string; totalBytes: number; offset: number; length: number }>,
  signal?: AbortSignal
): Promise<Uint8Array> {
  return await readBrc38NativePackedTextVersionExtentContent(
    k,
    selected,
    signal,
    readBrc38NativePackedTextVersionDescriptor
  )
}
/** Bounded verified bytes only within an already admitted actual private
 * readonly operation. Geometry, current metadata, chunk hashes, cancellation
 * and zeroing are the same as the default helper; no schema authority escapes. */
export async function readBrc38NativePackedTextVersionExtentData(
  k: Knex.Transaction,
  selected: Readonly<{ sha256: string; totalBytes: number; offset: number; length: number }>,
  signal?: AbortSignal
): Promise<Uint8Array> {
  requirePrivatePackedTextDataRead(k)
  return await readBrc38NativePackedTextVersionExtentContent(
    k,
    selected,
    signal,
    readBrc38NativePackedTextVersionDescriptorData
  )
}
async function readBrc38NativePackedTextVersionExtentContent(
  k: Knex.Transaction,
  selected: Readonly<{ sha256: string; totalBytes: number; offset: number; length: number }>,
  signal: AbortSignal | undefined,
  descriptor: typeof readBrc38NativePackedTextVersionDescriptor
): Promise<Uint8Array> {
  const fixed = Object.freeze({
    sha256: selected.sha256,
    totalBytes: selected.totalBytes,
    offset: selected.offset,
    length: selected.length
  })
  if (
    !Number.isSafeInteger(fixed.totalBytes) ||
    fixed.totalBytes < 0 ||
    fixed.totalBytes > 1000000000 ||
    !Number.isSafeInteger(fixed.offset) ||
    fixed.offset < 0 ||
    !Number.isSafeInteger(fixed.length) ||
    fixed.length < 0 ||
    fixed.length > 65536 ||
    fixed.offset + fixed.length > fixed.totalBytes
  )
    invalid()
  signal?.throwIfAborted()
  const actual = await descriptor(k, fixed.sha256)
  if (actual.bytes !== fixed.totalBytes) invalid()
  const output = new Uint8Array(fixed.length)
  try {
    for (let used = 0; used < output.length;) {
      signal?.throwIfAborted()
      requireBrc38PackedRead(k)
      const at = fixed.offset + used,
        row = (await k(names.chunks)
          .where({ sha256: fixed.sha256 })
          .where('offset', '<=', at)
          .orderBy('offset', 'desc')
          .first('offset')) as { offset: number } | undefined
      if (row === undefined || !Number.isSafeInteger(row.offset) || row.offset < 0 || row.offset > at) invalid()
      const payload = await chunk(k, fixed.sha256, row.offset),
        start = at - row.offset
      try {
        if (start >= payload.length || row.offset + payload.length > fixed.totalBytes) invalid()
        const amount = Math.min(output.length - used, payload.length - start)
        output.set(payload.subarray(start, start + amount), used)
        used += amount
      } finally {
        payload.fill(0)
      }
    }
    const after = await descriptor(k, fixed.sha256)
    if (after.bytes !== actual.bytes || after.sha256 !== actual.sha256) invalid()
    signal?.throwIfAborted()
    requireBrc38PackedRead(k)
    return output
  } catch (cause) {
    output.fill(0)
    throw cause
  }
}
/** Metadata expression for the declared packed layout. A NULL source cell stays
 * NULL; a nonnull marker without a sealed pointer returns the invalid -1
 * sentinel, including empty logical content. The caller first checks
 * the exact current packed schema on this retained native view. */
export function brc38NativePackedTextLength(
  k: Knex.Transaction,
  input: Omit<Brc38NativePackedTextCoordinate, 'rowId'>,
  alias?: string
): Knex.Raw {
  requireBrc38PackedRead(k)
  const selected = key({ ...input, rowId: 1 } as Brc38NativePackedTextCoordinate),
    table = alias ?? tables[selected.tableId]
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(table)) invalid()
  return k.raw(
    `CASE WHEN ??.?? IS NULL THEN NULL WHEN typeof(??.??)!='text' OR length(CAST(??.?? AS BLOB))!=0 THEN -1 ELSE coalesce((SELECT v.bytes FROM brc38_native_text_fields f JOIN brc38_native_text_versions v ON v.sha256=f.sha256 WHERE f.tableId=? AND f.rowId=??.?? AND f.fieldId=? AND v.state='SEALED' AND v.accepted=v.bytes),-1) END`,
    [
      table,
      input.field,
      table,
      input.field,
      table,
      input.field,
      selected.tableId,
      table,
      keys[selected.tableId],
      selected.fieldId
    ]
  )
}
/** One bounded logical extent from actual immutable physical <=64KiB chunks.
 * Each physical chunk's bytes/hash is verified before copying; metadata-only
 * row updates therefore never load/rewrite a large full payload record. */
export async function readBrc38NativePackedTextExtent(
  k: Knex.Transaction,
  input: Brc38NativePackedTextRead,
  signal?: AbortSignal
): Promise<Uint8Array> {
  return await readBrc38NativePackedTextExtentContent(k, input, signal, readBrc38NativePackedTextDescriptor)
}
/** Bounded verified bytes only within an already admitted actual private
 * readonly operation. Geometry, current metadata, chunk hashes, cancellation
 * and zeroing are the same as the default helper; no schema authority escapes. */
export async function readBrc38NativePackedTextExtentData(
  k: Knex.Transaction,
  input: Brc38NativePackedTextRead,
  signal?: AbortSignal
): Promise<Uint8Array> {
  requirePrivatePackedTextDataRead(k)
  return await readBrc38NativePackedTextExtentContent(k, input, signal, readBrc38NativePackedTextDescriptorData)
}
async function readBrc38NativePackedTextExtentContent(
  k: Knex.Transaction,
  input: Brc38NativePackedTextRead,
  signal: AbortSignal | undefined,
  descriptor: typeof readBrc38NativePackedTextDescriptor
): Promise<Uint8Array> {
  signal?.throwIfAborted()
  requireBrc38PackedRead(k)
  validateBrc38NativePackedTextRead(input)
  const fixed = {
      table: input.table,
      field: input.field,
      rowId: input.rowId,
      offset: input.offset,
      length: input.length,
      totalBytes: input.totalBytes
    } as Brc38NativePackedTextRead,
    actual = await descriptor(k, fixed)
  if (actual === undefined || actual.bytes !== fixed.totalBytes) invalid()
  const output = new Uint8Array(fixed.length)
  try {
    for (let used = 0; used < output.byteLength;) {
      signal?.throwIfAborted()
      requireBrc38PackedRead(k)
      const at = fixed.offset + used,
        row = (await k(names.chunks)
          .where({ sha256: actual.sha256 })
          .where('offset', '<=', at)
          .select('offset')
          .orderBy('offset', 'desc')
          .limit(1)
          .first()) as { offset: number } | undefined
      if (row === undefined || !Number.isSafeInteger(row.offset) || row.offset < 0 || row.offset > at) invalid()
      const value = await chunk(k, actual.sha256, row.offset),
        within = at - row.offset
      try {
        if (within >= value.byteLength) invalid()
        const amount = Math.min(value.byteLength - within, output.byteLength - used)
        output.set(value.subarray(within, within + amount), used)
        used += amount
      } finally {
        value.fill(0)
      }
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    signal?.throwIfAborted()
    requireBrc38PackedRead(k)
    const after = await descriptor(k, fixed)
    if (after?.bytes !== actual.bytes || after.sha256 !== actual.sha256) invalid()
    return output
  } catch (cause) {
    output.fill(0)
    throw cause
  }
}
/** Independently hashes actual bounded chunk postimages. Expected SHA, SEALED,
 * original canonical descriptors and previous matches never become a reusable verdict. */
export async function hashBrc38NativePackedTextVersion(
  k: Knex.Transaction,
  sha256: string,
  bytes: number,
  check: () => void,
  maximumReadBytes = 65536,
  workingAllocation?: Brc38WorkingAllocation
): Promise<string> {
  requireBrc38PackedRead(k)
  if (
    !/^[0-9a-f]{64}$/.test(sha256) ||
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    bytes > 1000000000 ||
    !Number.isSafeInteger(maximumReadBytes) ||
    maximumReadBytes < 1 ||
    maximumReadBytes > 65536 ||
    !(await hasBrc38NativePackedTextSchema(k))
  )
    invalid()
  const before = await version(k, sha256)
  if (before === undefined || before.state === 'RETIRING' || before.bytes !== bytes || before.accepted !== bytes)
    invalid()
  const result = await hashBrc38NativePackedChunkWindows(
    k,
    names.chunks,
    sha256,
    bytes,
    maximumReadBytes,
    check,
    workingAllocation
  )
  check()
  const after = await version(k, sha256)
  const cardinality = (await k(names.chunks).where({ sha256 }).count({ count: '*' }).first()) as
    { count: unknown } | undefined
  if (
    JSON.stringify(after) !== JSON.stringify(before) ||
    result.chunks !== before.chunks ||
    cardinality?.count !== result.chunks
  )
    invalid()
  requireBrc38PackedRead(k)
  return result.sha256
}
export interface Brc38PrivatePackedTextFieldSelection {
  readonly table: Brc38NativeTextRead['table']
  readonly sourceIndex: number
  readonly destinationRowId: number
  readonly field: Brc38JsonStructuredField
  readonly family?: 'canonical' | 'projected'
  readonly expiresAt: number
  readonly signal?: AbortSignal
}
const active = new WeakSet<Knex.Transaction>()
/** Private authenticated restore only. One actual writer savepoint installs a
 * complete content-addressed version and its logical field pointer. Main rows
 * contain only small metadata/empty physical TEXT markers; those markers never
 * escape as complete DTOs. Chunk/version/ref/budget and caller journal effects
 * remain in the SAME transaction. No network/source callback runs here. */
export async function writeBrc38PrivatePackedTextField(
  k: Knex.Transaction,
  selected: Brc38PrivatePackedTextFieldSelection
): Promise<void> {
  selected.signal?.throwIfAborted()
  if (!isBrc38OwnedPrivateNativeWriter(k)) invalid()
  const input = {
      table: selected.table,
      sourceIndex: selected.sourceIndex,
      destinationRowId: selected.destinationRowId,
      field: {
        field: selected.field.field,
        encoding: selected.field.encoding,
        bytes: selected.field.bytes,
        sha256: selected.field.sha256
      },
      family: selected.family ?? 'canonical',
      expiresAt: selected.expiresAt,
      signal: selected.signal
    },
    coordinate = key({
      table: input.table,
      field: input.field.field as Brc38NativeTextRead['field'],
      rowId: input.destinationRowId
    }),
    deadline = performance.now() + Math.max(0, input.expiresAt - Date.now())
  if (
    !Number.isSafeInteger(input.sourceIndex) ||
    input.sourceIndex < 0 ||
    !Number.isSafeInteger(input.expiresAt) ||
    !Number.isSafeInteger(input.field.bytes) ||
    input.field.bytes < 2 ||
    input.field.bytes > 1000000000 ||
    !/^[0-9a-f]{64}$/.test(input.field.sha256) ||
    !brc38JsonStructuredField(input.table, input.field.field) ||
    !['canonical', 'projected'].includes(input.family) ||
    (input.family === 'projected' &&
      !(
        (input.table === 'provenTxReqs' && input.field.field === 'notify') ||
        (input.table === 'syncStates' && input.field.field === 'syncMap')
      ))
  )
    invalid()
  const check = (): void => {
    input.signal?.throwIfAborted()
    if (!isBrc38OwnedPrivateNativeWriter(k) || Date.now() >= input.expiresAt || performance.now() >= deadline) invalid()
  }
  check()
  if (active.has(k)) throw new Error('Packed field work already owns this transaction')
  active.add(k)
  let savepoint = false
  try {
    if (!(await hasBrc38NativePackedTextSchema(k))) invalid()
    await verifyBrc38AuthenticatedSourceSeal(k)
    const descriptors =
        input.family === 'canonical'
          ? readBrc38SqlCanonicalStructuredDescriptors
          : readBrc38SqlProjectedStructuredDescriptors,
      sourceChunk =
        input.family === 'canonical' ? readBrc38SqlCanonicalStructuredChunk : readBrc38SqlProjectedStructuredChunk,
      actual = (await descriptors(k, input.table, input.sourceIndex))[input.field.field]
    if (JSON.stringify(actual) !== JSON.stringify(input.field)) invalid()
    const physical = (await k(tables[coordinate.tableId])
      .where({ [keys[coordinate.tableId]]: coordinate.rowId })
      .first(k.raw('typeof(??) AS kind,length(CAST(?? AS BLOB)) AS bytes', [input.field.field, input.field.field]))) as
      { kind: string; bytes: number } | undefined
    if (physical?.kind !== 'text' || physical.bytes !== 0) invalid()
    await k.raw('SAVEPOINT __brc38_packed_text_field')
    savepoint = true
    let existing = await version(k, input.field.sha256)
    if (existing !== undefined) {
      if (
        existing.state !== 'SEALED' ||
        existing.bytes !== input.field.bytes ||
        (await hashBrc38NativePackedTextVersion(k, input.field.sha256, input.field.bytes, check)) !== input.field.sha256
      )
        invalid()
    } else {
      await k(names.versions).insert({
        sha256: input.field.sha256,
        bytes: input.field.bytes,
        accepted: 0,
        chunks: 0,
        state: 'PENDING'
      })
      const sourceDigest = createHash('sha256')
      for (let offset = 0; offset < input.field.bytes;) {
        check()
        const value = await sourceChunk(k, input.table, input.sourceIndex, input.field.field, offset)
        if (
          value === undefined ||
          value.offset !== offset ||
          value.descriptor.bytes !== input.field.bytes ||
          value.descriptor.sha256 !== input.field.sha256 ||
          value.descriptor.encoding !== input.field.encoding ||
          value.bytes.byteLength < 1 ||
          value.bytes.byteLength > Math.min(65536, input.field.bytes - offset)
        )
          invalid()
        sourceDigest.update(value.bytes)
        await k(names.chunks).insert({
          sha256: input.field.sha256,
          offset,
          bytes: value.bytes.byteLength,
          payload: Buffer.from(value.bytes),
          chunkSha256: digest(value.bytes)
        })
        offset += value.bytes.byteLength
        check()
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
      if (
        sourceDigest.digest('hex') !== input.field.sha256 ||
        (await hashBrc38NativePackedTextVersion(k, input.field.sha256, input.field.bytes, check)) !== input.field.sha256
      )
        invalid()
      if (
        (await k(names.versions)
          .where({ sha256: input.field.sha256, state: 'PENDING', accepted: input.field.bytes })
          .update({ state: 'SEALED' })) !== 1
      )
        invalid()
      existing = await version(k, input.field.sha256)
    }
    if (existing?.state !== 'SEALED') invalid()
    // The already-issued main row INSERT/UPDATE produces its journal event.
    // Pointer replacement is atomic and never rewrites the full payload row.
    await k(names.fields).where(coordinate).delete()
    await k(names.fields).insert({ ...coordinate, sha256: input.field.sha256 })
    const postimage = await readBrc38NativePackedTextDescriptor(k, {
      table: input.table,
      field: input.field.field as Brc38NativeTextRead['field'],
      rowId: input.destinationRowId
    })
    if (postimage?.bytes !== input.field.bytes || postimage.sha256 !== input.field.sha256) invalid()
    check()
    await k.raw('RELEASE __brc38_packed_text_field')
    savepoint = false
  } catch (cause) {
    const cleanup: unknown[] = []
    if (savepoint) {
      try {
        await k.raw('ROLLBACK TO __brc38_packed_text_field')
      } catch (error) {
        cleanup.push(error)
      }
      if (cleanup.length === 0)
        try {
          await k.raw('RELEASE __brc38_packed_text_field')
        } catch (error) {
          cleanup.push(error)
        }
    }
    if (cleanup.length !== 0)
      throw new AggregateError([cause, ...cleanup], 'Packed native field retains writer cleanup', { cause })
    throw cause
  } finally {
    active.delete(k)
  }
}
/** Ordinary already-bounded wallet bytes. This does not accept an arbitrary
 * source callback inside the writer. Large archive/sync fields use the actual
 * authenticated staged writer above; public legacy DTO inputs remain bounded.
 * Version, chunks, pointer and the caller's main-row/journal effects are atomic. */
export async function writeBrc38NativePackedTextBytes(
  k: Knex.Transaction,
  input: Brc38NativePackedTextCoordinate,
  bytes: Uint8Array,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  requireBrc38PackedWriter(k)
  input = Object.freeze({
    table: input.table,
    field: input.field,
    rowId: input.rowId
  }) as Brc38NativePackedTextCoordinate
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 16777216) invalid()
  const coordinate = key(input),
    content = new Uint8Array(bytes),
    sha256 = digest(content),
    deadline = performance.now() + 10000
  const check = (): void => {
    signal?.throwIfAborted()
    requireBrc38PackedWriter(k)
    if (performance.now() >= deadline) throw new Error('Packed native wallet field operation expired')
  }
  if (active.has(k)) throw new Error('Packed field work already owns this transaction')
  active.add(k)
  let savepoint = false
  try {
    if (!(await hasBrc38NativePackedTextSchema(k))) invalid()
    const physical = (await k(tables[coordinate.tableId])
      .where({ [keys[coordinate.tableId]]: coordinate.rowId })
      .first(k.raw('typeof(??) AS kind,length(CAST(?? AS BLOB)) AS bytes', [input.field, input.field]))) as
      { kind: string; bytes: number } | undefined
    if (physical?.kind !== 'text' || physical.bytes !== 0) invalid()
    await k.raw('SAVEPOINT __brc38_packed_text_wallet_field')
    savepoint = true
    const existing = await version(k, sha256)
    if (existing !== undefined) {
      if (
        existing.state !== 'SEALED' ||
        existing.bytes !== content.byteLength ||
        (await hashBrc38NativePackedTextVersion(k, sha256, content.byteLength, check)) !== sha256
      )
        invalid()
    } else {
      await k(names.versions).insert({ sha256, bytes: content.byteLength, accepted: 0, chunks: 0, state: 'PENDING' })
      for (let offset = 0; offset < content.byteLength; offset += 65536) {
        check()
        const value = content.subarray(offset, Math.min(content.byteLength, offset + 65536))
        await k(names.chunks).insert({
          sha256,
          offset,
          bytes: value.byteLength,
          payload: Buffer.from(value),
          chunkSha256: digest(value)
        })
        check()
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
      if (
        (await hashBrc38NativePackedTextVersion(k, sha256, content.byteLength, check)) !== sha256 ||
        (await k(names.versions)
          .where({ sha256, state: 'PENDING', accepted: content.byteLength })
          .update({ state: 'SEALED' })) !== 1
      )
        invalid()
    }
    await k(names.fields).where(coordinate).delete()
    await k(names.fields).insert({ ...coordinate, sha256 })
    const postimage = await readBrc38NativePackedTextDescriptor(k, input)
    if (postimage?.bytes !== content.byteLength || postimage.sha256 !== sha256) invalid()
    check()
    await k.raw('RELEASE __brc38_packed_text_wallet_field')
    savepoint = false
  } catch (cause) {
    const cleanup: unknown[] = []
    if (savepoint) {
      try {
        await k.raw('ROLLBACK TO __brc38_packed_text_wallet_field')
      } catch (error) {
        cleanup.push(error)
      }
      if (cleanup.length === 0)
        try {
          await k.raw('RELEASE __brc38_packed_text_wallet_field')
        } catch (error) {
          cleanup.push(error)
        }
    }
    if (cleanup.length !== 0)
      throw new AggregateError([cause, ...cleanup], 'Packed native wallet field retains cleanup', { cause })
    throw cause
  } finally {
    active.delete(k)
  }
}
/** One finite source-owned retirement page, under the actual serialized native
 * writer. Current pointers prevent retirement; RETIRING prevents new pointers.
 * Original versions survive while a retained read transaction can observe them.
 * SQLite retains its actual MVCC view independently of this DATA return. */
export async function retireBrc38NativePackedTextVersion(
  k: Knex.Transaction,
  sha256: string,
  maximumChunks: number,
  signal?: AbortSignal
): Promise<Readonly<{ chunks: number; complete: boolean }>> {
  signal?.throwIfAborted()
  requireBrc38PackedWriter(k)
  if (
    !/^[0-9a-f]{64}$/.test(sha256) ||
    !Number.isSafeInteger(maximumChunks) ||
    maximumChunks < 1 ||
    maximumChunks > 256 ||
    !(await hasBrc38NativePackedTextSchema(k))
  )
    invalid()
  const actual = await version(k, sha256)
  if (actual === undefined) return Object.freeze({ chunks: 0, complete: true })
  if ((await k(names.fields).where({ sha256 }).first('sha256')) !== undefined)
    return Object.freeze({ chunks: 0, complete: false })
  if (
    (await hasBrc38NativePreparedFieldsSchema(k)) &&
    (await k(nativePreparedFieldsTable).where({ family: 'text', sha256 }).first('id')) !== undefined
  )
    return Object.freeze({ chunks: 0, complete: false })
  if (actual.state === 'SEALED') {
    if ((await k(names.versions).where({ sha256, state: 'SEALED' }).update({ state: 'RETIRING' })) !== 1) invalid()
  } else if (actual.state !== 'RETIRING') invalid()
  const rows = (await k(names.chunks)
    .where({ sha256 })
    .select('offset')
    .orderBy('offset')
    .limit(maximumChunks)) as Array<{ offset: number }>
  for (const { offset } of rows) {
    signal?.throwIfAborted()
    requireBrc38PackedWriter(k)
    if ((await k(names.chunks).where({ sha256, offset }).delete()) !== 1) invalid()
  }
  const remaining = await version(k, sha256)
  if (remaining?.chunks === 0) {
    if ((await k(names.versions).where({ sha256, state: 'RETIRING', chunks: 0 }).delete()) !== 1) invalid()
    return Object.freeze({ chunks: rows.length, complete: true })
  }
  return Object.freeze({ chunks: rows.length, complete: false })
}

/** One indexed candidate and one finite chunk page. The queue records current
 * unreferenced content, not a permission or previous schema verdict. Each call
 * rechecks actual writer membership, schema and references in this transaction.
 * A retained SQLite read view continues seeing its original content after the
 * committed deletion; no journal receipt or reader descriptor is invalidated.
 * This releases logical reservations, not filesystem or WAL quota. */
export async function collectBrc38NativePackedTextGarbage(
  k: Knex.Transaction,
  maximumChunks: number,
  signal?: AbortSignal
): Promise<Readonly<{ chunks: number; complete: boolean }>> {
  signal?.throwIfAborted()
  requireBrc38PackedWriter(k)
  if (
    !Number.isSafeInteger(maximumChunks) ||
    maximumChunks < 1 ||
    maximumChunks > 256 ||
    !(await hasBrc38NativePackedTextSchema(k))
  )
    invalid()
  await retireExpiredBrc38NativePreparedFields(k, Math.min(16, maximumChunks), signal)
  const selected = (await k(names.garbage).select('sha256').orderBy('sha256').limit(1)) as Array<{ sha256: string }>
  if (selected.length === 0) return Object.freeze({ chunks: 0, complete: true })
  const sha256 = selected[0].sha256
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) invalid()
  // A reference can never coexist with a queued version in the declared
  // schema. Refuse corruption rather than deleting or silently skipping it.
  if ((await k(names.fields).where({ sha256 }).first('sha256')) !== undefined) invalid()
  const result = await retireBrc38NativePackedTextVersion(k, sha256, maximumChunks, signal)
  if (result.complete && (await k(names.garbage).where({ sha256 }).first('sha256')) !== undefined) invalid()
  requireBrc38PackedWriter(k)
  signal?.throwIfAborted()
  return Object.freeze({
    chunks: result.chunks,
    complete: result.complete && (await k(names.garbage).first('sha256')) === undefined
  })
}

/** A progress bit chooses the next family; it is never authority or a prior
 * schema/source verdict. The actual writer and both current families are checked
 * on every call. One shared finite page alternates the first family even when a
 * producer keeps it busy, then spends only unused chunks on the other family. */
export async function collectBrc38NativePackedContent(
  k: Knex.Transaction,
  maximumChunks: number,
  signal?: AbortSignal
): Promise<Readonly<{ chunks: number; complete: boolean }>> {
  signal?.throwIfAborted()
  requireBrc38PackedWriter(k)
  if (!Number.isSafeInteger(maximumChunks) || maximumChunks < 1 || maximumChunks > 256) invalid()
  if (!(await hasBrc38NativePackedTextSchema(k))) return await collectBrc38NativePackedGarbage(k, maximumChunks, signal)
  const rows = (await k(names.progress).where({ slot: 1 }).select('nextFamily').limit(2)) as Array<{
    nextFamily: number
  }>
  if (rows.length !== 1 || (rows[0].nextFamily !== 0 && rows[0].nextFamily !== 1)) invalid()
  const next = rows[0].nextFamily
  const collect = [collectBrc38NativePackedGarbage, collectBrc38NativePackedTextGarbage] as const,
    first = await collect[next](k, maximumChunks, signal)
  let chunks = first.chunks
  if (chunks < maximumChunks) chunks += (await collect[1 - next](k, maximumChunks - chunks, signal)).chunks
  signal?.throwIfAborted()
  requireBrc38PackedWriter(k)
  if (
    !(await hasBrc38NativePackedTextSchema(k)) ||
    !Number.isSafeInteger(chunks) ||
    chunks < 0 ||
    chunks > maximumChunks
  )
    invalid()
  const complete =
    (await k(nativePackedTables.garbage).first('sha256')) === undefined &&
    (await k(names.garbage).first('sha256')) === undefined
  // Alternate while either family has work. At quiescence there is no queue to
  // favor; keep one stable state so another inspection cannot change its image.
  const following = complete ? 0 : 1 - next
  if (
    following !== next &&
    (await k(names.progress).where({ slot: 1, nextFamily: next }).update({ nextFamily: following })) !== 1
  )
    invalid()
  signal?.throwIfAborted()
  requireBrc38PackedWriter(k)
  return Object.freeze({ chunks, complete })
}
