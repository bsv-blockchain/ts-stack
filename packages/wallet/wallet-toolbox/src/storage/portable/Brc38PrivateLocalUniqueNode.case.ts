import type { Knex } from 'knex'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import type { Brc38NativeLocalBaselineTable } from './Brc38NativeLocalBaselineTables'
import { brc38PrivateLocalUniqueConflict } from './Brc38PrivateLocalUniqueNode'
import type { Brc38WorkingAllocation } from './Brc38WorkingAllocation'
interface ActualController {
  readonly store: KnexBrc38StagingStore
  readonly workingAllocation: Brc38WorkingAllocation
  withSource<T>(work: (source: Brc38NativeLocalBaselineSource) => Promise<T>): Promise<T>
  withRead<T>(work: (k: Knex.Transaction) => Promise<T>): Promise<T>
  withWriter<T>(work: (k: Knex.Transaction) => Promise<T>): Promise<T>
  check(): void
}
function requireCase(value: unknown): asserts value {
  if (!value) throw new Error('Actual private unique-key comparison differs from the independent fixture')
}
/** Genuine candidate/source fixtures with independently expected natural key
 * reuse, composite key reuse, same-physical-row replacement, distinct keys,
 * nullable UNIQUE components and signed IDs. The actual migrated schema is
 * unchanged. Metadata and these booleans grant no source/semantic admission. */
export async function verifyBrc38PrivateLocalUniqueKeys(
  controller: ActualController,
  cases: readonly Readonly<{ table: Brc38NativeLocalBaselineTable; rowId: number; conflict: boolean }>[]
): Promise<void> {
  requireCase(
    cases.length >= 6 && cases.length <= 32 && cases.some(row => row.conflict) && cases.some(row => !row.conflict)
  )
  const used = controller.workingAllocation.used
  await controller.withSource(async source => {
    for (const entry of cases) {
      controller.check()
      await Brc38NativeLocalBaselineSource.withOwnedRow(source, entry.table, entry.rowId, async row => {
        const policy = { workingAllocation: controller.workingAllocation, expiresAt: controller.store.limits.expiresAt }
        requireCase(
          (await controller.withRead(
            async k => await brc38PrivateLocalUniqueConflict(controller.store, k, row, policy)
          )) === entry.conflict
        )
        requireCase(
          (await controller.withWriter(
            async k => await brc38PrivateLocalUniqueConflict(controller.store, k, row, policy, true)
          )) === entry.conflict
        )
      })
      controller.check()
    }
  })
  requireCase(controller.workingAllocation.used === used)
  controller.check()
}
