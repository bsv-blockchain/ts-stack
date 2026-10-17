import { retireExpiredBrc38NativePreparedFields } from './Brc38NativePreparedFieldsNode'
import { hasBrc38NativePreparedFieldsSchema, nativePreparedFieldsTable } from './Brc38NativePreparedFieldSchemaNode'
import type { Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import type { Brc38NativeBlobWrite } from './Brc38NativeBlobProtocol'
import {
  brc38NativePackedBinaryCoordinate,
  validateBrc38NativePackedBinaryRead,
  type Brc38NativePackedBinaryCoordinate,
  type Brc38NativePackedBinaryRead
} from './Brc38NativeLocalPackedCoordinate'
import type { Brc38JsonStreamedField } from './Brc38JsonBinaryFields'
import { brc38JsonBinaryField } from './Brc38JsonBinaryFields'
import { readBrc38SqlBinaryDescriptors, readBrc38SqlBinaryChunk } from './Brc38SqlBinaryStaging'
import {
  hasBrc38NativePackedSchema,
  nativePackedTables as names,
  requireBrc38PackedRead,
  requireBrc38PackedWriter
} from './Brc38NativePackedSchemaNode'
import { isBrc38OwnedPrivateNativeWriter } from './KnexBrc38StagingStore'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'
import { detachBrc38PrivateChunk } from './Brc38PrivateChunkPipe'
import { hashBrc38NativePackedChunkWindows } from './Brc38NativePackedHashWindowNode'

const tables: Readonly<Record<number, string>> = Object.freeze({
  0: 'transactions',
  1: 'proven_txs',
  2: 'proven_tx_reqs',
  3: 'outputs',
  4: 'commissions',
  8: 'prepared_beefs',
  9: 'action_batch_blobs',
  10: 'sync_transfer_parts',
  14: 'snapshot_reconciliation_stage_pages',
  15: 'snapshot_reconciliation_provenance'
})
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
function key(input: Brc38NativePackedBinaryCoordinate): Key {
  // Use the independently specified fixed coordinate ABI without allocating
  // payload bytes. A key is DATA and confers no SQL/transaction authority.
  const [tableId, fieldId] = brc38NativePackedBinaryCoordinate(input)
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
/** Current descriptor DATA only, on the actual retained private/published view.
 * Every caller still admits its actual source/profile/schema/primary context. */
export async function readBrc38NativePackedDescriptor(
  k: Knex.Transaction,
  input: Brc38NativePackedBinaryCoordinate
): Promise<Readonly<{ bytes: number; sha256: string }> | undefined> {
  requireBrc38PackedRead(k)
  const selected = key(input)
  if (!(await hasBrc38NativePackedSchema(k))) invalid()
  const physical = (await k(tables[selected.tableId])
    .whereRaw('rowid=?', [selected.rowId])
    .first(k.raw('typeof(??) AS kind,length(??) AS bytes', [input.field, input.field]))) as
    { kind: string; bytes: number | null } | undefined
  if (physical === undefined || (physical.kind !== 'null' && (physical.kind !== 'blob' || physical.bytes !== 0)))
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
/** Metadata expression for the declared packed layout. A NULL source cell stays
 * NULL; a nonnull marker without a sealed pointer returns the invalid -1
 * sentinel, including empty logical content. The caller first checks
 * the exact current packed schema on this retained native view. */
export function brc38NativePackedLength(
  k: Knex.Transaction,
  input: Omit<Brc38NativePackedBinaryCoordinate, 'rowId'>
): Knex.Raw {
  requireBrc38PackedRead(k)
  const selected = key({ ...input, rowId: 1 } as Brc38NativePackedBinaryCoordinate),
    table = tables[selected.tableId]
  return k.raw(
    `CASE WHEN ??.?? IS NULL THEN NULL WHEN typeof(??.??)!='blob' OR length(??.??)!=0 THEN -1 ELSE coalesce((SELECT v.bytes FROM brc38_native_binary_fields f JOIN brc38_native_binary_versions v ON v.sha256=f.sha256 WHERE f.tableId=? AND f.rowId=??.rowid AND f.fieldId=? AND v.state='SEALED' AND v.accepted=v.bytes),-1) END`,
    [table, input.field, table, input.field, table, input.field, selected.tableId, table, selected.fieldId]
  )
}
/** One bounded logical extent from actual immutable physical <=64KiB chunks.
 * Each physical chunk's bytes/hash is verified before copying; metadata-only
 * row updates therefore never load/rewrite a large full payload record. */
export async function readBrc38NativePackedExtent(
  k: Knex.Transaction,
  input: Brc38NativePackedBinaryRead,
  signal?: AbortSignal
): Promise<Uint8Array> {
  signal?.throwIfAborted()
  requireBrc38PackedRead(k)
  validateBrc38NativePackedBinaryRead(input)
  const fixed = {
      table: input.table,
      field: input.field,
      rowId: input.rowId,
      offset: input.offset,
      length: input.length,
      totalBytes: input.totalBytes
    } as Brc38NativePackedBinaryRead,
    actual = await readBrc38NativePackedDescriptor(k, fixed)
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
    const after = await readBrc38NativePackedDescriptor(k, fixed)
    if (after?.bytes !== actual.bytes || after.sha256 !== actual.sha256) invalid()
    return output
  } catch (cause) {
    output.fill(0)
    throw cause
  }
}
/** Independently hashes actual bounded chunk postimages. Expected SHA, SEALED,
 * original descriptors and previous matches never become a reusable verdict. */
export async function hashBrc38NativePackedVersion(
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
    !(await hasBrc38NativePackedSchema(k))
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
export interface Brc38PrivatePackedFieldSelection {
  readonly table: Brc38NativeBlobWrite['table']
  readonly sourceIndex: number
  readonly destinationRowId: number
  readonly field: Brc38JsonStreamedField
  readonly expiresAt: number
  readonly signal?: AbortSignal
}
const active = new WeakSet<Knex.Transaction>()
/** Private authenticated restore only. One actual writer savepoint installs a
 * complete content-addressed version and its logical field pointer. Main rows
 * contain only small metadata/empty physical BLOB markers; those markers never
 * escape as complete DTOs. Chunk/version/ref/budget and caller journal effects
 * remain in the SAME transaction. No network/source callback runs here. */
export async function writeBrc38PrivatePackedField(
  k: Knex.Transaction,
  selected: Brc38PrivatePackedFieldSelection
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
      expiresAt: selected.expiresAt,
      signal: selected.signal
    },
    coordinate = key({
      table: input.table,
      field: input.field.field as Brc38NativeBlobWrite['field'],
      rowId: input.destinationRowId
    }),
    deadline = performance.now() + Math.max(0, input.expiresAt - Date.now())
  if (
    !Number.isSafeInteger(input.sourceIndex) ||
    input.sourceIndex < 0 ||
    !Number.isSafeInteger(input.expiresAt) ||
    !Number.isSafeInteger(input.field.bytes) ||
    input.field.bytes < 0 ||
    input.field.bytes > 1000000000 ||
    !/^[0-9a-f]{64}$/.test(input.field.sha256) ||
    !brc38JsonBinaryField(input.table, input.field.field)
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
    if (!(await hasBrc38NativePackedSchema(k))) invalid()
    await verifyBrc38AuthenticatedSourceSeal(k)
    const actual = (await readBrc38SqlBinaryDescriptors(k, input.table, input.sourceIndex))[input.field.field]
    if (JSON.stringify(actual) !== JSON.stringify(input.field)) invalid()
    const physical = (await k(tables[coordinate.tableId])
      .whereRaw('rowid=?', [coordinate.rowId])
      .first(k.raw('typeof(??) AS kind,length(??) AS bytes', [input.field.field, input.field.field]))) as
      { kind: string; bytes: number } | undefined
    if (physical?.kind !== 'blob' || physical.bytes !== 0) invalid()
    await k.raw('SAVEPOINT __brc38_packed_field')
    savepoint = true
    let existing = await version(k, input.field.sha256)
    if (existing !== undefined) {
      if (
        existing.state !== 'SEALED' ||
        existing.bytes !== input.field.bytes ||
        (await hashBrc38NativePackedVersion(k, input.field.sha256, input.field.bytes, check)) !== input.field.sha256
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
        const value = await readBrc38SqlBinaryChunk(k, input.table, input.sourceIndex, input.field.field, offset)
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
        (await hashBrc38NativePackedVersion(k, input.field.sha256, input.field.bytes, check)) !== input.field.sha256
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
    const postimage = await readBrc38NativePackedDescriptor(k, {
      table: input.table,
      field: input.field.field as Brc38NativeBlobWrite['field'],
      rowId: input.destinationRowId
    })
    if (postimage?.bytes !== input.field.bytes || postimage.sha256 !== input.field.sha256) invalid()
    check()
    await k.raw('RELEASE __brc38_packed_field')
    savepoint = false
  } catch (cause) {
    const cleanup: unknown[] = []
    if (savepoint) {
      try {
        await k.raw('ROLLBACK TO __brc38_packed_field')
      } catch (error) {
        cleanup.push(error)
      }
      if (cleanup.length === 0)
        try {
          await k.raw('RELEASE __brc38_packed_field')
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
export async function writeBrc38NativePackedBytes(
  k: Knex.Transaction,
  input: Brc38NativePackedBinaryCoordinate,
  bytes: Uint8Array,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  requireBrc38PackedWriter(k)
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
    if (!(await hasBrc38NativePackedSchema(k))) invalid()
    const physical = (await k(tables[coordinate.tableId])
      .whereRaw('rowid=?', [coordinate.rowId])
      .first(k.raw('typeof(??) AS kind,length(??) AS bytes', [input.field, input.field]))) as
      { kind: string; bytes: number } | undefined
    if (physical?.kind !== 'blob' || physical.bytes !== 0) invalid()
    await k.raw('SAVEPOINT __brc38_packed_wallet_field')
    savepoint = true
    const existing = await version(k, sha256)
    if (existing !== undefined) {
      if (
        existing.state !== 'SEALED' ||
        existing.bytes !== content.byteLength ||
        (await hashBrc38NativePackedVersion(k, sha256, content.byteLength, check)) !== sha256
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
        (await hashBrc38NativePackedVersion(k, sha256, content.byteLength, check)) !== sha256 ||
        (await k(names.versions)
          .where({ sha256, state: 'PENDING', accepted: content.byteLength })
          .update({ state: 'SEALED' })) !== 1
      )
        invalid()
    }
    await k(names.fields).where(coordinate).delete()
    await k(names.fields).insert({ ...coordinate, sha256 })
    const postimage = await readBrc38NativePackedDescriptor(k, input)
    if (postimage?.bytes !== content.byteLength || postimage.sha256 !== sha256) invalid()
    check()
    await k.raw('RELEASE __brc38_packed_wallet_field')
    savepoint = false
  } catch (cause) {
    const cleanup: unknown[] = []
    if (savepoint) {
      try {
        await k.raw('ROLLBACK TO __brc38_packed_wallet_field')
      } catch (error) {
        cleanup.push(error)
      }
      if (cleanup.length === 0)
        try {
          await k.raw('RELEASE __brc38_packed_wallet_field')
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
export async function retireBrc38NativePackedVersion(
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
    !(await hasBrc38NativePackedSchema(k))
  )
    invalid()
  const actual = await version(k, sha256)
  if (actual === undefined) return Object.freeze({ chunks: 0, complete: true })
  if ((await k(names.fields).where({ sha256 }).first('sha256')) !== undefined)
    return Object.freeze({ chunks: 0, complete: false })
  if (
    (await hasBrc38NativePreparedFieldsSchema(k)) &&
    (await k(nativePreparedFieldsTable).where({ family: 'binary', sha256 }).first('id')) !== undefined
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
export async function collectBrc38NativePackedGarbage(
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
    !(await hasBrc38NativePackedSchema(k))
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
  const result = await retireBrc38NativePackedVersion(k, sha256, maximumChunks, signal)
  if (result.complete && (await k(names.garbage).where({ sha256 }).first('sha256')) !== undefined) invalid()
  requireBrc38PackedWriter(k)
  signal?.throwIfAborted()
  return Object.freeze({
    chunks: result.chunks,
    complete: result.complete && (await k(names.garbage).first('sha256')) === undefined
  })
}
