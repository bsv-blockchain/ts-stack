import { nativePackedTextSources, nativePackedTextSource } from './Brc38NativePackedTextSources'
import { isBrc38NativePackedWalletTable, brc38NativePackedWalletFields } from './Brc38NativePackedWalletNode'
import type { Brc38NativeBlobRead } from './Brc38NativeBlobProtocol'
import type { Knex } from 'knex'
import { createHash } from 'node:crypto'
import { hasBrc38NativePackedTextSchema } from './Brc38NativePackedTextSchemaNode'
import {
  readBrc38NativePackedTextDescriptor,
  readBrc38NativePackedTextExtent,
  writeBrc38NativePackedTextBytes,
  collectBrc38NativePackedContent,
  brc38NativePackedTextLength
} from './Brc38NativePackedTextFieldsNode'
import type { Brc38NativeTextRead } from './Brc38NativeBlobProtocol'
import { brc38NativeTextCoordinate } from './Brc38NativeBlobProtocol'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import { readBrc38NativePackedDescriptor } from './Brc38NativePackedFieldsNode'

export type Brc38NativePackedTextWalletTable = (typeof nativePackedTextSources)[number]['sql']
export function isBrc38NativePackedTextWalletTable(table: string): table is Brc38NativePackedTextWalletTable {
  return nativePackedTextSources.some(source => source.sql === table)
}
export function brc38NativePackedTextWalletFields(table: Brc38NativePackedTextWalletTable): readonly string[] {
  return nativePackedTextSource(table).fields
}
async function walletRowId(
  k: Knex.Transaction,
  table: Brc38NativePackedTextWalletTable,
  row: Readonly<Record<string, unknown>>
): Promise<number> {
  let id: unknown = row[nativePackedTextSource(table).key]
  if (table === 'certificate_fields') {
    const actual: Array<{ rowid: number }> = await k('certificate_fields')
      .where({ certificateId: row.certificateId, fieldName: row.fieldName, userId: row.userId })
      .select('rowid')
      .limit(2)
    if (actual.length !== 1) invalid()
    id = actual[0].rowid
  }
  if (typeof id !== 'number' || !Number.isSafeInteger(id)) invalid()
  return id
}
const maximumAllocation = 16777216
function invalid(): never {
  throw new Error('Native packed TEXT DTO differs from its actual current metadata/content')
}
/** The actual caller has just inspected this transaction's exact schema. This
 * expression selects logical allocation before any marker/payload row fetch. */
export function brc38NativePackedTextWalletRowCharge(
  k: Knex.Transaction,
  table: Brc38NativePackedTextWalletTable,
  metadata: readonly string[],
  base: Knex.Raw
): Knex.Raw {
  if (metadata.length > 64) invalid()
  const fields = nativePackedTextSource(table).fields.filter(field => metadata.includes(field)),
    lengths = fields.map(field =>
      brc38NativePackedTextLength(k, {
        table: nativePackedTextSource(table).table,
        field: field as Brc38NativeTextRead['field']
      })
    )
  if (lengths.length === 0) return base
  return k.raw(
    `CASE WHEN ${lengths.map(() => '(?)<0').join(' OR ')} THEN NULL ELSE ? + ${lengths.map(() => '16*coalesce((?),0)+512').join(' + ')} END`,
    [...lengths, base, ...lengths]
  )
}
/** Exact equality for a precharged ordinary string. The caller freshly checks
 * the actual TEXT schema in this transaction before selecting this expression.
 * Every actual chunk is compared with the expected bounded bytes; a hash match
 * is never substituted for string equality, pagination or count semantics. */
