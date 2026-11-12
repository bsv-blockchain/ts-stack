import { hasBrc38NativePackedSchema } from './Brc38NativePackedSchemaNode'
import { readBrc38NativePackedExtent } from './Brc38NativePackedFieldsNode'
import type { Knex } from 'knex'
import type { Brc38NativeBlobRead } from './Brc38NativeBlobProtocol'
import { detachBrc38PrivateChunk } from './Brc38PrivateChunkPipe'

interface NativeReader {
  isOwnedNativeTransaction: (value: unknown) => boolean
  readOwnedNativeBlob: (trx: Knex.Transaction, input: Brc38NativeBlobRead) => Promise<Uint8Array>
}
const driver: NativeReader = require('./NativeProfileSqlite.cjs')
/** Lower transport membership only. The retained source/private/published
 * factory must authenticate its current view before calling this function. */
export function isBrc38NativeBinaryReadTransaction(value: Knex.Transaction): boolean
export function isBrc38NativeBinaryReadTransaction(value: unknown): value is Knex.Transaction
export function isBrc38NativeBinaryReadTransaction(value: unknown): boolean {
  return driver.isOwnedNativeTransaction(value)
}
/** No SQL substring, whole-field transfer, authority cache or synthetic reader.
 * The C driver reads directly into its bounded packet, on the same native view. */
export async function readBrc38NativeBinaryExtent(
  trx: Knex.Transaction,
  input: Brc38NativeBlobRead,
  signal?: AbortSignal
): Promise<Uint8Array> {
  signal?.throwIfAborted()
  if (!driver.isOwnedNativeTransaction(trx)) throw new Error('An actual retained native binary view is required')
  if (await hasBrc38NativePackedSchema(trx)) return await readBrc38NativePackedExtent(trx, input, signal)
  const value = await driver.readOwnedNativeBlob(trx, input)
  signal?.throwIfAborted()
  if (!driver.isOwnedNativeTransaction(trx)) throw new Error('Native binary view ended during its extent read')
  const result = detachBrc38PrivateChunk(value, 65536)
  if (result.byteLength !== input.length) throw new Error('Native binary extent length differs')
  return result
}
/** Legacy DTO reads may materialize ONLY an already precharged bounded result.
 * SQLite still reads one <=64KiB extent at a time, and total wallet/field size
 * never changes this queue. Large-field transfer uses the extent API instead. */
export async function readBrc38NativeBinaryRange(
  trx: Knex.Transaction,
  input: Brc38NativeBlobRead,
  maximumOutputBytes: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  signal?.throwIfAborted()
  if (
    !driver.isOwnedNativeTransaction(trx) ||
    !Number.isSafeInteger(maximumOutputBytes) ||
    maximumOutputBytes < 0 ||
    maximumOutputBytes > 16777216 ||
    !Number.isSafeInteger(input.length) ||
    input.length < 0 ||
    input.length > maximumOutputBytes ||
    !Number.isSafeInteger(input.offset) ||
    input.offset < 0 ||
    !Number.isSafeInteger(input.totalBytes) ||
    input.totalBytes < 0 ||
    input.totalBytes > 1000000000 ||
    input.offset > input.totalBytes - input.length
  )
    throw new Error('Native binary range exceeds its precharged bounded result')
  const output = new Uint8Array(input.length)
  for (let at = 0; at < output.byteLength;) {
    const length = Math.min(65536, output.byteLength - at),
      chunk = await readBrc38NativeBinaryExtent(trx, { ...input, offset: input.offset + at, length }, signal)
    output.set(chunk, at)
    at += chunk.byteLength
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
  signal?.throwIfAborted()
  if (!driver.isOwnedNativeTransaction(trx)) throw new Error('Native binary range lost its retained view')
  return output
}
