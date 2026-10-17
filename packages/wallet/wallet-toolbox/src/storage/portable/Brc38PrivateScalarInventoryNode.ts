import type { Knex } from 'knex'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import type { Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import type { Brc38NativeLocalBaselineTable } from './Brc38NativeLocalBaselineTables'
import { brc38ImportTableOrder, brc38ImportRowForm } from './Brc38ImportForms'
import { brc38ImportTargetIndexes } from './Brc38ImportTargetIndexes'
import { nextBrc38PrivateMergeTargetAlias } from './Brc38PrivateMergeTargetsNode'
import {
  selectBrc38ScalarMergeMetadata,
  type Brc38ScalarMergeTable,
  type Brc38ScalarMergeMetadata
} from './Brc38ImportScalarMergeNode'
import { loadBrc38ImportIdMap, type Brc38ImportIdReference } from './Brc38ImportIdMap'
import { decodePortableRow, type PortableRow } from './Brc38PortableRows'
import { brc38WorkingAllocation, type Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'

const tables: readonly Brc38ScalarMergeTable[] = Object.freeze([
  'outputBaskets',
  'outputTags',
  'txLabels',
  'txLabelMaps',
  'outputTagMaps'
])
function invalid(): never {
  throw new Error(
    'Private scalar semantic inventory differs from the complete local baseline, original ordered aliases or destination rows'
  )
}
function integer(value: unknown, nonnegative = false): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || (nonnegative && value < 0)) invalid()
  return value
}
function metadata(input: Readonly<Record<string, unknown>>): Brc38ScalarMergeMetadata {
  const value: Record<string, unknown> = {}
  for (const [field, item] of Object.entries(input)) {
    if (typeof item === 'bigint') {
      if (item < -9007199254740991n || item > 9007199254740991n) invalid()
      value[field] = Number(item)
    } else if (item === null) value[field] = undefined
    else if (item instanceof Date) value[field] = new Date(item.getTime())
    else if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean' || item === undefined)
      value[field] = item
    else invalid()
  }
  for (const field of ['created_at', 'updated_at']) {
    const item = value[field]
    if (!(item instanceof Date) && typeof item !== 'string' && typeof item !== 'number') invalid()
    const date = item instanceof Date ? item : new Date(item)
    if (!Number.isFinite(date.getTime())) invalid()
    value[field] = date
  }
  value.isDeleted =
    value.isDeleted !== undefined && value.isDeleted !== null && value.isDeleted !== false && value.isDeleted !== 0
  return value as Brc38ScalarMergeMetadata
}
function sqlMetadata(value: Brc38ScalarMergeMetadata): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {}
  for (const [field, item] of Object.entries(value)) {
    if (item instanceof Date) result[field] = item.toISOString()
    else if (typeof item === 'boolean') result[field] = item ? 1n : 0n
    else if (typeof item === 'number') {
      if (!Number.isFinite(item)) invalid()
      result[field] = Number.isInteger(item) ? BigInt(item) : item
    } else result[field] = item === undefined ? null : item
  }
  return Object.freeze(result)
}
/** All five metadata-only families, including local rows untouched by an
 * archive. The two physical keysets are walked together; each new row needs
 * at least one exact ordered incoming alias. Complete current metadata is
 * reconstructed from the retained local source and original timestamp policy.
 * No writer, cached verdict, READY record or cutover permission is created. */