export function applyBrc38NativePackedTextWhere(
  q: Knex.QueryBuilder,
  table: Brc38NativePackedTextWalletTable,
  field: Brc38NativeTextRead['field'],
  value: string,
  alias: string = table
): void {
  if (
    !nativePackedTextSource(table).fields.some(name => name === field) ||
    typeof value !== 'string' ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(alias)
  )
    invalid()
  prechargeBrc38NativePackedTextWalletWrite(table, { [field]: value })
  const bytes = Buffer.from(value, 'utf8'),
    coordinate = brc38NativeTextCoordinate(nativePackedTextSource(table).table, field)
  void q.whereRaw(
    `EXISTS(SELECT 1 FROM brc38_native_text_fields f JOIN brc38_native_text_versions v ON v.sha256=f.sha256 WHERE f.tableId=? AND f.rowId=??.?? AND f.fieldId=? AND v.state='SEALED' AND v.accepted=v.bytes AND v.bytes=? AND typeof(??.??)='text' AND length(CAST(??.?? AS BLOB))=0 AND (SELECT count(*) FROM brc38_native_text_chunks c WHERE c.sha256=f.sha256)=v.chunks AND coalesce((SELECT sum(c.bytes) FROM brc38_native_text_chunks c WHERE c.sha256=f.sha256),0)=v.bytes AND NOT EXISTS(SELECT 1 FROM brc38_native_text_chunks c WHERE c.sha256=f.sha256 AND (typeof(c.payload)!='blob' OR length(c.payload)!=c.bytes OR c.offset<0 OR c.bytes<1 OR c.bytes>65536 OR c.offset+c.bytes>v.bytes OR c.payload!=substr(?,c.offset+1,c.bytes) OR (c.offset!=0 AND NOT EXISTS(SELECT 1 FROM brc38_native_text_chunks p WHERE p.sha256=c.sha256 AND p.offset+p.bytes=c.offset)))))`,
    [
      coordinate[0],
      alias,
      nativePackedTextSource(table).key,
      coordinate[1],
      bytes.byteLength,
      alias,
      field,
      alias,
      field,
      bytes
    ]
  )
}
export function prechargeBrc38NativePackedTextWalletWrite(
  table: Brc38NativePackedTextWalletTable,
  input: object
): void {
  const row = input as Record<string, unknown>
  let allocation = 262144
  for (const field of nativePackedTextSource(table).fields) {
    const value = row[field]
    if (!Object.hasOwn(row, field) || value == null) continue
    if (typeof value !== 'string') invalid()
    if (value.length > Math.floor((maximumAllocation - allocation - 512) / 16))
      throw new SnapshotResourceLimitError(
        'Native packed binary and TEXT write exceed their combined finite allocation'
      )
    allocation += 16 * Buffer.byteLength(value, 'utf8') + 512
  }
  if (isBrc38NativePackedWalletTable(table))
    for (const field of brc38NativePackedWalletFields(table)) {
      const value = row[field]
      if (!Object.hasOwn(row, field) || value == null) continue
      if (!(value instanceof Uint8Array) && !Array.isArray(value)) invalid()
      allocation += 16 * value.length + 512
    }
  if (!Number.isSafeInteger(allocation) || allocation > maximumAllocation)
    throw new SnapshotResourceLimitError('Native packed binary and TEXT write exceed their combined finite allocation')
}
/** Precharge both field families before the FIRST payload read. This is an
 * allocation check, not a descriptor/schema/source verdict retained for reads. */
export async function prechargeBrc38NativePackedTextWalletRows(
  k: Knex,
  table: Brc38NativePackedTextWalletTable,
  rows: object[]
): Promise<void> {
  const trx = k as Knex.Transaction
  if (!(await hasBrc38NativePackedTextSchema(trx))) invalid()
  let allocation = 262144
  for (const value of rows) {
    const row = value as Record<string, unknown>,
      rowId = await walletRowId(trx, table, row)
    if (typeof rowId !== 'number' || !Number.isSafeInteger(rowId)) invalid()
    for (const field of nativePackedTextSource(table).fields)
      if (Object.hasOwn(row, field)) {
        const actual = await readBrc38NativePackedTextDescriptor(trx, {
          table: nativePackedTextSource(table).table,
          field: field as Brc38NativeTextRead['field'],
          rowId
        })
        if (actual !== undefined) allocation += 16 * actual.bytes + 512
      }
    if (isBrc38NativePackedWalletTable(table))
      for (const field of brc38NativePackedWalletFields(table))
        if (Object.hasOwn(row, field)) {
          const actual = await readBrc38NativePackedDescriptor(trx, {
            table: nativePackedTextSource(table).table as Brc38NativeBlobRead['table'],
            field: field as Brc38NativeBlobRead['field'],
            rowId
          })
          if (actual !== undefined) allocation += 16 * actual.bytes + 512
        }
    if (!Number.isSafeInteger(allocation) || allocation > maximumAllocation)
      throw new SnapshotResourceLimitError(
        'Native packed binary and TEXT read exceed their combined finite page allocation'
      )
  }
}
/** Preserve exact ordinary string spelling, including duplicates/whitespace.
 * Portable archive projection is independent. Precharge every string before
 * UTF8 copies; never accept source callbacks inside an ordinary wallet writer. */
