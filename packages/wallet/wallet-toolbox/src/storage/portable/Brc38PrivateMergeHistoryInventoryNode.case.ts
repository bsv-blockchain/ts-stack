import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import { Brc38PrivateNativeMergeNode, type Brc38PrivateNativeMergeOptions } from './Brc38PrivateNativeMergeNode'

export interface IndependentMergeRecoveryInventory {
  readonly journals: number
  readonly originals: number
  readonly mappedIds: number
  readonly originalLogicalBytes: number
  readonly pages: number
}
interface ActualController {
  readonly store: KnexBrc38StagingStore
  readonly options: Brc38PrivateNativeMergeOptions
  withSource<T>(work: (source: Brc38NativeLocalBaselineSource) => Promise<T>): Promise<T>
  /** Separate actual original-byte/mapping readers. Expected values are
   * authored from the finite fixture BEFORE any mutation, never from receipts. */
  readRecoveryRowsAndBytes(): Promise<readonly unknown[]>
  /** Actual isolated corruption/negative fixture variants, each reopened by
   * the genuine native factory; no replacement store, schema-verdict stub or
   * monkey-patched inventory implementation. Ordinary guards remain required. */
  withVariant<T>(
    variant:
      | 'same-length-original'
      | 'wrong-original-table'
      | 'missing-original'
      | 'extra-original'
      | 'wrong-map-scope'
      | 'missing-map'
      | 'extra-map'
      | 'wrong-active-target'
      | 'wrong-original-budget'
      | 'missing-page'
      | 'extra-page'
      | 'wrong-page-source'
      | 'wrong-page-predecessor'
      | 'wrong-page-receipt'
      | 'wrong-page-cache-epoch'
      | 'wrong-page-budget',
    work: () => Promise<T>
  ): Promise<T>
  check(): void
}
function requireCase(value: unknown): asserts value {
  if (!value) throw new Error('Independent merge recovery inventory differs')
}
/** UNRUN. Supply actual completed active and interrupted historical episodes,
 * different local/source user IDs, signed/exponent incoming IDs, same-target
 * aliases, Unicode envelopes, binary/TEXT/null/empty descriptors and a header
 * wider than the original transfer width. Physical variants are isolated from
 * the canonical fixture. Complete current row semantics remain a separate
 * composed-inventory requirement; this case verifies the recovery DATA graph. */
export async function verifyBrc38PrivateMergeRecoveryInventory(
  controller: ActualController,
  expected: IndependentMergeRecoveryInventory,
  expectedRowsAndBytes: readonly unknown[]
): Promise<void> {
  requireCase(
    Number.isSafeInteger(expected.journals) &&
      expected.journals >= 1 &&
      expected.journals <= 4 &&
      Number.isSafeInteger(expected.originals) &&
      expected.originals >= 1 &&
      expected.originals <= 128 &&
      Number.isSafeInteger(expected.mappedIds) &&
      expected.mappedIds >= 0 &&
      expected.mappedIds <= 128 &&
      Number.isSafeInteger(expected.originalLogicalBytes) &&
      expected.originalLogicalBytes >= 1 &&
      expected.originalLogicalBytes <= 1048576 &&
      Number.isSafeInteger(expected.pages) &&
      expected.pages >= 1 &&
      expected.pages <= expected.originals &&
      expectedRowsAndBytes.length <= 128
  )
  const used = controller.options.workingAllocation.used,
    inspect = async () =>
      await controller.withSource(
        async source =>
          await Brc38PrivateNativeMergeNode.with(
            controller.store,
            source,
            controller.options,
            async merge => await merge.inspectRecoveryHistory()
          )
      )
  const actual = await inspect()
  for (const field of ['journals', 'originals', 'mappedIds', 'originalLogicalBytes', 'pages'] as const)
    requireCase(actual[field] === expected[field])
  requireCase(
    JSON.stringify(await controller.readRecoveryRowsAndBytes()) === JSON.stringify(expectedRowsAndBytes) &&
      controller.options.workingAllocation.used === used
  )
  for (const variant of [
    'same-length-original',
    'wrong-original-table',
    'missing-original',
    'extra-original',
    'wrong-map-scope',
    'missing-map',
    'extra-map',
    'wrong-active-target',
    'wrong-original-budget',
    'missing-page',
    'extra-page',
    'wrong-page-source',
    'wrong-page-predecessor',
    'wrong-page-receipt',
    'wrong-page-cache-epoch',
    'wrong-page-budget'
  ] as const) {
    await controller.withVariant(variant, async () => {
      let refused = false
      try {
        await inspect()
      } catch {
        refused = true
      }
      requireCase(refused && controller.options.workingAllocation.used === used)
    })
    controller.check()
  }
  requireCase(JSON.stringify(await controller.readRecoveryRowsAndBytes()) === JSON.stringify(expectedRowsAndBytes))
  controller.check()
}
