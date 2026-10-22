import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import { Brc38PrivateNativeMergeNode, type Brc38PrivateNativeMergeOptions } from './Brc38PrivateNativeMergeNode'

type Table = 'output_baskets' | 'output_tags' | 'tx_labels' | 'tx_labels_map' | 'output_tags_map'
export interface IndependentScalarInventoryRow {
  readonly table: Table
  readonly physicalRowId: number
  readonly metadata: Readonly<Record<string, string | number | bigint | boolean | null>>
}
interface ActualController {
  readonly store: KnexBrc38StagingStore
  readonly options: Brc38PrivateNativeMergeOptions
  withSource<T>(work: (source: Brc38NativeLocalBaselineSource) => Promise<T>): Promise<T>
  /** Genuine finite SQL reads, including every column and physical identity.
   * The expected rows are independently authored before the import runs. */
  readScalarRows(): Promise<readonly IndependentScalarInventoryRow[]>
  withVariant<T>(
    variant:
      | 'unchanged-local-field'
      | 'alias-order'
      | 'creation-date'
      | 'tombstone'
      | 'basket-preferences'
      | 'missing-local-row'
      | 'extra-unmapped-row'
      | 'compound-parent'
      | 'missing-target'
      | 'extra-target'
      | 'target-budget'
      | 'target-index'
      | 'source-revision',
    work: () => Promise<T>
  ): Promise<T>
  check(): void
}
function requireCase(value: unknown): asserts value {
  if (!value) throw new Error('Independent scalar semantic inventory case differs')
}
function normalized(rows: readonly IndependentScalarInventoryRow[]): string {
  return JSON.stringify(
    [...rows]
      .sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : a.physicalRowId - b.physicalRowId))
      .map(row => ({
        table: row.table,
        physicalRowId: row.physicalRowId,
        metadata: Object.fromEntries(
          Object.entries(row.metadata)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, value]) => [key, typeof value === 'bigint' ? { integer: value.toString() } : value])
        )
      }))
  )
}
/** UNRUN. The genuine finite occupied fixture must cover all five families,
 * untouched local records, empty/default basket aliases, different source user,
 * signed/exponent IDs, mapped compound parents, equal/older/newer timestamps,
 * multiple incoming IDs for one target, and tombstone/preference changes.
 * Isolated physical variants cannot mutate the canonical source or replace
 * actual factory, schema, source, target or inventory implementations. */
export async function verifyBrc38PrivateScalarInventory(
  controller: ActualController,
  expectedRows: readonly IndependentScalarInventoryRow[],
  expectedAliases: number
): Promise<void> {
  requireCase(
    expectedRows.length >= 5 &&
      expectedRows.length <= 128 &&
      Number.isSafeInteger(expectedAliases) &&
      expectedAliases >= 2 &&
      expectedAliases <= 128
  )
  for (const table of ['output_baskets', 'output_tags', 'tx_labels', 'tx_labels_map', 'output_tags_map'])
    requireCase(expectedRows.some(row => row.table === table))
  requireCase(
    expectedRows.every(
      row =>
        Number.isSafeInteger(row.physicalRowId) &&
        Object.keys(row.metadata).length >= 5 &&
        Object.keys(row.metadata).length <= 32
    )
  )
  const working = controller.options.workingAllocation.used,
    expected = normalized(expectedRows),
    inspect = async () =>
      await controller.withSource(
        async source =>
          await Brc38PrivateNativeMergeNode.with(controller.store, source, controller.options, async merge => {
            await merge.inspectRecoveryHistory()
            return await merge.inspectScalarRows()
          })
      )
  const result = await inspect()
  requireCase(
    result.rows === expectedRows.length &&
      result.aliases === expectedAliases &&
      normalized(await controller.readScalarRows()) === expected &&
      controller.options.workingAllocation.used === working
  )
  for (const variant of [
    'unchanged-local-field',
    'alias-order',
    'creation-date',
    'tombstone',
    'basket-preferences',
    'missing-local-row',
    'extra-unmapped-row',
    'compound-parent',
    'missing-target',
    'extra-target',
    'target-budget',
    'target-index',
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
    requireCase(normalized(await controller.readScalarRows()) === expected)
    controller.check()
  }
  const repeated = await inspect()
  requireCase(
    repeated.rows === result.rows &&
      repeated.aliases === result.aliases &&
      controller.options.workingAllocation.used === working &&
      normalized(await controller.readScalarRows()) === expected
  )
  controller.check()
}