export function prepareBrc38NativePackedTextWalletWrite(
  table: Brc38NativePackedTextWalletTable,
  input: object
): Readonly<{
  row: Record<string, unknown>
  fields: ReadonlyArray<
    Readonly<{
      field: Brc38NativeTextRead['field']
      bytes: Uint8Array
    }>
  >
}> {
  const row = { ...input } as Record<string, unknown>,
    fields: Array<{ field: Brc38NativeTextRead['field']; bytes: Uint8Array }> = []
  let allocation = 262144
  prechargeBrc38NativePackedTextWalletWrite(table, input)
  for (const name of nativePackedTextSource(table).fields) {
    if (!Object.hasOwn(row, name) || row[name] == null) continue
    const value = row[name]
    if (typeof value !== 'string') invalid()
    allocation += 16 * value.length + 512
    if (!Number.isSafeInteger(allocation) || allocation > maximumAllocation)
      throw new SnapshotResourceLimitError(
        'Native packed ordinary TEXT write exceeds its finite allocation; use private staged streaming'
      )
  }
  for (const name of nativePackedTextSource(table).fields) {
    if (!Object.hasOwn(row, name) || row[name] == null) continue
    fields.push({ field: name as Brc38NativeTextRead['field'], bytes: new TextEncoder().encode(row[name] as string) })
    row[name] = ''
  }
  return Object.freeze({ row, fields: Object.freeze(fields) })
}
export async function finishBrc38NativePackedTextWalletWrite(
  k: Knex,
  table: Brc38NativePackedTextWalletTable,
  rowId: number,
  fields: ReturnType<typeof prepareBrc38NativePackedTextWalletWrite>['fields'],
  maximumCollectionChunks: 0 | 16 = 16
): Promise<void> {
  if (maximumCollectionChunks !== 0 && maximumCollectionChunks !== 16) invalid()
  if (fields.length > nativePackedTextSource(table).fields.length) invalid()
  let allocation = 262144
  for (const value of fields) {
    if (
      !nativePackedTextSource(table).fields.some(field => field === value.field) ||
      !(value.bytes instanceof Uint8Array)
    )
      invalid()
    allocation += 16 * value.bytes.byteLength + 512
    if (!Number.isSafeInteger(allocation) || allocation > maximumAllocation)
      throw new SnapshotResourceLimitError('Native packed TEXT finish exceeds its finite allocation')
  }
  const fixed = fields.map(value => ({ field: value.field, bytes: new Uint8Array(value.bytes) }))
  try {
    if (!(await hasBrc38NativePackedTextSchema(k as Knex.Transaction))) invalid()
    for (const value of fixed)
      await writeBrc38NativePackedTextBytes(
        k as Knex.Transaction,
        { table: nativePackedTextSource(table).table, field: value.field, rowId },
        value.bytes
      )
    if (maximumCollectionChunks !== 0)
      await collectBrc38NativePackedContent(k as Knex.Transaction, maximumCollectionChunks)
  } finally {
    for (const value of fixed) value.bytes.fill(0)
  }
}
/** One precharged bounded page of original legacy string DTOs. No TEXT marker,
 * descriptor or hash can escape as the actual string. Oversize history must use
 * the retained extent interface; total field size cannot grow the read queue. */
export async function hydrateBrc38NativePackedTextWalletRows<T extends object>(
  k: Knex,
  table: Brc38NativePackedTextWalletTable,
  rows: T[]
): Promise<T[]> {
  const trx = k as Knex.Transaction
  if (!(await hasBrc38NativePackedTextSchema(trx))) invalid()
  const spec = nativePackedTextSource(table),
    pending: Array<{
      row: Record<string, unknown>
      field: Brc38NativeTextRead['field']
      rowId: number
      bytes: number
      sha256: string
    }> = []
  let allocation = 262144
  for (const value of rows) {
    const row = value as Record<string, unknown>,
      rowId = await walletRowId(trx, table, row)
    if (typeof rowId !== 'number' || !Number.isSafeInteger(rowId)) invalid()
    for (const name of spec.fields) {
      if (!Object.hasOwn(row, name)) continue
      const field = name as Brc38NativeTextRead['field'],
        descriptor = await readBrc38NativePackedTextDescriptor(trx, { table: spec.table, field, rowId })
      if (row[name] == null) {
        if (descriptor !== undefined) invalid()
        continue
      }
      if (row[name] !== '' || descriptor === undefined) invalid()
      allocation += 16 * descriptor.bytes + 512
      if (!Number.isSafeInteger(allocation) || allocation > maximumAllocation)
        throw new SnapshotResourceLimitError(
          'Native packed ordinary TEXT read exceeds its finite page allocation; use logical extents'
        )
      pending.push({ row, field, rowId, ...descriptor })
    }
  }
  for (const item of pending) {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }),
      parts: string[] = [],
      digest = createHash('sha256')
    for (let offset = 0; offset < item.bytes;) {
      const length = Math.min(65536, item.bytes - offset),
        bytes = await readBrc38NativePackedTextExtent(trx, {
          table: spec.table,
          field: item.field,
          rowId: item.rowId,
          offset,
          totalBytes: item.bytes,
          length
        })
      digest.update(bytes)
      parts.push(decoder.decode(bytes, { stream: true }))
      offset += bytes.byteLength
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    parts.push(decoder.decode())
    const after = await readBrc38NativePackedTextDescriptor(trx, {
      table: spec.table,
      field: item.field,
      rowId: item.rowId
    })
    if (after?.bytes !== item.bytes || after.sha256 !== item.sha256 || digest.digest('hex') !== item.sha256) invalid()
    item.row[item.field] = parts.join('')
  }
  return rows
}
