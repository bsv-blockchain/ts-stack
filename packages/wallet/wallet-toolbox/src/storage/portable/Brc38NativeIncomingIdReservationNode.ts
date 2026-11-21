import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'
import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { brc38PrivatePageIdForms } from './Brc38PrivatePageIdsNode'
import {
  brc38DestinationSelection,
  withBrc38KnexImportDestination,
  type Brc38DestinationSelection
} from './Brc38KnexDestinationFence'
import { requireBrc38NativeProfileTransaction } from './Brc38PublishedProfileNode'
import { ownedNativeRootIdentity } from '../schema/ownedNativeSqliteConnectionsNode'
import { readBrc38NativeLocalBaselineGeneration } from './Brc38NativeLocalBaselineGenerationNode'
import {
  hasBrc38NativeIncomingIdReservationSchema,
  brc38NativeIncomingIdReservations as ranges
} from './Brc38NativeIncomingIdReservationSchemaNode'
import {
  snapshotJournalReceiptPolicy,
  type SnapshotJournalReceiptPolicy
} from '../snapshot/journal/SnapshotJournalReceipt'
import { brc38WorkingAllocation, type Brc38WorkingAllocation } from './Brc38WorkingAllocation'

export interface Brc38NativeIncomingIdRange {
  readonly tableId: number
  readonly table: keyof typeof brc38PrivatePageIdForms
  readonly first: number
  readonly count: number
}
export const brc38NativeIncomingIdReservationEpisodes = 4
export const brc38NativeIncomingIdTables = Object.freeze(
  Object.keys(brc38PrivatePageIdForms) as Array<keyof typeof brc38PrivatePageIdForms>
)
function invalid(): never {
  throw new Error('Incoming ID reservation differs from its authenticated archive, current primary or original range')
}
async function high(k: Knex.Transaction, table: keyof typeof brc38PrivatePageIdForms): Promise<number> {
  const [sql, id] = brc38PrivatePageIdForms[table],
    columns = (await k.raw(
      "SELECT count(*) AS valid FROM pragma_table_info(?) WHERE name=? AND upper(type)='INTEGER' AND pk=1",
      [sql, id]
    )) as Array<{ valid: number }>,
    definition = (await k('sqlite_schema')
      .where({ type: 'table', name: sql })
      .select(k.raw("CASE WHEN instr(upper(sql),'AUTOINCREMENT')>0 THEN 1 ELSE 0 END AS valid"))
      .limit(2)) as Array<{ valid: number }>,
    sequence = (await k('sqlite_sequence').where({ name: sql }).select('seq').limit(2)) as Array<{ seq: number }>,
    maximum = (await k(sql).orderBy(id, 'desc').select({ maximum: id }).limit(1)) as Array<{ maximum: number }>
  if (
    columns.length !== 1 ||
    columns[0].valid !== 1 ||
    definition.length !== 1 ||
    definition[0].valid !== 1 ||
    sequence.length > 1 ||
    sequence.some(row => !Number.isSafeInteger(row.seq) || row.seq < 0) ||
    maximum.some(row => !Number.isSafeInteger(row.maximum))
  )
    invalid()
  return Math.max(0, sequence[0]?.seq ?? 0, maximum[0]?.maximum ?? 0)
}
/** Reserve only counter space in one short actual source-primary writer.
 * No entity, incoming map, operational checkpoint or publication is applied.
 * Reserving holes is durable across cancellation and prevents foreground
 * AUTOINCREMENT writes from entering the incoming candidate's range. */
export async function reserveBrc38NativeIncomingIds(
  storage: StorageKnex,
  selection: Brc38DestinationSelection,
  retention: SnapshotJournalReceiptPolicy,
  store: KnexBrc38StagingStore,
  selected: Readonly<{ workingAllocation: Brc38WorkingAllocation; signal?: AbortSignal }>
): Promise<
  Readonly<{ sourceEpoch: string; primaryEpoch: string; ranges: readonly Readonly<Brc38NativeIncomingIdRange>[] }>
