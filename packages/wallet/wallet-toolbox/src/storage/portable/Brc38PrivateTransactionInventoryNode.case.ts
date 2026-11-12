import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import { Brc38PrivateNativeMergeNode, type Brc38PrivateNativeMergeOptions } from './Brc38PrivateNativeMergeNode'
import { transactionPayloadFields } from '../snapshot/SnapshotSyncActionMetadata'

export interface IndependentTransactionInventoryRow {
  readonly physicalRowId: number
  readonly metadata: Readonly<Record<string, string | number | bigint | boolean | null>>
  readonly fields: Readonly<Record<string, Uint8Array | null>>
}
interface ActualController {
  readonly store: KnexBrc38StagingStore
  readonly options: Brc38PrivateNativeMergeOptions
  withSource<T>(work: (source: Brc38NativeLocalBaselineSource) => Promise<T>): Promise<T>
  readTransactionsAndFullLogicalBytes(): Promise<readonly IndependentTransactionInventoryRow[]>
  withVariant<T>(
    variant:
      | 'same-length-binary'
      | 'same-length-text'
      | 'null-empty'
      | 'wrong-pointer'
      | 'wrong-full-hash'
      | 'wrong-selected-origin'
      | 'missing-local-row'
      | 'extra-row'
      | 'missing-alias'
      | 'alias-order'
      | 'creation-date'
      | 'retained-reference'
      | 'wrong-user'
      | 'mapped-proof'
      | 'stale-proof-loss'
      | 'lifecycle-regression'
      | 'earliest-deadline'
      | 'retained-reclaim-fields'
      | 'quarantine-declaration'
      | 'quarantine-missing-declaration'
      | 'quarantine-before-writer'
      | 'quarantine-after-writer'
      | 'source-revision',
    work: () => Promise<T>
  ): Promise<T>
  check(): void
}
function requireCase(value: unknown): asserts value {
  if (!value) throw new Error('Independent complete transaction inventory case differs')
}
function normalized(rows: readonly IndependentTransactionInventoryRow[]): string {
  const record = (input: Readonly<Record<string, unknown>>) =>
    Object.fromEntries(
      Object.entries(input)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) => [
          key,
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
/** UNRUN genuine occupied/reopened native cases. Author complete expected
 * metadata and all six payload byte oracles BEFORE importing. Include untouched
 * rows, new remapped IDs, signed original IDs, same-target aliases, null/empty
 * payloads, Unicode, inline/staged fields and equal/older/newer timestamps.
 * BRC-177 cases include stale proof evidence, monotone lifecycle, the earliest
 * deadline and retained reclaim data across multiple different aliases.
 * This tests transaction postimages only; output quarantine is separate. */
export async function verifyBrc38PrivateTransactionInventory(
  controller: ActualController,
  expectedRows: readonly IndependentTransactionInventoryRow[],
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
        Object.keys(row.metadata).length >= 20 &&
        Object.keys(row.metadata).length <= 64 &&
        Object.keys(row.fields).length === transactionPayloadFields.length
    )
    for (const name of transactionPayloadFields) {
      const value = row.fields[name]
      requireCase(value === null || value instanceof Uint8Array)
      if (name === 'description') requireCase(value instanceof Uint8Array)
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
            return await merge.inspectTransactionRows()
          })
      )
  const result = await inspect()
  requireCase(
    result.rows === expectedRows.length &&
      result.aliases === expectedAliases &&
      result.logicalBytes === String(bytes) &&
      normalized(await controller.readTransactionsAndFullLogicalBytes()) === expected &&
      controller.options.workingAllocation.used === working
  )
  for (const variant of [
    'same-length-binary',
    'same-length-text',
    'null-empty',
    'wrong-pointer',
    'wrong-full-hash',
    'wrong-selected-origin',
    'missing-local-row',
    'extra-row',
    'missing-alias',
    'alias-order',
    'creation-date',
    'retained-reference',
    'wrong-user',
    'mapped-proof',
    'stale-proof-loss',
    'lifecycle-regression',
    'earliest-deadline',
    'retained-reclaim-fields',
    'quarantine-declaration',
    'quarantine-missing-declaration',
    'quarantine-before-writer',
    'quarantine-after-writer',
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
    requireCase(normalized(await controller.readTransactionsAndFullLogicalBytes()) === expected)
    controller.check()
  }
  const repeated = await inspect()
  requireCase(
    repeated.rows === result.rows &&
      repeated.aliases === result.aliases &&
      repeated.logicalBytes === result.logicalBytes &&
      normalized(await controller.readTransactionsAndFullLogicalBytes()) === expected &&
      controller.options.workingAllocation.used === working
  )
  controller.check()
}