export async function inspectBrc38PrivateScalarInventory(
  store: KnexBrc38StagingStore,
  source: Brc38NativeLocalBaselineSource,
  k: Knex.Transaction,
  selected: Readonly<{
    admission: Brc38ImportJournalAdmission
    maximumRows: number
    workingAllocation: Brc38WorkingAllocation
    signal?: AbortSignal
  }>
): Promise<Readonly<{ rows: number; aliases: number }>> {
  const working = brc38WorkingAllocation(selected.workingAllocation),
    admission = selected.admission,
    signal = selected.signal,
    deadline = performance.now() + Math.max(0, store.operationExpiresAt - Date.now()),
    binding = store.binding,
    maximumRows = integer(selected.maximumRows, true)
  if (
    working === undefined ||
    binding === undefined ||
    maximumRows < 1 ||
    maximumRows > 10000000 ||
    working.maximum > store.limits.maximumRowAllocationBytes ||
    admission.expiresAt !== store.limits.expiresAt ||
    admission.scope.bindingSha256 !== binding.digest ||
    admission.scope.archiveSha256 !== binding.binding.archiveSha256 ||
    admission.originalLimitsJson !== binding.limitsJson
  )
    invalid()
  const frame = working.claim(2097152),
    offsets = new Map<string, number>(),
    counts = new Map<string, number>(),
    check = (): void => {
      signal?.throwIfAborted()
      if (store.binding !== binding || Date.now() >= store.operationExpiresAt || performance.now() >= deadline)
        invalid()
      store.assertPrivateNativeReadTransaction(k)
      Brc38NativeLocalBaselineSource.assertSharedWorking(source, working)
    }
  let rows = 0,
    aliases = 0
  try {
    check()
    await verifyBrc38AuthenticatedSourceSeal(k)
    let offset = 1
    for (const table of brc38ImportTableOrder) {
      const values = (await k('table_counts').where({ tableName: table }).select('rows').limit(2)) as Array<{
        rows: unknown
      }>
      if (values.length !== 1) invalid()
      const count = integer(values[0].rows, true)
      if (count > store.limits.maximumRows) invalid()
      offsets.set(table, offset)
      counts.set(table, count)
      offset += count
      if (!Number.isSafeInteger(offset) || offset > admission.totalRows) invalid()
    }
    if (offset !== admission.totalRows) invalid()
    for (const table of tables) {
      const [sql] = brc38ImportTargetIndexes[table],
        localTable = sql as Brc38NativeLocalBaselineTable,
        form = brc38ImportRowForm(table)
      let afterSource: number | null = null,
        afterActual: number | null = null
      for (;;) {
        check()
        const sourceKeys = await Brc38NativeLocalBaselineSource.ownedPage(source, localTable, afterSource, 1),
          query = k(sql).select(k.raw('rowid AS physical')).orderBy('rowid').limit(1)
        if (afterActual !== null) query.whereRaw('rowid > CAST(? AS INTEGER)', [BigInt(afterActual).toString()])
        const actualKeys = (await query.options({ safeIntegers: true })) as Array<{ physical: bigint }>
        if (actualKeys.length === 0) {
          if (sourceKeys.length !== 0) invalid()
          break
        }
        const physical = actualKeys[0].physical
        if (
          typeof physical !== 'bigint' ||
          physical < -9007199254740991n ||
          physical > 9007199254740991n ||
          sourceKeys.length > 1 ||
          (sourceKeys.length === 1 && BigInt(sourceKeys[0]) < physical) ||
          ++rows > maximumRows
        )
          invalid()
        const rowId = Number(physical),
          baseline = sourceKeys.length === 1 && sourceKeys[0] === rowId
        const inspect = async (original: Readonly<Record<string, unknown>> | undefined): Promise<void> => {
          const originalBytes = Object.values(original ?? {}).reduce<number>(
            (sum, value) => sum + (typeof value === 'string' ? Buffer.byteLength(value) : 16),
            0
          )
          let retained = working.claim(131072 + 32 * originalBytes)
          try {
            let current = original === undefined ? undefined : metadata(original),
              expected = original,
              aliasCursor = 0,
              touched = false
            for (;;) {
              check()
              const next = await nextBrc38PrivateMergeTargetAlias(k, admission, table, rowId, aliasCursor)
              if (next === undefined) break
              const position = next - offsets.get(table)!
              if (position < 0 || position >= counts.get(table)! || ++aliases > store.limits.maximumRows) invalid()
              const extent = (await k('rows')
                .where({ tableName: table, position })
                .select(
                  'bytes',
                  k.raw("CASE WHEN typeof(payload)='text' THEN length(CAST(payload AS BLOB)) END AS actualBytes")
                )
                .limit(2)) as Array<{ bytes: unknown; actualBytes: unknown }>
              if (extent.length !== 1) invalid()
              const bytes = integer(extent[0].bytes, true)
              if (bytes < 1 || bytes > store.limits.maximumRowBytes || extent[0].actualBytes !== bytes) invalid()
              const allocation = working.claim(131072 + 64 * bytes)
              let keepAllocation = false
              try {
                const values = (await k('rows')
                  .where({ tableName: table, position })
                  .select('payload')
                  .limit(2)) as Array<{ payload: string }>
                if (
                  values.length !== 1 ||
                  typeof values[0].payload !== 'string' ||
                  Buffer.byteLength(values[0].payload) !== bytes
                )
                  invalid()
                const fields = JSON.parse(values[0].payload) as PortableRow,
                  incoming = metadata(decodePortableRow<Record<string, unknown>>(form.kind, fields)),
                  references: Brc38ImportIdReference[] = []
                if (form.entity !== undefined && form.id !== undefined) {
                  const incomingId = incoming[form.id]
                  if (typeof incomingId !== 'number' || !Number.isInteger(incomingId)) invalid()
                  references.push({ entity: form.entity, incomingId, required: true })
                }
                for (const parent of form.parents) {
                  const incomingId = incoming[parent.field]
                  if (typeof incomingId !== 'number' || !Number.isInteger(incomingId)) invalid()
                  references.push({ entity: parent.entity, incomingId, required: true })
                }
                const loaded = await loadBrc38ImportIdMap(k, admission.scope, references)
                if (
                  form.entity !== undefined &&
                  form.id !== undefined &&
                  integer(loaded.map[form.entity].idMap[incoming[form.id] as number]) !== rowId
                )
                  invalid()
                const selectedMetadata = selectBrc38ScalarMergeMetadata(table, incoming, current)
                if (selectedMetadata !== undefined) {
                  if (current === undefined) {
                    if (Object.hasOwn(selectedMetadata, 'userId')) selectedMetadata.userId = admission.scope.userId
                    if (form.id !== undefined) selectedMetadata[form.id] = rowId
                    for (const parent of form.parents)
                      selectedMetadata[parent.field] = integer(
                        loaded.map[parent.entity].idMap[incoming[parent.field] as number]
                      )
                    retained.close()
                    retained = allocation
                    keepAllocation = true
                  }
                  current = selectedMetadata
                  expected = sqlMetadata(current)
                }
                touched = true
                aliasCursor = next
              } finally {
                if (!keepAllocation) allocation.close()
              }
            }
            if (expected === undefined || (!baseline && !touched)) invalid()
            const names = Object.keys(expected),
              columns = (await k.raw(
                'SELECT CASE WHEN length(CAST(name AS BLOB))<=128 THEN name END AS name FROM pragma_table_info(?) ORDER BY cid LIMIT 65',
                [sql]
              )) as Array<{ name: string | null }>
            if (
              columns.length !== names.length ||
              columns.length > 64 ||
              columns.some(column => column.name === null || !Object.hasOwn(expected!, column.name))
            )
              invalid()
            const sizes = (await k(sql)
              .whereRaw('rowid=CAST(? AS INTEGER)', [physical.toString()])
              .select(
                k.raw(
                  '(' +
                    names
                      .map(
                        () =>
                          "CASE WHEN typeof(??) IN ('integer','real','null') THEN 8 ELSE coalesce(length(CAST(?? AS BLOB)),0) END"
                      )
                      .join('+') +
                    ') AS bytes',
                  names.flatMap(name => [name, name])
                )
              )
              .limit(2)) as Array<{ bytes: unknown }>
            if (sizes.length !== 1) invalid()
            const bytes = integer(sizes[0].bytes, true)
            if (bytes > 131072) invalid()
            const allocation = working.claim(131072 + 32 * bytes)
            try {
              const actual = (await k(sql)
                .whereRaw('rowid=CAST(? AS INTEGER)', [physical.toString()])
                .select(names)
                .limit(2)
                .options({ safeIntegers: true })) as Array<Record<string, unknown>>
              if (actual.length !== 1 || names.some(name => !Object.is(actual[0][name], expected![name]))) invalid()
            } finally {
              allocation.close()
            }
          } finally {
            retained.close()
          }
        }
        if (baseline)
          await Brc38NativeLocalBaselineSource.withOwnedRow(source, localTable, rowId, async row => {
            if (row.fields.length !== 0) invalid()
            await inspect(row.metadata)
          })
        else await inspect(undefined)
        afterActual = rowId
        if (baseline) afterSource = rowId
      }
    }
    check()
    return Object.freeze({ rows, aliases })
  } finally {
    frame.close()
  }
}