> {
  const destination = brc38DestinationSelection(selection),
    receiptPolicy = Object.freeze({ ...snapshotJournalReceiptPolicy(retention) }),
    working = brc38WorkingAllocation(selected.workingAllocation),
    signal = selected.signal,
    binding = store.binding,
    expiresAt = store.limits.expiresAt,
    deadline = performance.now() + Math.max(0, expiresAt - Date.now())
  if (
    working === undefined ||
    working.maximum > store.limits.maximumRowAllocationBytes ||
    binding === undefined ||
    destination.mode !== 'merge' ||
    destination.identityKey !== binding.binding.identityKey ||
    destination.chain !== binding.binding.chain ||
    destination.targetStorageIdentityKey !== binding.binding.targetStorageIdentityKey
  )
    invalid()
  const check = (): void => {
      signal?.throwIfAborted()
      if (Date.now() >= expiresAt || performance.now() >= deadline || store.binding !== binding) invalid()
    },
    charge = working.claim(2097152)
  try {
    // Reservation precedes the candidate's import preview. The original
    // authenticated receiver scope lends its actual read transaction here;
    // an import-reader facade requiring an existing preview is inappropriate.
    const counts = await store.withAuthenticatedPrivateStructuredDestination(async header => {
      check()
      if (header.user.identityKey !== destination.identityKey || header.sourceStorage.chain !== destination.chain)
        invalid()
      return await store.withPrivateNativeDatabase(
        true,
        async database =>
          await database.transaction(async k => {
            store.assertPrivateNativeReadTransaction(k)
            await verifyBrc38AuthenticatedSourceSeal(k)
            const values = (await k('table_counts')
              .whereIn('tableName', brc38NativeIncomingIdTables)
              .select('tableName', 'rows')
              .limit(11)) as Array<{ tableName: string; rows: number }>
            if (values.length !== brc38NativeIncomingIdTables.length) invalid()
            const result = brc38NativeIncomingIdTables.map(table => {
              const rows = values.filter(value => value.tableName === table)
              if (
                rows.length !== 1 ||
                !Number.isSafeInteger(rows[0].rows) ||
                rows[0].rows < 0 ||
                rows[0].rows > store.limits.maximumRows
              )
                invalid()
              const perEpisode = rows[0].rows + (table === 'syncStates' ? 1 : 0),
                required = perEpisode * brc38NativeIncomingIdReservationEpisodes
              if (
                !Number.isSafeInteger(perEpisode) ||
                perEpisode > 10000000 ||
                !Number.isSafeInteger(required) ||
                required > 40000000
              )
                invalid()
              return required
            })
            store.assertPrivateNativeReadTransaction(k)
            check()
            return Object.freeze(result)
          })
      )
    })
    return await withBrc38KnexImportDestination(storage, destination, receiptPolicy, async (k, read) => {
      const owned = (): void => {
        check()
        requireBrc38NativeProfileTransaction(k)
        if (ownedNativeRootIdentity(k)?.slot !== 0 || k.isCompleted()) invalid()
      }
      owned()
      if (!(await hasBrc38NativeIncomingIdReservationSchema(k))) invalid()
      const before = await read(),
        generation = await readBrc38NativeLocalBaselineGeneration(k)
      if (
        before.userId === null ||
        before.primaryEpoch === null ||
        before.activeStorage !== destination.targetStorageIdentityKey ||
        !generation.complete ||
        !generation.enabled
      )
        invalid()
      const result: Readonly<Brc38NativeIncomingIdRange>[] = []
      let changed = false
      for (let tableId = 0; tableId < brc38NativeIncomingIdTables.length; tableId++) {
        owned()
        const table = brc38NativeIncomingIdTables[tableId],
          count = counts[tableId],
          key = { bindingSha256: binding.digest, tableId },
          prior = (await k(ranges)
            .where(key)
            .select('sourceEpoch', 'primaryEpoch', 'userId', 'first', 'count', 'expiresAt')
            .limit(2)) as Array<{
            sourceEpoch: string
            primaryEpoch: string
            userId: number
            first: number
            count: number
            expiresAt: number
          }>
        if (prior.length > 1 || (count === 0 && prior.length !== 0)) invalid()
        if (count === 0) continue
        let first: number
        if (prior.length === 1) {
          const actual = prior[0]
          if (
            actual.sourceEpoch !== generation.epoch ||
            actual.primaryEpoch !== before.primaryEpoch ||
            actual.userId !== before.userId ||
            actual.count !== count ||
            actual.expiresAt !== expiresAt ||
            !Number.isSafeInteger(actual.first) ||
            actual.first < 1 ||
            !Number.isSafeInteger(actual.first + count - 1) ||
            (await high(k, table)) < actual.first + count - 1
          )
            invalid()
          first = actual.first
        } else {
          first = (await high(k, table)) + 1
          const last = first + count - 1,
            [sql] = brc38PrivatePageIdForms[table]
          if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) invalid()
          const counters = await k('sqlite_sequence').where({ name: sql }).select('seq').limit(2)
          if (counters.length > 1) invalid()
          // sqlite_sequence has no column affinity. The native driver binds
          // Number as REAL; preserve the validated safe allocation floor as
          // INTEGER for the original coherent-source history reader.
          if (counters.length === 0)
            await k('sqlite_sequence').insert({ name: sql, seq: k.raw('CAST(? AS INTEGER)', [last]) })
          else if (
            (await k('sqlite_sequence')
              .where({ name: sql })
              .update({ seq: k.raw('CAST(? AS INTEGER)', [last]) })) !== 1
          )
            invalid()
          await k(ranges).insert({
            ...key,
            sourceEpoch: generation.epoch,
            primaryEpoch: before.primaryEpoch,
            userId: before.userId,
            first,
            count,
            expiresAt
          })
          if ((await high(k, table)) !== last) invalid()
          changed = true
        }
        result.push(Object.freeze({ tableId, table, first, count }))
      }
      if (
        changed &&
        (await k('brc38_local_baseline_clock')
          .where({ slot: 1, epoch: generation.epoch, enabled: 1 })
          .whereRaw('revision<ceiling')
          .update({ revision: k.raw('revision+1') })) !== 1
      )
        invalid()
      const after = await read()
      if (
        after.backendSha256 !== before.backendSha256 ||
        after.epoch !== before.epoch ||
        after.userId !== before.userId ||
        after.activeStorage !== before.activeStorage ||
        after.primaryEpoch !== before.primaryEpoch ||
        after.revision !== before.revision
      )
        invalid()
      owned()
      return Object.freeze({
        sourceEpoch: generation.epoch,
        primaryEpoch: before.primaryEpoch,
        ranges: Object.freeze(result)
      })
    })
  } finally {
    charge.close()
  }
}

