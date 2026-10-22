import { promiseFromSync } from '../../utility/promiseFromSync'
import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import type { Brc38StageTable } from './Brc38SemanticStage'
import { brc38JsonStructuredField } from './Brc38JsonStructuredFields'
import { brc38JsonTextField } from './Brc38JsonTextFields'
import { brc38JsonBinaryField } from './Brc38JsonBinaryFields'
import { requireBrc38PackedRead } from './Brc38NativePackedSchemaNode'
import { detachBrc38PrivateChunk } from './Brc38PrivateChunkPipe'

export type Brc38SqlStructuredChunkTable =
  | 'private_binary_chunks'
  | 'private_structured_chunks'
  | 'private_canonical_structured_chunks'
  | 'private_projected_structured_chunks'
  | 'private_text_chunks'
export interface Brc38SqlStructuredChunkCoordinate {
  readonly tableName: Brc38StageTable
  readonly position: number
  readonly field: string
  readonly offset: number
}
interface Extent {
  bytes: number
  actualBytes: number
  kind: string
  sha256: string | null
}
function invalid(): never {
  throw new Error('Actual bounded structured SQL chunk content differs')
}

/** Fresh full physical-chunk hashing in a genuine retained native view. The
 * caller owns exact schema, source membership and original resource admission.
 * Every visitor byte is provisional until this operation completes; it may
 * update only privately owned hash/range state. No stored digest supplies a
 * verdict. This bounds JavaScript transfer, not SQLite's internal memory. */
export async function visitBrc38SqlStructuredChunkWindows(
  k: Knex.Transaction,
  table: Brc38SqlStructuredChunkTable,
  selected: Brc38SqlStructuredChunkCoordinate,
  maximumReadBytes: number,
  check: () => void,
  visit: (bytes: Uint8Array, offset: number) => void
): Promise<Readonly<{ bytes: number; sha256: string }>> {
  requireBrc38PackedRead(k)
  return await visitChunkWindows(k, table, selected, maximumReadBytes, check, visit, () => {
    return promiseFromSync(() => {
      requireBrc38PackedRead(k)
    })
  })
}
/** Provisional archive staging precedes authenticated native handoff. The
 * actual store owns its exclusive physical/source lease; this helper verifies
 * an actual query-only transaction and returns byte/hash DATA only. It cannot
 * admit an import, a native actor, a writer or an authenticated source. */
export async function visitBrc38SqlProvisionalStructuredChunkWindows(
  k: Knex.Transaction,
  table: Exclude<Brc38SqlStructuredChunkTable, 'private_projected_structured_chunks'>,
  selected: Brc38SqlStructuredChunkCoordinate,
  maximumReadBytes: number,
  check: () => void,
  visit: (bytes: Uint8Array, offset: number) => void
): Promise<Readonly<{ bytes: number; sha256: string }>> {
  if (
    table !== 'private_binary_chunks' &&
    table !== 'private_structured_chunks' &&
    table !== 'private_canonical_structured_chunks' &&
    table !== 'private_text_chunks'
  )
    invalid()
  const assertRead = async (): Promise<void> => {
    check()
    if (k.isTransaction !== true) invalid()
    const value = (await k.raw('PRAGMA query_only')) as Array<{ query_only: number }>
    if (value.length !== 1 || value[0].query_only !== 1) invalid()
    check()
  }
  return await visitChunkWindows(k, table, selected, maximumReadBytes, check, visit, assertRead)
}
async function visitChunkWindows(
  k: Knex.Transaction,
  table: Brc38SqlStructuredChunkTable,
  selected: Brc38SqlStructuredChunkCoordinate,
  maximumReadBytes: number,
  check: () => void,
  visit: (bytes: Uint8Array, offset: number) => void,
  assertRead: () => Promise<void>
): Promise<Readonly<{ bytes: number; sha256: string }>> {
  await assertRead()
  const coordinate = Object.freeze({
    tableName: selected.tableName,
    position: selected.position,
    field: selected.field,
    offset: selected.offset
  })
  if (
    ![
      'private_binary_chunks',
      'private_structured_chunks',
      'private_canonical_structured_chunks',
      'private_projected_structured_chunks',
      'private_text_chunks'
    ].includes(table) ||
    !(table === 'private_binary_chunks'
      ? brc38JsonBinaryField(coordinate.tableName, coordinate.field)
      : table === 'private_text_chunks'
        ? brc38JsonTextField(coordinate.tableName, coordinate.field)
        : brc38JsonStructuredField(coordinate.tableName, coordinate.field)) ||
    !Number.isSafeInteger(coordinate.position) ||
    coordinate.position < 0 ||
    coordinate.position >= 1000000000 ||
    !Number.isSafeInteger(coordinate.offset) ||
    coordinate.offset < 0 ||
    coordinate.offset >= 1000000000 ||
    !Number.isSafeInteger(maximumReadBytes) ||
    maximumReadBytes < 1 ||
    maximumReadBytes > 65536
  )
    invalid()
  const extent = async (): Promise<Extent> => {
    check()
    await assertRead()
    const value = (await k(table)
      .where(coordinate)
      .first(
        'bytes',
        k.raw('typeof(payload) AS kind,length(payload) AS actualBytes'),
        k.raw('CASE WHEN length(CAST(sha256 AS BLOB))=64 THEN sha256 ELSE NULL END AS sha256')
      )) as Extent | undefined
    check()
    await assertRead()
    if (
      value === undefined ||
      !Number.isSafeInteger(value.bytes) ||
      value.bytes < 1 ||
      value.bytes > 65536 ||
      value.actualBytes !== value.bytes ||
      value.kind !== 'blob' ||
      typeof value.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.sha256)
    )
      invalid()
    return value
  }
  const original = await extent(),
    hash = createHash('sha256')
  for (let offset = 0; offset < original.bytes;) {
    check()
    await assertRead()
    const amount = Math.min(maximumReadBytes, original.bytes - offset),
      row = (await k(table)
        .where(coordinate)
        .first(k.raw('substr(payload,?,?) AS payload', [offset + 1, amount]))) as { payload: Uint8Array } | undefined
    if (row === undefined) invalid()
    let bytes: Uint8Array | undefined
    try {
      check()
      await assertRead()
      bytes = detachBrc38PrivateChunk(row.payload, amount)
      if (bytes.byteLength !== amount) invalid()
      hash.update(bytes)
      visit(bytes, offset)
      offset += amount
    } finally {
      bytes?.fill(0)
      if (row.payload instanceof Uint8Array) Reflect.apply(Uint8Array.prototype.fill, row.payload, [0])
    }
    check()
    await assertRead()
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
  const digest = hash.digest('hex'),
    current = await extent()
  if (digest !== original.sha256 || current.bytes !== original.bytes || current.sha256 !== original.sha256) invalid()
  return Object.freeze({ bytes: original.bytes, sha256: digest })
}
