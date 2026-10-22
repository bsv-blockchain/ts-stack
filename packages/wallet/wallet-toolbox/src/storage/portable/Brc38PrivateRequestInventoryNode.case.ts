import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import { Brc38PrivateNativeMergeNode, type Brc38PrivateNativeMergeOptions } from './Brc38PrivateNativeMergeNode'

export interface IndependentRequestInventoryRow {
  readonly physicalRowId: number
  readonly metadata: Readonly<Record<string, string | number | bigint | boolean | null>>
  readonly fields: Readonly<{
    rawTx: Uint8Array | null
    inputBEEF: Uint8Array | null
    history: Uint8Array | null
    notify: Uint8Array | null
  }>
}
interface ActualController {
  readonly store: KnexBrc38StagingStore
  readonly options: Brc38PrivateNativeMergeOptions
  withSource<T>(work: (source: Brc38NativeLocalBaselineSource) => Promise<T>): Promise<T>
  readRequestsAndFullLogicalBytes(): Promise<readonly IndependentRequestInventoryRow[]>
  withVariant<T>(
    variant:
      | 'same-length-binary'
      | 'same-length-history'
      | 'same-length-notify'
      | 'null-empty'
      | 'wrong-pointer'
      | 'wrong-full-hash'
      | 'wrong-selected-origin'
      | 'missing-local-row'
      | 'extra-row'
      | 'missing-alias'
      | 'alias-order'
      | 'retained-status'
      | 'retained-attempts'
      | 'retained-proof'
      | 'retained-rawTx'
      | 'retained-inputBEEF'
      | 'retained-broadcast'
      | 'batch-conflict'
      | 'creation-date'
      | 'updated-date'
      | 'history-subset'
      | 'history-stable-sort'
      | 'history-missing-when'
      | 'history-root-metadata'
      | 'notify-first-occurrence'
      | 'notify-mapping'
      | 'notify-missing-ids'
      | 'notify-unknown-metadata'
      | 'no-write-raw-spelling'
      | 'whole-row-normalization'
      | 'notified-reset'
      | 'current-clock-change'
      | 'nullable-alias'
      | 'source-revision',
    work: () => Promise<T>
  ): Promise<T>
  check(): void
}
function requireCase(value: unknown): asserts value {
  if (!value) throw new Error('Independent complete request scalar and payload inventory case differs')
}
function normalized(rows: readonly IndependentRequestInventoryRow[]): string {
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
/** UNRUN genuine occupied/reopened native cases. Author all scalar values and
 * four full payload oracles BEFORE importing: untouched/new rows, same-target
 * aliases, retained status/attempts/proof/binaries/broadcast, batch/max-date,
 * asymmetric history subset deduplication and stable time sort, missing when,
 * root metadata, notification normalization/mapping/missing IDs/reset, and
 * legacy raw spelling across no-op versus any whole-row update. A real native
 * fixture must drive mutation during reads; these are not fake source actors
 * or qualification receipts. Expected complete bytes never come from a
 * reconstruction descriptor, a producer hash or the candidate itself. Include
 * untouched nullable legacy cells: they must remain NULL; an alias requiring
 * invalid legacy JSON/DTO cells must refuse rather than substitute '{}'. */
export async function verifyBrc38PrivateRequestInventory(
  controller: ActualController,
  expectedRows: readonly IndependentRequestInventoryRow[],
  expectedAliases: number
): Promise<void> {
  requireCase(
    expectedRows.length >= 2 &&
      expectedRows.length <= 128 &&
      Number.isSafeInteger(expectedAliases) &&
      expectedAliases >= 2 &&
      expectedAliases <= 128
  )
  let bytes = 0
  for (const row of expectedRows) {
    requireCase(
      Number.isSafeInteger(row.physicalRowId) &&
        Object.keys(row.metadata).length === 11 &&
        Object.keys(row.fields).length === 4
    )
    for (const name of ['rawTx', 'inputBEEF', 'history', 'notify'] as const) {
      const value = row.fields[name]
      requireCase(value instanceof Uint8Array || value === null)
      bytes += value?.length ?? 0
    }
  }
  requireCase(bytes <= 1048576)
  const expected = normalized(expectedRows),
    working = controller.options.workingAllocation.used,
    inspect = async () =>
      await controller.withSource(
        async source =>
          await Brc38PrivateNativeMergeNode.with(controller.store, source, controller.options, async merge => {
            await merge.inspectRecoveryHistory()
            return await merge.inspectRequestRows()
          })
      )
  const result = await inspect()
  requireCase(
    result.rows === expectedRows.length &&
      result.aliases === expectedAliases &&
      result.logicalBytes === String(bytes) &&
      normalized(await controller.readRequestsAndFullLogicalBytes()) === expected &&
      controller.options.workingAllocation.used === working
  )
  for (const variant of [
    'same-length-binary',
    'same-length-history',
    'same-length-notify',
    'null-empty',
    'wrong-pointer',
    'wrong-full-hash',
    'wrong-selected-origin',
    'missing-local-row',
    'extra-row',
    'missing-alias',
    'alias-order',
    'retained-status',
    'retained-attempts',
    'retained-proof',
    'retained-rawTx',
    'retained-inputBEEF',
    'retained-broadcast',
    'batch-conflict',
    'creation-date',
    'updated-date',
    'history-subset',
    'history-stable-sort',
    'history-missing-when',
    'history-root-metadata',
    'notify-first-occurrence',
    'notify-mapping',
    'notify-missing-ids',
    'notify-unknown-metadata',
    'no-write-raw-spelling',
    'whole-row-normalization',
    'notified-reset',
    'current-clock-change',
    'nullable-alias',
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
    requireCase(normalized(await controller.readRequestsAndFullLogicalBytes()) === expected)
    controller.check()
  }
  const repeated = await inspect()
  requireCase(
    repeated.rows === result.rows &&
      repeated.aliases === result.aliases &&
      repeated.logicalBytes === result.logicalBytes &&
      normalized(await controller.readRequestsAndFullLogicalBytes()) === expected &&
      controller.options.workingAllocation.used === working
  )
  controller.check()
}