/** Indexed finite expiry cleanup. Counter floors remain permanently advanced;
 * deleting an expired ledger row can never make its IDs available again. */
export async function collectBrc38NativeIncomingIdRanges(
  storage: StorageKnex,
  selection: Brc38DestinationSelection,
  retention: SnapshotJournalReceiptPolicy,
  selected: Readonly<{
    maximumRows: number
    expiresAt: number
    workingAllocation: Brc38WorkingAllocation
    signal?: AbortSignal
  }>
): Promise<Readonly<{ deleted: number; complete: boolean }>> {
  const policy = Object.freeze({ ...selected }),
    working = brc38WorkingAllocation(policy.workingAllocation),
    destination = brc38DestinationSelection(selection),
    receiptPolicy = Object.freeze({ ...snapshotJournalReceiptPolicy(retention) }),
    deadline = performance.now() + Math.max(0, policy.expiresAt - Date.now())
  if (
    working === undefined ||
    !Number.isSafeInteger(policy.maximumRows) ||
    policy.maximumRows < 1 ||
    policy.maximumRows > 128 ||
    !Number.isSafeInteger(policy.expiresAt) ||
    destination.mode !== 'merge'
  )
    invalid()
  const charge = working.claim(1048576 + 1024 * policy.maximumRows),
    check = (): void => {
      policy.signal?.throwIfAborted()
      if (Date.now() >= policy.expiresAt || performance.now() >= deadline) invalid()
    }
  try {
    return await withBrc38KnexImportDestination(storage, destination, receiptPolicy, async (k, read) => {
      check()
      requireBrc38NativeProfileTransaction(k)
      if (ownedNativeRootIdentity(k)?.slot !== 0 || !(await hasBrc38NativeIncomingIdReservationSchema(k))) invalid()
      const before = await read()
      if (
        before.userId === null ||
        before.activeStorage !== destination.targetStorageIdentityKey ||
        before.primaryEpoch === null
      )
        invalid()
      const cutoff = Math.floor(Date.now() / 1000) * 1000,
        values = (await k(ranges)
          .where('expiresAt', '<=', cutoff)
          .orderBy('expiresAt')
          .orderBy('bindingSha256')
          .orderBy('tableId')
          .select('bindingSha256', 'tableId', 'expiresAt')
          .limit(policy.maximumRows)) as Array<{ bindingSha256: string; tableId: number; expiresAt: number }>
      for (const value of values) {
        check()
        if ((await k(ranges).where(value).delete()) !== 1) invalid()
      }
      const remaining = await k(ranges).where('expiresAt', '<=', cutoff).select('tableId').limit(1),
        after = await read()
      if (JSON.stringify(after) !== JSON.stringify(before)) invalid()
      check()
      return Object.freeze({ deleted: values.length, complete: remaining.length === 0 })
    })
  } finally {
    charge.close()
  }
}
