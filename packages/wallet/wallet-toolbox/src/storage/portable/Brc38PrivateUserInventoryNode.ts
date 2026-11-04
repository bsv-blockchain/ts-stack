import type { Knex } from 'knex'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import type { Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import type { TableUser } from '../schema/tables'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import { decodePortableRow, type PortableRow } from './Brc38PortableRows'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'
import { brc38WorkingAllocation, type Brc38WorkingAllocation } from './Brc38WorkingAllocation'

const columns = Object.freeze(['created_at', 'updated_at', 'userId', 'identityKey', 'activeStorage'])
function invalid(): never {
  throw new Error('Private user inventory differs from its original physical rows or header timestamp policy')
}
function integer(value: unknown): number {
  const result = typeof value === 'bigint' ? Number(value) : value
  if (
    typeof result !== 'number' ||
    !Number.isSafeInteger(result) ||
    (typeof value === 'bigint' && BigInt(result) !== value)
  )
    invalid()
  return result
}
function timestamp(value: unknown): Date {
  if (!(value instanceof Date) && typeof value !== 'string' && typeof value !== 'number') invalid()
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (!Number.isFinite(date.getTime())) invalid()
  return date
}
/** User rows are never restored from archived user IDs. The occupied merge
 * updates only the selected user's timestamp, only when the actual header is
 * newer. Every other original cell and physical key remains byte/type exact.
 * This operation runs inside the genuine private read view and returns counts,
 * never a saved inventory verdict or activation permission. */
export async function inspectBrc38PrivateUserInventory(
  store: KnexBrc38StagingStore,
  source: Brc38NativeLocalBaselineSource,
  k: Knex.Transaction,
  selected: Readonly<{
    admission: Brc38ImportJournalAdmission
    maximumRows: number
    workingAllocation: Brc38WorkingAllocation
    signal?: AbortSignal
  }>
): Promise<Readonly<{ rows: number; updated: boolean }>> {
  const admission = selected.admission,
    binding = store.binding,
    working = brc38WorkingAllocation(selected.workingAllocation),
    maximumRows = integer(selected.maximumRows),
    signal = selected.signal,
    deadline = performance.now() + Math.max(0, store.operationExpiresAt - Date.now())
  if (
    working === undefined ||
    binding === undefined ||
    maximumRows < 1 ||
    maximumRows > 10000000 ||
    admission.scope.bindingSha256 !== binding.digest ||
    admission.scope.archiveSha256 !== binding.binding.archiveSha256 ||
    admission.originalLimitsJson !== binding.limitsJson ||
    admission.expiresAt !== store.limits.expiresAt ||
    working.maximum > store.limits.maximumRowAllocationBytes
  )
    invalid()
  const check = (): void => {
      signal?.throwIfAborted()
      if (store.binding !== binding || Date.now() >= store.operationExpiresAt || performance.now() >= deadline)
        invalid()
      store.assertPrivateNativeReadTransaction(k)
      Brc38NativeLocalBaselineSource.assertSharedWorking(source, working)
      if (
        source.fence.userId !== admission.scope.userId ||
        source.fence.identityKey !== binding.binding.identityKey ||
        source.fence.chain !== binding.binding.chain ||
        source.fence.targetStorageIdentityKey !== binding.binding.targetStorageIdentityKey
      )
        invalid()
    },
    frame = working.claim(131072)
  let rows = 0,
    targetRows = 0,
    updated = false
  try {
    check()
    await verifyBrc38AuthenticatedSourceSeal(k)
    const schema = (await k.raw(
      'SELECT CASE WHEN length(CAST(name AS BLOB))<=128 THEN name END AS name FROM pragma_table_info(?) ORDER BY cid LIMIT 6',
      ['users']
    )) as Array<{ name: string | null }>
    if (schema.length !== columns.length || schema.some(row => row.name === null || !columns.includes(row.name)))
      invalid()
    const extents = (await k('metadata')
      .where({ slot: 1 })
      .select(
        k.raw("CASE WHEN state='sealed' AND typeof(header)='text' THEN length(CAST(header AS BLOB)) END AS bytes")
      )
      .limit(2)) as Array<{ bytes: unknown }>
    if (extents.length !== 1) invalid()
    const bytes = integer(extents[0].bytes)
    if (bytes < 1 || bytes > store.limits.maximumRowBytes) invalid()
    const headerCharge = working.claim(131072 + 64 * bytes)
    try {
      const headers = (await k('metadata').where({ slot: 1 }).select('header').limit(2)) as Array<{ header: unknown }>
      if (
        headers.length !== 1 ||
        typeof headers[0].header !== 'string' ||
        Buffer.byteLength(headers[0].header) !== bytes
      )
        invalid()
      const header = JSON.parse(headers[0].header) as { user?: PortableRow }
      if (header === null || typeof header !== 'object' || header.user === undefined) invalid()
      const incoming = decodePortableRow<TableUser>('user', header.user),
        incomingTime = timestamp(incoming.updated_at)
      if (incoming.identityKey !== binding.binding.identityKey) invalid()
      let after: number | null = null
      for (;;) {
        check()
        const sourceKeys = await Brc38NativeLocalBaselineSource.ownedPage(source, 'users', after, 1),
          query = k('users').select(k.raw('rowid AS physical')).orderBy('rowid').limit(1)
        if (after !== null) query.whereRaw('rowid > CAST(? AS INTEGER)', [BigInt(after).toString()])
        const keys = (await query.options({ safeIntegers: true })) as Array<{ physical: unknown }>
        if (keys.length === 0) {
          if (sourceKeys.length !== 0) invalid()
          break
        }
        if (keys.length !== 1 || sourceKeys.length !== 1 || typeof keys[0].physical !== 'bigint') invalid()
        const rowId = integer(keys[0].physical)
        if (rowId !== sourceKeys[0] || ++rows > maximumRows) invalid()
        await Brc38NativeLocalBaselineSource.withOwnedRow(source, 'users', rowId, async row => {
          check()
          if (
            row.fields.length !== 0 ||
            Object.keys(row.metadata).length !== columns.length ||
            columns.some(name => !Object.hasOwn(row.metadata, name))
          )
            invalid()
          const original = row.metadata,
            isTarget = integer(original.userId) === admission.scope.userId,
            expected: Record<string, unknown> = { ...original }
          if (isTarget) {
            if (
              ++targetRows !== 1 ||
              original.identityKey !== binding.binding.identityKey ||
              typeof original.activeStorage !== 'string'
            )
              invalid()
            if (incomingTime > timestamp(original.updated_at)) {
              expected.updated_at = incomingTime.toISOString()
              updated = true
            }
          }
          const sizes = (await k('users')
            .whereRaw('rowid=CAST(? AS INTEGER)', [BigInt(rowId).toString()])
            .select(
              k.raw(
                '(' +
                  columns
                    .map(
                      () =>
                        "CASE WHEN typeof(??) IN ('integer','real','null') THEN 8 ELSE coalesce(length(CAST(?? AS BLOB)),0) END"
                    )
                    .join('+') +
                  ') AS bytes',
                columns.flatMap(name => [name, name])
              )
            )
            .limit(2)) as Array<{ bytes: unknown }>
          if (sizes.length !== 1) invalid()
          const size = integer(sizes[0].bytes)
          if (size < 0 || size > 131072) invalid()
          const charge = working.claim(131072 + 32 * size)
          try {
            const actual = (await k('users')
              .whereRaw('rowid=CAST(? AS INTEGER)', [BigInt(rowId).toString()])
              .select(columns)
              .limit(2)
              .options({ safeIntegers: true })) as Array<Record<string, unknown>>
            if (actual.length !== 1 || columns.some(name => !Object.is(actual[0][name], expected[name]))) invalid()
            check()
          } finally {
            charge.close()
          }
        })
        after = rowId
      }
      if (targetRows !== 1) invalid()
    } finally {
      headerCharge.close()
    }
    check()
    return Object.freeze({ rows, updated })
  } finally {
    frame.close()
  }
}
