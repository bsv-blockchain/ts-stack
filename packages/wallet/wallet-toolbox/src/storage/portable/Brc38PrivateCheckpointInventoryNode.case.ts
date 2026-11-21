import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import { Brc38PrivateNativeMergeNode, type Brc38PrivateNativeMergeOptions } from './Brc38PrivateNativeMergeNode'

export interface IndependentCheckpointInventoryRow {
  readonly physicalRowId: number
  readonly metadata: Readonly<Record<string, string | number | bigint | boolean | null>>
  readonly fields: Readonly<{
    syncMap: Uint8Array | null
    errorLocal: Uint8Array | null
    errorOther: Uint8Array | null
  }>
}
interface ActualController {
  readonly store: KnexBrc38StagingStore
  readonly options: Brc38PrivateNativeMergeOptions
  withSource<T>(work: (source: Brc38NativeLocalBaselineSource) => Promise<T>): Promise<T>
  readCheckpointRowsAndFullBytes(): Promise<readonly IndependentCheckpointInventoryRow[]>
  withVariant<T>(
    variant:
      | 'same-length-map'
      | 'same-length-error'
      | 'null-empty-error'
      | 'wrong-map-hash'
      | 'wrong-pointer'
      | 'map-count'
      | 'map-id'
      | 'map-maximum-date'
      | 'map-unknown-metadata'
      | 'map-other-entity'
      | 'map-done-reset'
      | 'created-date'
      | 'updated-date'
      | 'storage-rename'
      | 'status'
      | 'init'
      | 'refNum'
      | 'when'
      | 'satoshis'
      | 'generated-reference'
      | 'generated-clock'
      | 'missing-page-observation'
      | 'wrong-checkpoint-id'
      | 'wrong-mode'
      | 'later-archive-applied'
      | 'archive-became-operational'
      | 'other-checkpoint-changed'
      | 'missing-row'
      | 'extra-row'
      | 'current-clock-change'
      | 'source-revision',
    work: () => Promise<T>
  ): Promise<T>
  check(): void
}
function requireCase(value: unknown): asserts value {
  if (!value) throw new Error('Independent complete operational checkpoint inventory case differs')
}
function normalize(rows: readonly IndependentCheckpointInventoryRow[]): string {
  const record = (input: Readonly<Record<string, unknown>>) =>
    Object.fromEntries(
      Object.entries(input)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, value]) => [
          name,
          value instanceof Uint8Array
            ? { bytes: Buffer.from(value).toString('hex') }
            : typeof value === 'bigint'
              ? { integer: value.toString() }
              : value
        ])
    )
  return JSON.stringify(
    [...rows]
      .sort((a, b) => a.physicalRowId - b.physicalRowId)
      .map(row => ({ physicalRowId: row.physicalRowId, metadata: record(row.metadata), fields: record(row.fields) }))
  )
}
/** UNRUN actual native new/existing checkpoint cases. Author complete expected
 * scalar values and map/error bytes independently before import. The genuine
 * fixture captures the actual generated random/clock DATA at the effect; those
 * observations may fill only the new reference/time oracle, never derive map
 * or merge semantics from a candidate/descriptor. Include original foreign
 * checkpoint rows, source rename, all entity deltas, repeated aliases, unknown
 * map members, existing ID conflict, final all-count reset and imported when,
 * first/later inert archived sync pages, long maps, error NULL/empty/full bytes,
 * committed ACK loss/reopen, and original allocation/GC/fresh clock fences. */
export async function verifyBrc38PrivateCheckpointInventory(
  controller: ActualController,
  expectedRows: readonly IndependentCheckpointInventoryRow[],
  expectedPages: number
): Promise<void> {
  requireCase(
    expectedRows.length >= 2 &&
      expectedRows.length <= 128 &&
      Number.isSafeInteger(expectedPages) &&
      expectedPages >= 2 &&
      expectedPages <= 128
  )
  let bytes = 0
  for (const row of expectedRows) {
    requireCase(
      Number.isSafeInteger(row.physicalRowId) &&
        Object.keys(row.metadata).length === 11 &&
        Object.keys(row.fields).length === 3
    )
    for (const value of Object.values(row.fields)) {
      requireCase(value instanceof Uint8Array || value === null)
      bytes += value?.length ?? 0
    }
  }
  requireCase(bytes <= 1048576)
  const expected = normalize(expectedRows),
    working = controller.options.workingAllocation.used,
    inspect = async () =>
      await controller.withSource(
        async source =>
          await Brc38PrivateNativeMergeNode.with(controller.store, source, controller.options, async merge => {
            await merge.inspectRecoveryHistory()
            return await merge.inspectCheckpointRows()
          })
      )
  const result = await inspect()
  requireCase(
    result.rows === expectedRows.length &&
      result.pages === expectedPages &&
      result.logicalBytes === String(bytes) &&
      normalize(await controller.readCheckpointRowsAndFullBytes()) === expected &&
      controller.options.workingAllocation.used === working
  )
  for (const variant of [
    'same-length-map',
    'same-length-error',
    'null-empty-error',
    'wrong-map-hash',
    'wrong-pointer',
    'map-count',
    'map-id',
    'map-maximum-date',
    'map-unknown-metadata',
    'map-other-entity',
    'map-done-reset',
    'created-date',
    'updated-date',
    'storage-rename',
    'status',
    'init',
    'refNum',
    'when',
    'satoshis',
    'generated-reference',
    'generated-clock',
    'missing-page-observation',
    'wrong-checkpoint-id',
    'wrong-mode',
    'later-archive-applied',
    'archive-became-operational',
    'other-checkpoint-changed',
    'missing-row',
    'extra-row',
    'current-clock-change',
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
    requireCase(normalize(await controller.readCheckpointRowsAndFullBytes()) === expected)
    controller.check()
  }
  const repeated = await inspect()
  requireCase(
    repeated.rows === result.rows &&
      repeated.pages === result.pages &&
      repeated.logicalBytes === result.logicalBytes &&
      normalize(await controller.readCheckpointRowsAndFullBytes()) === expected &&
      controller.options.workingAllocation.used === working
  )
  controller.check()
}
