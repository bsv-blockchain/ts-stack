import { createHash, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { isOwnedNativeSqlite } from '../schema/ownedNativeSqliteRuntimeNode'
import { brc38NativeLocalPackedSources } from './Brc38NativeLocalPackedLayout'
import { hasBrc38NativeLocalPackedLayout } from './Brc38NativeLocalPackedLayoutNode'
import {
  hasBrc38NativePackedSchema,
  requireBrc38PackedRead,
  requireBrc38PackedWriter
} from './Brc38NativePackedSchemaNode'
import { hasBrc38NativePackedTextSchema } from './Brc38NativePackedTextSchemaNode'
import {
  readBrc38NativePackedDescriptor,
  readBrc38NativePackedExtent,
  writeBrc38NativePackedBytes,
  brc38NativePackedLength
} from './Brc38NativePackedFieldsNode'
import {
  readBrc38NativePackedTextDescriptor,
  readBrc38NativePackedTextExtent,
  writeBrc38NativePackedTextBytes,
  brc38NativePackedTextLength,
  collectBrc38NativePackedContent
} from './Brc38NativePackedTextFieldsNode'
import type {
  Brc38NativePackedBinaryCoordinate,
  Brc38NativePackedTextCoordinate
} from './Brc38NativeLocalPackedCoordinate'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

export type Brc38NativeLocalPackedWalletTable = (typeof brc38NativeLocalPackedSources)[number]['table']
const maximumAllocation = 16777216
function invalid(): never {
  throw new Error('Native local logical field differs from its actual row, content or original bounded DTO')
}
function spec(table: Brc38NativeLocalPackedWalletTable) {
  const source = brc38NativeLocalPackedSources.find(value => value.table === table)
  if (source === undefined) invalid()
  return source
}
async function actual(k: Knex.Transaction, writer = false): Promise<void> {
  if (writer) requireBrc38PackedWriter(k)
  else requireBrc38PackedRead(k)
  if (
    !(await hasBrc38NativeLocalPackedLayout(k)) ||
    !(await hasBrc38NativePackedSchema(k)) ||
    !(await hasBrc38NativePackedTextSchema(k))
  )
    invalid()
}
/** Fresh actual transaction selection only. Ordinary stock and base-packed
 * auxiliary storage retains its established path when this layout is absent. */
export async function withBrc38NativeLocalPackedWalletTransaction<T>(
  k: Knex,
  work: (database: Knex, localPacked: boolean) => Promise<T>
): Promise<T> {
  if (!isOwnedNativeSqlite(k)) return await work(k, false)
  const run = async (trx: Knex.Transaction): Promise<T> => {
    const selected = await hasBrc38NativeLocalPackedLayout(trx)
    if (selected) await actual(trx)
    return await work(trx, selected)
  }
  return k.isTransaction ? await run(k as Knex.Transaction) : await k.transaction(run)
}
/** A caller may catch a helper failure inside a larger transaction. Preserve
 * row/pointer atomicity with an independently owned real savepoint too. */
export async function withBrc38NativeLocalPackedWalletMutation<T>(
  k: Knex,
  work: (database: Knex, localPacked: boolean) => Promise<T>
): Promise<T> {
  return await withBrc38NativeLocalPackedWalletTransaction(k, async (database, packed) => {
    if (!packed) return await work(database, false)
    const trx = database as Knex.Transaction,
      savepoint = '__brc38_local_' + randomUUID().replaceAll('-', '')
    await actual(trx, true)
    await trx.raw('SAVEPOINT ' + savepoint)
    try {
      const result = await work(database, true)
      await actual(trx, true)
      await trx.raw('RELEASE ' + savepoint)
      return result
    } catch (cause) {
      try {
        await trx.raw('ROLLBACK TO ' + savepoint)
        await trx.raw('RELEASE ' + savepoint)
      } catch (error_) {
        throw new AggregateError([cause, error_], 'Local logical row retains real savepoint cleanup failure', {
          cause
        })
      }
      throw cause
    }
  })
}
export function brc38NativeLocalPackedWalletLength(
  k: Knex.Transaction,
  table: Brc38NativeLocalPackedWalletTable,
  field: string
): Knex.Raw {
  const source = spec(table)
  if (!(source.fields as readonly string[]).includes(field)) invalid()
  return source.kind === 'binary'
    ? brc38NativePackedLength(k, { table, field } as Omit<Brc38NativePackedBinaryCoordinate, 'rowId'>)
    : brc38NativePackedTextLength(k, { table, field } as Omit<Brc38NativePackedTextCoordinate, 'rowId'>)
}
export interface Brc38NativeLocalPackedWalletField {
  readonly field: string
  readonly kind: 'binary' | 'text'
  readonly bytes: Uint8Array
}
/** Already bounded foreground DTO only. Large transfer/import producers keep
 * using their separate staged/version extent protocol outside short writers. */
export function prepareBrc38NativeLocalPackedWalletWrite(
  table: Brc38NativeLocalPackedWalletTable,
  input: object
): Readonly<{ row: Record<string, unknown>; fields: readonly Readonly<Brc38NativeLocalPackedWalletField>[] }> {
  const source = spec(table),
    row = { ...input } as Record<string, unknown>,
    fields: Readonly<Brc38NativeLocalPackedWalletField>[] = []
  let allocation = 262144
  // Admit the combined fields before allocating any copies.
  for (const field of source.fields) {
    const value = row[field]
    if (!Object.hasOwn(row, field) || value == null) continue
    let bytes: number
    if (source.kind === 'text') {
      if (typeof value !== 'string') invalid()
      bytes = Buffer.byteLength(value)
    } else {
      if (!(value instanceof Uint8Array) && !Array.isArray(value)) invalid()
      bytes = value.length
    }
    allocation += 16 * bytes + 512
    if (!Number.isSafeInteger(allocation) || allocation > maximumAllocation)
      throw new SnapshotResourceLimitError(
        'Native local foreground fields exceed their combined finite allocation; use staged extents'
      )
  }
  for (const field of source.fields) {
    const value = row[field]
    if (!Object.hasOwn(row, field) || value == null) continue
    if (Array.isArray(value) && value.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) invalid()
    const bytes =
      source.kind === 'text' ? Buffer.from(value as string, 'utf8') : new Uint8Array(value as Uint8Array | number[])
    fields.push(Object.freeze({ field, kind: source.kind, bytes }))
    row[field] = source.kind === 'text' ? '' : Buffer.alloc(0)
  }
  return Object.freeze({ row, fields: Object.freeze(fields) })
}
export function releaseBrc38NativeLocalPackedWalletWrite(
  prepared: ReturnType<typeof prepareBrc38NativeLocalPackedWalletWrite>
): void {
  for (const field of prepared.fields) field.bytes.fill(0)
}
export async function finishBrc38NativeLocalPackedWalletWrite(
  k: Knex.Transaction,
  table: Brc38NativeLocalPackedWalletTable,
  rowId: number,
  fields: readonly Readonly<Brc38NativeLocalPackedWalletField>[],
  collect = true
): Promise<void> {
  await actual(k, true)
  if (!Number.isSafeInteger(rowId) || typeof collect !== 'boolean') invalid()
  const source = spec(table)
  for (const field of fields) {
    if (field.kind !== source.kind || !(source.fields as readonly string[]).includes(field.field)) invalid()
    if (field.kind === 'binary')
      await writeBrc38NativePackedBytes(
        k,
        { table, field: field.field, rowId } as Brc38NativePackedBinaryCoordinate,
        field.bytes
      )
    else
      await writeBrc38NativePackedTextBytes(
        k,
        { table, field: field.field, rowId } as Brc38NativePackedTextCoordinate,
        field.bytes
      )
  }
  if (collect) await collectBrc38NativePackedContent(k, 16)
}
/** Precharge the complete result before reading the first logical payload.
 * A zero/empty physical marker is never returned as a complete auxiliary DTO. */
export async function hydrateBrc38NativeLocalPackedWalletRows<T extends object>(
  k: Knex.Transaction,
  table: Brc38NativeLocalPackedWalletTable,
  rows: T[],
  maximumFieldBytes = maximumAllocation
): Promise<T[]> {
  await actual(k)
  if (!Number.isSafeInteger(maximumFieldBytes) || maximumFieldBytes < 0 || maximumFieldBytes > maximumAllocation)
    invalid()
  const source = spec(table),
    pending: Array<{ row: Record<string, unknown>; field: string; rowId: number; bytes: number; sha256: string }> = []
  let allocation = 262144
  for (const value of rows) {
    const row = value as Record<string, unknown>,
      id = source.key === 'rowid' ? row.__brc38LocalPhysicalRowId : row[source.key]
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) invalid()
    for (const field of source.fields) {
      if (!Object.hasOwn(row, field)) continue
      const coordinate = { table, field, rowId: id },
        descriptor =
          source.kind === 'binary'
            ? await readBrc38NativePackedDescriptor(k, coordinate as Brc38NativePackedBinaryCoordinate)
            : await readBrc38NativePackedTextDescriptor(k, coordinate as Brc38NativePackedTextCoordinate),
        marker = row[field]
      if (marker === null) {
        if (descriptor !== undefined) invalid()
        continue
      }
      if (source.kind === 'binary' ? !(marker instanceof Uint8Array) || marker.byteLength !== 0 : marker !== '')
        invalid()
      if (descriptor === undefined || descriptor.bytes > maximumFieldBytes) invalid()
      allocation += 16 * descriptor.bytes + 512
      if (!Number.isSafeInteger(allocation) || allocation > maximumAllocation)
        throw new SnapshotResourceLimitError(
          'Native local foreground result exceeds its combined finite allocation; use logical extents'
        )
      pending.push({ row, field, rowId: id, bytes: descriptor.bytes, sha256: descriptor.sha256 })
    }
  }
  for (const item of pending) {
    const output = new Uint8Array(item.bytes),
      hash = createHash('sha256')
    try {
      for (let offset = 0; offset < item.bytes;) {
        const length = Math.min(65536, item.bytes - offset),
          input = { table, field: item.field, rowId: item.rowId, offset, totalBytes: item.bytes, length },
          chunk =
            source.kind === 'binary'
              ? await readBrc38NativePackedExtent(k, input as Brc38NativePackedBinaryCoordinate & typeof input)
              : await readBrc38NativePackedTextExtent(k, input as Brc38NativePackedTextCoordinate & typeof input)
        try {
          if (chunk.byteLength !== length) invalid()
          output.set(chunk, offset)
          hash.update(chunk)
        } finally {
          chunk.fill(0)
        }
        offset += length
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
      if (hash.digest('hex') !== item.sha256) invalid()
      item.row[item.field] =
        source.kind === 'binary' ? Buffer.from(output) : new TextDecoder('utf-8', { fatal: true }).decode(output)
    } finally {
      output.fill(0)
    }
  }
  for (const value of rows)
    if (source.key === 'rowid') delete (value as Record<string, unknown>).__brc38LocalPhysicalRowId
  return rows
}
/** Exact logical equality for a bounded foreground string. NULL predicates
 * retain the ordinary nullable cell semantics; this helper admits only text. */
export function applyBrc38NativeLocalPackedTextWhere(
  query: Knex.QueryBuilder,
  table: Brc38NativeLocalPackedWalletTable,
  field: string,
  value: string
): void {
  const source = spec(table)
  if (source.kind !== 'text' || !(source.fields as readonly string[]).includes(field) || typeof value !== 'string')
    invalid()
  const prepared = prepareBrc38NativeLocalPackedWalletWrite(table, { [field]: value })
  try {
    const bytes = prepared.fields[0].bytes,
      ordinal = (source.fields as readonly string[]).indexOf(field)
    void query.whereRaw(
      `EXISTS(SELECT 1 FROM brc38_native_text_fields f JOIN brc38_native_text_versions v ON v.sha256=f.sha256 WHERE f.tableId=? AND f.rowId=??.?? AND f.fieldId=? AND v.state='SEALED' AND v.accepted=v.bytes AND v.bytes=? AND typeof(??.??)='text' AND length(CAST(??.?? AS BLOB))=0 AND (SELECT count(*) FROM brc38_native_text_chunks c WHERE c.sha256=f.sha256)=v.chunks AND coalesce((SELECT sum(c.bytes) FROM brc38_native_text_chunks c WHERE c.sha256=f.sha256),0)=v.bytes AND NOT EXISTS(SELECT 1 FROM brc38_native_text_chunks c WHERE c.sha256=f.sha256 AND (typeof(c.payload)!='blob' OR length(c.payload)!=c.bytes OR c.offset<0 OR c.bytes<1 OR c.bytes>65536 OR c.offset+c.bytes>v.bytes OR c.payload!=substr(?,c.offset+1,c.bytes) OR (c.offset!=0 AND NOT EXISTS(SELECT 1 FROM brc38_native_text_chunks p WHERE p.sha256=c.sha256 AND p.offset+p.bytes=c.offset)))))`,
      [source.id, table, source.key, ordinal, bytes.byteLength, table, field, table, field, Buffer.from(bytes)]
    )
  } finally {
    releaseBrc38NativeLocalPackedWalletWrite(prepared)
  }
}

/** One legacy binary packet with its caller's explicit negotiated byte bound.
 * This uses bounded extents and typed bytes, never a number-array multiplier or
 * a whole SQL payload. Large packet callers still own their whole-result limit. */
export async function readBrc38NativeLocalPackedBinaryPacket(
  k: Knex.Transaction,
  table: Brc38NativeLocalPackedWalletTable,
  rowId: number,
  maximumBytes: number
): Promise<Uint8Array> {
  await actual(k)
  const source = spec(table)
  if (
    source.kind !== 'binary' ||
    source.fields.length !== 1 ||
    !Number.isSafeInteger(rowId) ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 0 ||
    maximumBytes > 67108864
  )
    invalid()
  const field = source.fields[0],
    coordinate = { table, field, rowId } as Brc38NativePackedBinaryCoordinate,
    descriptor = await readBrc38NativePackedDescriptor(k, coordinate)
  if (descriptor === undefined || descriptor.bytes > maximumBytes) invalid()
  const output = new Uint8Array(descriptor.bytes),
    hash = createHash('sha256')
  try {
    for (let offset = 0; offset < output.byteLength;) {
      const length = Math.min(65536, output.byteLength - offset),
        chunk = await readBrc38NativePackedExtent(k, { ...coordinate, offset, totalBytes: output.byteLength, length })
      try {
        if (chunk.byteLength !== length) invalid()
        output.set(chunk, offset)
        hash.update(chunk)
      } finally {
        chunk.fill(0)
      }
      offset += length
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    if (hash.digest('hex') !== descriptor.sha256) invalid()
    return output
  } catch (cause) {
    output.fill(0)
    throw cause
  }
}
