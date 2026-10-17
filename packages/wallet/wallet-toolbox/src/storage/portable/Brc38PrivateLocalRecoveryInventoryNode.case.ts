import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import { Brc38PrivateNativeMergeNode, type Brc38PrivateNativeMergeOptions } from './Brc38PrivateNativeMergeNode'
import type { IndependentLocalCandidateRow } from './Brc38PrivateLocalCandidateNode.case'

interface ActualController {
  readonly store: KnexBrc38StagingStore
  readonly options: Brc38PrivateNativeMergeOptions
  withSource<T>(work: (source: Brc38NativeLocalBaselineSource) => Promise<T>): Promise<T>
  /** Independent actual SQL plus full logical-byte reads, not point hashes. */
  readLocalRecovery(): Promise<Readonly<Record<string, readonly IndependentLocalCandidateRow[]>>>
  withVariant<T>(
    variant:
      | 'settings-metadata'
      | 'prepared-beef-bytes'
      | 'action-batch-bytes'
      | 'transfer-part-bytes'
      | 'session-metadata'
      | 'primary-epoch'
      | 'reconciliation-bytes'
      | 'missing-row'
      | 'extra-row'
      | 'wrong-proof-epoch'
      | 'ready-after-proof-change'
      | 'wrong-stale-version'
      | 'wrong-invalidation-time'
      | 'stale-cache-metadata-changed'
      | 'wrong-proof-effect-bit'
      | 'shared-quota-bytes'
      | 'shared-quota-rows'
      | 'shared-quota-deduplicated-payload',
    work: () => Promise<T>
  ): Promise<T>
  check(): void
}
function requireCase(value: unknown): asserts value {
  if (!value) throw new Error('Independent post-import local recovery inventory differs')
}
function normalized(value: unknown): unknown {
  if (value instanceof Uint8Array) return { bytes: Buffer.from(value).toString('hex') }
  if (typeof value === 'bigint') return { integer: value.toString() }
  if (Array.isArray(value)) return value.map(normalized)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, cell]) => [key, normalized(cell)])
    )
  return value
}
/** UNRUN genuine completed occupied merge. Independently authored all34 table
 * fixtures include signed physical keys, typed metadata, null/empty and Unicode
 * text, BEEF/action/transfer fields and exact sessions/primary/reconciliation
 * values. Incoming core rows/checkpoint differ from the source baseline, while
 * 32 recovery families remain unchanged. Prepared-cache fixture postimages
 * independently reflect changed proof pages: epoch increments, READY rows
 * become stale/version zero and already-stale rows retain their metadata.
 * Include no-change, empty-cache and repeated changed/identical alias programs,
 * and shared stage/provenance payloads referenced by multiple different rows.
 * Full logical quota must charge every reference and remain source-exact.
 * Corruption variants are isolated;
 * neither a fake native store nor an implementation-derived oracle is valid. */
export async function verifyBrc38PrivatePostImportLocalRecovery(
  controller: ActualController,
  expected: Readonly<Record<string, readonly IndependentLocalCandidateRow[]>>,
  expectedLogicalBytes: number
): Promise<void> {
  requireCase(
    Object.keys(expected).length === 34 &&
      Number.isSafeInteger(expectedLogicalBytes) &&
      expectedLogicalBytes >= 0 &&
      expectedLogicalBytes <= 1048576
  )
  let rows = 0,
    bytes = 0
  for (const values of Object.values(expected)) {
    requireCase(Array.isArray(values))
    rows += values.length
    for (const row of values)
      for (const field of Object.values(row.fields)) {
        requireCase(field === null || field instanceof Uint8Array)
        bytes += field?.length ?? 0
      }
  }
  requireCase(rows <= 128 && bytes === expectedLogicalBytes)
  const used = controller.options.workingAllocation.used,
    inspect = async () =>
      await controller.withSource(
        async source =>
          await Brc38PrivateNativeMergeNode.with(
            controller.store,
            source,
            controller.options,
            async merge => await merge.inspectLocalRecovery()
          )
      )
  const result = await inspect()
  requireCase(result.rows === rows && result.logicalBytes === String(expectedLogicalBytes))
  const actual = await controller.readLocalRecovery()
  requireCase(Object.keys(actual).length === 34)
  for (const table of Object.keys(expected)) {
    const ordered = (values: readonly IndependentLocalCandidateRow[]) => [...values].sort((a, b) => a.rowId - b.rowId)
    requireCase(
      JSON.stringify(normalized(ordered(actual[table]))) === JSON.stringify(normalized(ordered(expected[table])))
    )
  }
  for (const variant of [
    'settings-metadata',
    'prepared-beef-bytes',
    'action-batch-bytes',
    'transfer-part-bytes',
    'session-metadata',
    'primary-epoch',
    'reconciliation-bytes',
    'missing-row',
    'extra-row',
    'wrong-proof-epoch',
    'ready-after-proof-change',
    'wrong-stale-version',
    'wrong-invalidation-time',
    'stale-cache-metadata-changed',
    'wrong-proof-effect-bit',
    'shared-quota-bytes',
    'shared-quota-rows',
    'shared-quota-deduplicated-payload'
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
  requireCase(controller.options.workingAllocation.used === used)
  controller.check()
}
