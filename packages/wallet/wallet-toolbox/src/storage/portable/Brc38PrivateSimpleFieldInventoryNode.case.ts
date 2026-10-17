import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import { Brc38PrivateNativeMergeNode, type Brc38PrivateNativeMergeOptions } from './Brc38PrivateNativeMergeNode'

export interface IndependentSimpleFieldInventoryRow {
  readonly table: 'certificates' | 'certificate_fields' | 'commissions'
  readonly physicalRowId: number
  readonly metadata: Readonly<Record<string, string | number | bigint | boolean | null>>
  /** Independent complete logical byte oracle, preserving null versus empty. */
  readonly fields: Readonly<Record<string, Uint8Array | null>>
}
interface ActualController {
  readonly store: KnexBrc38StagingStore
  readonly options: Brc38PrivateNativeMergeOptions
  withSource<T>(work: (source: Brc38NativeLocalBaselineSource) => Promise<T>): Promise<T>
  readRowsAndFullLogicalBytes(): Promise<readonly IndependentSimpleFieldInventoryRow[]>
  withVariant<T>(
    variant:
      | 'same-length-text'
      | 'same-length-binary'
      | 'wrong-selected-origin'
      | 'null-empty'
      | 'wrong-pointer'
      | 'wrong-full-hash'
      | 'changed-local-payload'
      | 'missing-local-row'
      | 'extra-row'
      | 'alias-order'
      | 'creation-date'
      | 'certificate-identity'
      | 'certificate-parent'
      | 'commission-retention'
      | 'source-revision',
    work: () => Promise<T>
  ): Promise<T>
  check(): void
}
function requireCase(value: unknown): asserts value {
  if (!value) throw new Error('Independent simple field semantic inventory case differs')
}
function normalized(rows: readonly IndependentSimpleFieldInventoryRow[]): string {
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
      .sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : a.physicalRowId - b.physicalRowId))
      .map(row => ({
        table: row.table,
        physicalRowId: row.physicalRowId,
        metadata: record(row.metadata),
        fields: record(row.fields)
      }))
  )
}
/** UNRUN. Actual occupied/reopened native fixtures must contain all three
 * families, untouched local rows, different archive user IDs, signed incoming
 * IDs, same-target aliases, equal/older/newer timestamps, Unicode/BOM content,
 * null/empty verifier, inline and staged fields, and retained commission
 * script/key-offset/transaction/value with newer redemption state. Expected
 * metadata/full bytes are authored independently BEFORE the import runs. */
export async function verifyBrc38PrivateSimpleFieldInventory(
  controller: ActualController,
  expectedRows: readonly IndependentSimpleFieldInventoryRow[],
  expectedAliases: number
): Promise<void> {
  requireCase(
    expectedRows.length >= 3 &&
      expectedRows.length <= 128 &&
      Number.isSafeInteger(expectedAliases) &&
      expectedAliases >= 2 &&
      expectedAliases <= 128
  )
  for (const table of ['certificates', 'certificate_fields', 'commissions'])
    requireCase(expectedRows.some(row => row.table === table))
  let logicalBytes = 0
  for (const row of expectedRows) {
    requireCase(
      Number.isSafeInteger(row.physicalRowId) &&
        Object.keys(row.metadata).length >= 5 &&
        Object.keys(row.metadata).length <= 32
    )
    for (const value of Object.values(row.fields)) {
      requireCase(value === null || value instanceof Uint8Array)
      logicalBytes += value?.length ?? 0
    }
  }
  requireCase(logicalBytes <= 1048576)
  const expected = normalized(expectedRows),
    working = controller.options.workingAllocation.used,
    inspect = async () =>
      await controller.withSource(
        async source =>
          await Brc38PrivateNativeMergeNode.with(controller.store, source, controller.options, async merge => {
            await merge.inspectRecoveryHistory()
            return await merge.inspectSimpleFieldRows()
          })
      )
  const result = await inspect()
  requireCase(
    result.rows === expectedRows.length &&
      result.aliases === expectedAliases &&
      result.logicalBytes === String(logicalBytes) &&
      normalized(await controller.readRowsAndFullLogicalBytes()) === expected &&
      controller.options.workingAllocation.used === working
  )
  for (const variant of [
    'same-length-text',
    'same-length-binary',
    'wrong-selected-origin',
    'null-empty',
    'wrong-pointer',
    'wrong-full-hash',
    'changed-local-payload',
    'missing-local-row',
    'extra-row',
    'alias-order',
    'creation-date',
    'certificate-identity',
    'certificate-parent',
    'commission-retention',
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
    requireCase(normalized(await controller.readRowsAndFullLogicalBytes()) === expected)
    controller.check()
  }
  const repeated = await inspect()
  requireCase(
    repeated.rows === result.rows &&
      repeated.aliases === result.aliases &&
      repeated.logicalBytes === result.logicalBytes &&
      normalized(await controller.readRowsAndFullLogicalBytes()) === expected &&
      controller.options.workingAllocation.used === working
  )
  controller.check()
}
