import { nativePackedTextSources } from './Brc38NativePackedTextSources'
import { hasBrc38NativePreparedFieldsSchema, nativePreparedFieldsTable } from './Brc38NativePreparedFieldSchemaNode'
import type { Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import type { Knex } from 'knex'
import type { Brc38NativeTextRead } from './Brc38NativeBlobProtocol'
import { requireBrc38PackedRead, nativePackedTables } from './Brc38NativePackedSchemaNode'
import { hasBrc38NativePackedTextSchema, nativePackedTextTables } from './Brc38NativePackedTextSchemaNode'
import {
  readBrc38NativePackedTextDescriptor,
  hashBrc38NativePackedTextVersion
} from './Brc38NativePackedTextFieldsNode'

function invalid(): never {
  throw new Error('Complete packed native TEXT inventory differs')
}
function integer(value: unknown, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) invalid()
  return value
}
const coordinates = nativePackedTextSources

/** Independently inspect actual complete immutable TEXT content and its shared
 * reservation in one retained native view. This is inventory DATA only: callers
 * still compare authenticated source originals, ID maps and current receipts,
 * and retain their own source/profile/schema/primary admission. No digest or
 * earlier successful inspection is kept as authority. */
export async function inspectBrc38NativePackedTextInventory(
  k: Knex.Transaction,
  maximumFields: number,
  signal?: AbortSignal,
  assertCurrent?: () => void,
  maximumReadBytes = 65536,
  workingAllocation?: Brc38WorkingAllocation
): Promise<Readonly<{ fields: number; bytes: number; reservedBytes: number }>> {
  integer(maximumFields, 3000000000)
  if (integer(maximumReadBytes, 65536) < 1) invalid()
  const check = (): void => {
    signal?.throwIfAborted()
    requireBrc38PackedRead(k)
    assertCurrent?.()
  }
  check()
  if (!(await hasBrc38NativePackedTextSchema(k))) invalid()
  const budget = (await k(nativePackedTextTables.budget)
    .where({ slot: 1 })
    .first('maximumLogicalBytes', 'reservedBytes')) as
    { maximumLogicalBytes: unknown; reservedBytes: unknown } | undefined
  const maximum = integer(budget?.maximumLogicalBytes, Number.MAX_SAFE_INTEGER),
    reserved = integer(budget?.reservedBytes, maximum)
  let examined = 0,
    bytes = 0
  for (const source of coordinates) {
    for (const [index, field] of source.fields.entries()) {
      const fieldId = source.first + index
      let after: number | undefined
      for (;;) {
        check()
        const query = k(nativePackedTextTables.fields).where({ tableId: source.id, fieldId })
        if (after !== undefined) query.where('rowId', '>', after)
        const pointer = (await query.orderBy('rowId').first('rowId')) as { rowId: unknown } | undefined
        if (pointer === undefined) break
        const rowId = pointer.rowId
        if (
          typeof rowId !== 'number' ||
          !Number.isSafeInteger(rowId) ||
          (after !== undefined && rowId <= after) ||
          ++examined > maximumFields
        )
          invalid()
        const descriptor = await readBrc38NativePackedTextDescriptor(k, {
          table: source.table,
          field: field as Brc38NativeTextRead['field'],
          rowId
        })
        if (
          descriptor === undefined ||
          descriptor.bytes > Number.MAX_SAFE_INTEGER - bytes ||
          (await hashBrc38NativePackedTextVersion(
            k,
            descriptor.sha256,
            descriptor.bytes,
            check,
            maximumReadBytes,
            workingAllocation
          )) !== descriptor.sha256
        )
          invalid()
        bytes += descriptor.bytes
        after = rowId
      }
      // Every nonnull main-row marker requires exactly one sealed pointer;
      // a loose marker cannot disappear merely because the pointer scan ended.
      const missing = await k(source.sql)
        .whereNotNull(field)
        .whereNotExists(
          k(nativePackedTextTables.fields)
            .select(k.raw('1'))
            .where({ tableId: source.id, fieldId })
            .whereRaw('?? = ??', [nativePackedTextTables.fields + '.rowId', source.sql + '.' + source.key])
        )
        .select(source.key)
        .limit(1)
      if (missing.length !== 0) invalid()
    }
  }
  const count = async (table: string): Promise<number> => {
    check()
    const row = (await k(table).count({ count: '*' }).first()) as { count: unknown } | undefined
    return integer(row?.count, Number.MAX_SAFE_INTEGER)
  }
  if ((await count(nativePackedTextTables.fields)) !== examined || (await count(nativePackedTextTables.garbage)) !== 0)
    invalid()
  const orphan = await k(nativePackedTextTables.versions)
    .whereNot({ state: 'SEALED' })
    .orWhereNotExists(
      k(nativePackedTextTables.fields)
        .select(k.raw('1'))
        .whereRaw('?? = ??', [nativePackedTextTables.fields + '.sha256', nativePackedTextTables.versions + '.sha256'])
    )
    .select('sha256')
    .limit(1)
  if (orphan.length !== 0) invalid()
  const orphanChunk = await k(nativePackedTextTables.chunks)
    .whereNotExists(
      k(nativePackedTextTables.versions)
        .select(k.raw('1'))
        .whereRaw('?? = ??', [nativePackedTextTables.versions + '.sha256', nativePackedTextTables.chunks + '.sha256'])
    )
    .select('offset')
    .limit(1)
  if (orphanChunk.length !== 0) invalid()
  const progress = (await k(nativePackedTextTables.progress).select('slot', 'nextFamily').limit(2)) as Array<{
    slot: unknown
    nextFamily: unknown
  }>
  if (
    progress.length !== 1 ||
    progress[0].slot !== 1 ||
    ![0, 1].includes(Number(progress[0].nextFamily)) ||
    typeof progress[0].nextFamily !== 'number'
  )
    invalid()
  if ((await hasBrc38NativePreparedFieldsSchema(k)) && (await count(nativePreparedFieldsTable)) !== 0) invalid()
  let expected = 512
  for (const family of [nativePackedTables, nativePackedTextTables]) {
    const versions = (await k(family.versions).first(k.raw('coalesce(sum(bytes+512),0) AS reserved'))) as
      { reserved: unknown } | undefined
    const charge = integer(versions?.reserved, maximum)
    const chunks = await count(family.chunks),
      fields = await count(family.fields)
    const additional = charge + 512 * (chunks + fields)
    if (!Number.isSafeInteger(additional) || additional > maximum - expected) invalid()
    expected += additional
  }
  check()
  const afterBudget = await k(nativePackedTextTables.budget)
    .where({ slot: 1 })
    .first('maximumLogicalBytes', 'reservedBytes')
  if (
    expected !== reserved ||
    JSON.stringify(afterBudget) !== JSON.stringify(budget) ||
    !(await hasBrc38NativePackedTextSchema(k))
  )
    invalid()
  check()
  return Object.freeze({ fields: examined, bytes, reservedBytes: reserved })
}
