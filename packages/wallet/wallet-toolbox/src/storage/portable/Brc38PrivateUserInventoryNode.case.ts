import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import { Brc38PrivateNativeMergeNode, type Brc38PrivateNativeMergeOptions } from './Brc38PrivateNativeMergeNode'

export interface IndependentUserInventoryRow {
  readonly physicalRowId: number
  readonly metadata: Readonly<Record<string, string | number | bigint | null>>
}
interface ActualController {
  readonly store: KnexBrc38StagingStore
  readonly options: Brc38PrivateNativeMergeOptions
  withSource<T>(work: (source: Brc38NativeLocalBaselineSource) => Promise<T>): Promise<T>
  readUsers(): Promise<readonly IndependentUserInventoryRow[]>
  withVariant<T>(
    variant:
      | 'created-date'
      | 'older-header'
      | 'wrong-updated-date'
      | 'wrong-identity'
      | 'wrong-active-storage'
      | 'wrong-user-id'
      | 'other-user-changed'
      | 'missing-user'
      | 'extra-user'
      | 'source-revision',
    work: () => Promise<T>
  ): Promise<T>
  /** Current migrated users require non-NULL identity/primary cells. Exercise
   * the real constraint instead of manufacturing an impossible committed row. */
  assertOtherUserNullRefused(): Promise<void>
  check(): void
}
function requireCase(value: unknown, detail?: string): asserts value {
  if (!value)
    throw new Error('Independent complete user inventory case differs' + (detail === undefined ? '' : ': ' + detail))
}
function normalize(rows: readonly IndependentUserInventoryRow[]): string {
  return JSON.stringify(
    [...rows]
      .sort((a, b) => a.physicalRowId - b.physicalRowId)
      .map(row => ({
        ...row,
        metadata: Object.fromEntries(
          Object.entries(row.metadata)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([name, value]) => [name, typeof value === 'bigint' ? { integer: value.toString() } : value])
        )
      }))
  )
}
/** UNRUN. Independently author original/expected users before import, including
 * a selected newer/equal/older header and an unrelated empty primary cell. A real
 * native occupied controller supplies full typed SQL reads and corruption;
 * it must not derive expected rows from the implementation or candidate. */
export async function verifyBrc38PrivateUserInventory(
  controller: ActualController,
  expectedRows: readonly IndependentUserInventoryRow[],
  expectedUpdated: boolean
): Promise<void> {
  requireCase(expectedRows.length >= 2 && expectedRows.length <= 128 && typeof expectedUpdated === 'boolean')
  for (const row of expectedRows)
    requireCase(Number.isSafeInteger(row.physicalRowId) && Object.keys(row.metadata).length === 5)
  const expected = normalize(expectedRows),
    working = controller.options.workingAllocation.used,
    inspect = async () =>
      await controller.withSource(
        async source =>
          await Brc38PrivateNativeMergeNode.with(
            controller.store,
            source,
            controller.options,
            async merge => await merge.inspectUserRows()
          )
      )
  const result = await inspect()
  requireCase(result.rows === expectedRows.length, 'physical row count')
  requireCase(result.updated === expectedUpdated, 'newer header decision')
  requireCase(normalize(await controller.readUsers()) === expected, 'physical user cells')
  requireCase(controller.options.workingAllocation.used === working, 'working allocation release')
  for (const variant of [
    'created-date',
    'older-header',
    'wrong-updated-date',
    'wrong-identity',
    'wrong-active-storage',
    'wrong-user-id',
    'other-user-changed',
    'missing-user',
    'extra-user',
    'source-revision'
  ] as const) {
    await controller.withVariant(variant, async () => {
      let refused = false
      try {
        await inspect()
      } catch {
        refused = true
      }
      requireCase(refused && controller.options.workingAllocation.used === working)
    })
    requireCase(normalize(await controller.readUsers()) === expected)
    controller.check()
  }
  await controller.assertOtherUserNullRefused()
  requireCase(
    normalize(await controller.readUsers()) === expected && controller.options.workingAllocation.used === working
  )
  const repeated = await inspect()
  requireCase(
    repeated.rows === result.rows &&
      repeated.updated === result.updated &&
      normalize(await controller.readUsers()) === expected &&
      controller.options.workingAllocation.used === working
  )
  controller.check()
}
