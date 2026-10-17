import { createHash } from 'node:crypto'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import {
  Brc38NativeLocalBaselineSource,
  type Brc38NativeLocalBaselineField
} from './Brc38NativeLocalBaselineSourceNode'
import type { Brc38NativeLocalBaselineTable } from './Brc38NativeLocalBaselineTables'
import type { SnapshotJournalRevision } from '../snapshot/journal/SnapshotJournalRevision'
import type { Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { chargeBrc38ImportDecodedBudget, type Brc38ImportDecodedBudget } from './Brc38ImportDecodedBudget'
import { Brc38PrivateDerivedTextLifetimes } from './Brc38PrivateDerivedTextLifetimesNode'
import { withBrc38PrivateContentVersion } from './Brc38PrivateContentVersionNode'

export interface Brc38PrivateLocalBaselineField extends Brc38NativeLocalBaselineField {
  readonly sha256?: string
}
/** Internal complete metadata and immutable version descriptors only. The
 * receiver still proves its current candidate, progress and original source
 * fence in the final writer; this DATA is never a wallet DTO or capability. */
export interface Brc38PrivateLocalBaselineRow {
  readonly table: Brc38NativeLocalBaselineTable
  readonly rowId: number
  readonly revision: SnapshotJournalRevision
  readonly generation: SnapshotJournalRevision
  readonly metadata: Readonly<Record<string, unknown>>
  readonly fields: readonly Readonly<Brc38PrivateLocalBaselineField>[]
}
function invalid(): never {
  throw new Error('Private local row preparation differs from its original coherent source and resources')
}
/** Two bounded passes on the SAME genuine source row. The first establishes
 * complete hash DATA; the second replays every byte into content staging, which
 * independently verifies the complete stored postimage. Every version remains
 * held through the consumer's final writer, then ordinary finite GC can retire
 * abandoned content. Source reads never execute inside the candidate writer. */
export async function withBrc38PrivateLocalBaselineRow<T>(
  store: KnexBrc38StagingStore,
  source: Brc38NativeLocalBaselineSource,
  table: Brc38NativeLocalBaselineTable,
  rowId: number,
  selected: Readonly<{
    expiresAt: number
    maximumReadBytes: number
    workingAllocation: Brc38WorkingAllocation
    signal?: AbortSignal
  }>,
  budget: Brc38ImportDecodedBudget,
  work: (row: Readonly<Brc38PrivateLocalBaselineRow>, lifetimes: Brc38PrivateDerivedTextLifetimes) => Promise<T>
): Promise<T> {
  const capturedWorking = brc38WorkingAllocation(selected.workingAllocation)
  if (capturedWorking === undefined) invalid()
  const policy = Object.freeze({
      expiresAt: selected.expiresAt,
      maximumReadBytes: selected.maximumReadBytes,
      workingAllocation: capturedWorking,
      signal: selected.signal
    }),
    selectedTable = table,
    selectedRowId = rowId,
    deadline = performance.now() + Math.max(0, policy.expiresAt - Date.now())
  if (
    !(source instanceof Brc38NativeLocalBaselineSource) ||
    policy.workingAllocation === undefined ||
    policy.expiresAt !== store.operationExpiresAt ||
    !Number.isSafeInteger(policy.maximumReadBytes) ||
    policy.maximumReadBytes < 1 ||
    policy.maximumReadBytes > 16384 ||
    !Number.isSafeInteger(selectedRowId) ||
    budget.signal !== policy.signal ||
    budget.maximum > store.limits.maximumRowAllocationBytes
  )
    invalid()
  const working = policy.workingAllocation,
    check = (): void => {
      policy.signal?.throwIfAborted()
      if (Date.now() >= policy.expiresAt || performance.now() >= deadline) invalid()
      store.assertPrivateNativeDestination(store.knex)
    }
  check()
  // The issuer checks the source private fields; a replaced instance method
  // cannot supply a fake row or renew the original retained read scope.
  return await Brc38NativeLocalBaselineSource.withOwnedRow(source, selectedTable, selectedRowId, async actual => {
    check()
    if (actual.table !== selectedTable || actual.rowId !== selectedRowId || actual.fields.length > 32) invalid()
    const charge = working.claim(16384),
      staged: Readonly<Brc38PrivateLocalBaselineField>[] = []
    try {
      chargeBrc38ImportDecodedBudget(budget, 16384)
      return await Brc38PrivateDerivedTextLifetimes.with(store, policy, async lifetimes => {
        for (const kind of ['blob', 'text'] as const) {
          const fields = actual.fields.filter(field => field.kind === kind),
            nonnull = fields.filter(field => field.bytes !== null)
          for (const field of fields.filter(field => field.bytes === null)) staged.push(Object.freeze({ ...field }))
          if (nonnull.length === 0) continue
          await withBrc38PrivateContentVersion(
            kind === 'blob' ? 'binary' : 'raw-text',
            store,
            {
              ...policy,
              maximumBytes: Math.max(...nonnull.map(field => field.bytes!)),
              maximumVersions: nonnull.length
            },
            budget,
            async version => {
              for (const field of nonnull) {
                check()
                const hash = createHash('sha256'),
                  bytes = field.bytes!
                for (let offset = 0; offset < bytes;) {
                  const amount = Math.min(policy.maximumReadBytes, bytes - offset)
                  await actual.withFieldExtent(field.field, offset, amount, async extent => {
                    check()
                    hash.update(extent)
                  })
                  offset += amount
                  check()
                }
                const descriptor = Object.freeze({ bytes, sha256: hash.digest('hex') })
                await version.begin(descriptor)
                for (let offset = 0; offset < bytes;) {
                  const amount = Math.min(policy.maximumReadBytes, bytes - offset),
                    at = offset
                  await actual.withFieldExtent(field.field, at, amount, async extent => {
                    check()
                    await version.append(at, extent)
                    check()
                  })
                  offset += amount
                }
                const stored = await version.finish()
                if (stored.bytes !== descriptor.bytes || stored.sha256 !== descriptor.sha256) invalid()
                staged.push(Object.freeze({ ...field, sha256: stored.sha256 }))
                check()
              }
            },
            undefined,
            lifetimes
          )
        }
        check()
        if (
          staged.length !== actual.fields.length ||
          actual.fields.some(field => staged.filter(value => value.field === field.field).length !== 1)
        )
          invalid()
        const row = Object.freeze({
          table: actual.table,
          rowId: actual.rowId,
          revision: actual.revision,
          generation: actual.generation,
          metadata: actual.metadata,
          fields: Object.freeze(actual.fields.map(field => staged.find(value => value.field === field.field)!))
        })
        const result = await work(row, lifetimes)
        check()
        return result
      })
    } finally {
      charge.close()
    }
  })
}
