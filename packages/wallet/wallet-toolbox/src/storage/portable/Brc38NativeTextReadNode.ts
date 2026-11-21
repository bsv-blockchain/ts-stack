import { nativePackedTextSource } from './Brc38NativePackedTextSources'
import type { Knex } from 'knex'
import {
  brc38NativeTextCoordinate,
  brc38NativeTextProtocolSupports,
  encodeBrc38NativeTextRead,
  type Brc38NativeTextRead
} from './Brc38NativeBlobProtocol'
import { detachBrc38PrivateChunk } from './Brc38PrivateChunkPipe'
import { hasBrc38NativePackedTextSchema } from './Brc38NativePackedTextSchemaNode'
import {
  readBrc38NativePackedTextDescriptor,
  readBrc38NativePackedTextExtent,
  readBrc38NativePackedTextPhysicalBytes
} from './Brc38NativePackedTextFieldsNode'
import { ownedNativeRootIdentity } from '../schema/ownedNativeSqliteConnectionsNode'

interface NativeTextReader {
  isOwnedNativeTransaction(value: unknown): boolean
  readOwnedNativeText(trx: Knex.Transaction, input: Brc38NativeTextRead): Promise<Uint8Array>
}
const driver: NativeTextReader = require('./NativeProfileSqlite.cjs')
function actual(trx: Knex.Transaction): void {
  if (!driver.isOwnedNativeTransaction(trx)) throw new Error('An actual retained native TEXT view is required')
}
/** Raw-cell transport is addressed by physical SQLite rowid. Packed pointers
 * are addressed by the portable wallet key, so resolve it in this SAME actual
 * retained view; never assume the two coordinates coincide. */
async function packedKey(trx: Knex.Transaction, input: Pick<Brc38NativeTextRead, 'table' | 'rowId'>): Promise<number> {
  actual(trx)
  const { sql: table, key: column } = nativePackedTextSource(input.table),
    row = (await trx(table).whereRaw('rowid=?', [input.rowId]).first(column)) as Record<string, unknown> | undefined,
    key = row?.[column]
  if (typeof key !== 'number' || !Number.isSafeInteger(key))
    throw new Error('Native TEXT physical row has no actual portable wallet key')
  actual(trx)
  return key
}
/** Lower transport metadata only. The coherent profile/source factory owns
 * admission before every call. A label/config/digest or earlier match cannot
 * create a producer. The native function opens an incremental read handle and
 * returns its byte length, without SQL casts/full-field JavaScript cloning. */
export async function readBrc38NativeTextBytes(
  trx: Knex.Transaction,
  input: Pick<Brc38NativeTextRead, 'table' | 'field' | 'rowId'>,
  signal?: AbortSignal
): Promise<number | null> {
  signal?.throwIfAborted()
  actual(trx)
  const coordinate = brc38NativeTextCoordinate(input.table, input.field),
    rowId = input.rowId
  if (!Number.isSafeInteger(rowId)) throw new TypeError('Invalid native TEXT metadata row')
  if (ownedNativeRootIdentity(trx)?.slot === 3) {
    const bytes = await readBrc38NativePackedTextPhysicalBytes(trx, input, signal)
    if (bytes !== undefined) return bytes
  } else if (await hasBrc38NativePackedTextSchema(trx)) {
    const key = await packedKey(trx, input),
      descriptor = await readBrc38NativePackedTextDescriptor(trx, { ...input, rowId: key })
    signal?.throwIfAborted()
    actual(trx)
    if ((await packedKey(trx, input)) !== key) throw new Error('Native TEXT retained physical key changed')
    return descriptor?.bytes ?? null
  }
  const rows = (await trx.raw(
    'SELECT brc38_text_read_protocol() AS abi,brc38_text_extent_bytes(CAST(? AS INTEGER),CAST(? AS INTEGER),CAST(? AS INTEGER)) AS bytes',
    [coordinate[0], coordinate[1], rowId]
  )) as Array<{ abi: number; bytes: number | null }>
  signal?.throwIfAborted()
  actual(trx)
  if (
    rows.length !== 1 ||
    !brc38NativeTextProtocolSupports(input.table, rows[0].abi) ||
    (rows[0].bytes !== null &&
      (!Number.isSafeInteger(rows[0].bytes) || rows[0].bytes < 0 || rows[0].bytes > 1000000000))
  )
    throw new Error('Native TEXT metadata differs from its actual retained view')
  return rows[0].bytes
}
/** One exact <=64KiB UTF8 range from the original actual TEXT cell, on the
 * same native transaction. Descriptor size is DATA and freshly checked before
 * and after the read; this neither parses JSON nor admits a source profile. */
export async function readBrc38NativeTextExtent(
  trx: Knex.Transaction,
  selected: Brc38NativeTextRead,
  signal?: AbortSignal
): Promise<Uint8Array> {
  signal?.throwIfAborted()
  actual(trx)
  const input = { ...selected }
  encodeBrc38NativeTextRead(input)
  if (await hasBrc38NativePackedTextSchema(trx)) {
    const key = await packedKey(trx, input),
      value = await readBrc38NativePackedTextExtent(trx, { ...input, rowId: key }, signal)
    signal?.throwIfAborted()
    actual(trx)
    if ((await packedKey(trx, input)) !== key) throw new Error('Native TEXT retained physical key changed')
    return value
  }
  if ((await readBrc38NativeTextBytes(trx, input, signal)) !== input.totalBytes)
    throw new Error('Native TEXT length differs before extent read')
  const value = detachBrc38PrivateChunk(await driver.readOwnedNativeText(trx, input), 65536)
  signal?.throwIfAborted()
  actual(trx)
  if (value.length !== input.length || (await readBrc38NativeTextBytes(trx, input, signal)) !== input.totalBytes)
    throw new Error('Native TEXT length differs after extent read')
  return value
}
