import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import { Brc38PrivateNativeMergeNode, type Brc38PrivateNativeMergeOptions } from './Brc38PrivateNativeMergeNode'
import { outputPayloadFields } from '../snapshot/SnapshotSyncActionMetadata'

export interface IndependentOutputInventoryRow {
  readonly physicalRowId: number
  readonly metadata: Readonly<Record<string, string | number | bigint | boolean | null>>
  readonly fields: Readonly<Record<string, Uint8Array | null>>
}
interface ActualController {
  readonly store: KnexBrc38StagingStore
  readonly options: Brc38PrivateNativeMergeOptions
  withSource<T>(work: (source: Brc38NativeLocalBaselineSource) => Promise<T>): Promise<T>
  readOutputsAndFullLogicalBytes(): Promise<readonly IndependentOutputInventoryRow[]>
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
      | 'retained-transaction'
      | 'retained-derivation'
      | 'mapped-basket'
      | 'mapped-spender'
      | 'missing-quarantine'
      | 'extra-quarantine'
      | 'wrong-quarantine-output'
      | 'wrong-quarantine-order'
      | 'wrong-quarantine-clock'
      | 'quarantine-changed-local-null'
      | 'unresolved-reclaim-spendable'
      | 'wrong-transaction-postimage'
      | 'wrong-target-budget'
      | 'source-revision',
    work: () => Promise<T>
  ): Promise<T>
  check(): void
}
function requireCase(value: unknown): asserts value {
  if (!value) throw new Error('Independent complete output and quarantine inventory case differs')
}
function normalized(rows: readonly IndependentOutputInventoryRow[], clocks = false): string {
  const record = (input: Readonly<Record<string, unknown>>, omitClock = false) =>
    Object.fromEntries(
      Object.entries(input)
        .filter(([key]) => !omitClock || key !== 'updated_at')
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
      .map(row => ({
        physicalRowId: row.physicalRowId,
        metadata: record(row.metadata, clocks),
        fields: record(row.fields)
      }))
  )
}
/** UNRUN real native controller cases. Expected complete scalar metadata and
 * eight full payloads are authored before import; expected provider-generated
 * quarantine clocks have independent finite writer intervals. Include a local
 * spendable reclaim output, an already-unspendable one, no matching output,
 * nonzero vout, repeated declarations, and a later output alias on either side
 * of the quarantine clock. Also include an unresolved reclaim for a new output
 * and a reclaimed transaction which permits spendability. Never infer expected
 * rows from candidate receipts or implement a replacement producer/controller. */
export async function verifyBrc38PrivateOutputInventory(
  controller: ActualController,
  expectedRows: readonly IndependentOutputInventoryRow[],
  expectedAliases: number,
  clockBounds: readonly Readonly<{ rowId: number; minimum: number; maximum: number }>[] = []
): Promise<void> {
  requireCase(
    expectedRows.length >= 2 &&
      expectedRows.length <= 128 &&
      Number.isSafeInteger(expectedAliases) &&
      expectedAliases >= 2 &&
      expectedAliases <= 128 &&
      clockBounds.length <= expectedRows.length
  )
  let bytes = 0
  for (const row of expectedRows) {
    requireCase(
      Number.isSafeInteger(row.physicalRowId) &&
        Object.keys(row.metadata).length >= 12 &&
        Object.keys(row.metadata).length <= 64 &&
        Object.keys(row.fields).length === outputPayloadFields.length
    )
    for (const name of outputPayloadFields) {
      const value = row.fields[name]
      requireCase(value === null || value instanceof Uint8Array)
      if (['outputDescription', 'type', 'purpose'].includes(name)) requireCase(value instanceof Uint8Array)
      bytes += value?.length ?? 0
    }
  }
  requireCase(bytes <= 1048576 && new Set(clockBounds.map(value => value.rowId)).size === clockBounds.length)
  for (const bound of clockBounds)
    requireCase(
      expectedRows.some(row => row.physicalRowId === bound.rowId) &&
        Number.isSafeInteger(bound.minimum) &&
        Number.isSafeInteger(bound.maximum) &&
        bound.minimum >= 0 &&
        bound.maximum >= bound.minimum &&
        bound.maximum - bound.minimum <= 1000
    )
  const compare = (actual: readonly IndependentOutputInventoryRow[]): void => {
      requireCase(normalized(actual, true) === normalized(expectedRows, true))
      for (const row of expectedRows) {
        const value = actual.find(item => item.physicalRowId === row.physicalRowId)
        requireCase(value !== undefined)
        const bound = clockBounds.find(item => item.rowId === row.physicalRowId)
        if (bound === undefined) requireCase(Object.is(value.metadata.updated_at, row.metadata.updated_at))
        else {
          requireCase(typeof value.metadata.updated_at === 'string')
          const stamp = new Date(value.metadata.updated_at).getTime()
          requireCase(
            Number.isFinite(stamp) &&
              stamp >= bound.minimum &&
              stamp <= bound.maximum &&
              new Date(stamp).toISOString() === value.metadata.updated_at
          )
        }
      }
    },
    working = controller.options.workingAllocation.used,
    inspect = async () =>
      await controller.withSource(
        async source =>
          await Brc38PrivateNativeMergeNode.with(controller.store, source, controller.options, async merge => {
            await merge.inspectRecoveryHistory()
            return await merge.inspectOutputRows()
          })
      )
  const result = await inspect(),
    original = await controller.readOutputsAndFullLogicalBytes()
  compare(original)
  requireCase(
    result.rows === expectedRows.length &&
      result.aliases === expectedAliases &&
      result.logicalBytes === String(bytes) &&
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
    'retained-transaction',
    'retained-derivation',
    'mapped-basket',
    'mapped-spender',
    'missing-quarantine',
    'extra-quarantine',
    'wrong-quarantine-output',
    'wrong-quarantine-order',
    'wrong-quarantine-clock',
    'quarantine-changed-local-null',
    'unresolved-reclaim-spendable',
    'wrong-transaction-postimage',
    'wrong-target-budget',
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
    requireCase(normalized(await controller.readOutputsAndFullLogicalBytes()) === normalized(original))
    controller.check()
  }
  const repeated = await inspect()
  requireCase(
    repeated.rows === result.rows &&
      repeated.aliases === result.aliases &&
      repeated.logicalBytes === result.logicalBytes &&
      normalized(await controller.readOutputsAndFullLogicalBytes()) === normalized(original) &&
      controller.options.workingAllocation.used === working
  )
  controller.check()
}
