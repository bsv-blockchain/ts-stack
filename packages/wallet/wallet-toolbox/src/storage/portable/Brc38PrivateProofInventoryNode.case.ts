import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import { Brc38PrivateNativeMergeNode, type Brc38PrivateNativeMergeOptions } from './Brc38PrivateNativeMergeNode'
import type { IndependentLocalCandidateRow } from './Brc38PrivateLocalCandidateNode.case'

interface ActualController {
  readonly store: KnexBrc38StagingStore
  readonly options: Brc38PrivateNativeMergeOptions
  withSource<T>(work: (source: Brc38NativeLocalBaselineSource) => Promise<T>): Promise<T>
  /** Separate actual SQL/full logical-field reader. */
  readProofRows(): Promise<readonly IndependentLocalCandidateRow[]>
  withVariant<T>(
    variant:
      | 'same-length-raw'
      | 'same-length-merkle'
      | 'wrong-original-source'
      | 'wrong-pointer'
      | 'wrong-proof-metadata'
      | 'wrong-creation-time'
      | 'wrong-update-time'
      | 'missing-proof'
      | 'extra-proof'
      | 'wrong-alias-map'
      | 'wrong-proof-effect-bit'
      | 'wrong-page-cache-epoch'
      | 'wrong-cache-ready-id'
      | 'wrong-cache-timestamp'
      | 'wrong-page-fingerprint',
    work: () => Promise<T>
  ): Promise<T>
  check(): void
}
function requireCase(value: unknown): asserts value {
  if (!value) throw new Error('Independent proof postimages or cache effects differ')
}
function normalized(value: unknown): unknown {
  if (value instanceof Uint8Array) return { bytes: Buffer.from(value).toString('hex') }
  if (typeof value === 'bigint') return { integer: value.toString() }
  if (Array.isArray(value)) return value.map(normalized)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, field]) => [name, normalized(field)])
    )
  return value
}
/** UNRUN. Genuine completed private merges with finite independently authored
 * proof rows: unchanged local spelling/timestamps, changed incoming timestamp,
 * preserved creation, new mapped IDs, repeated identical/changed aliases,
 * aliases separated by page boundaries and lost-ACK replay. Include READY,
 * already-stale, empty and unchanged prepared caches. Clock bounds are captured
 * independently around actual page commits, never obtained from the inspector.
 * Every variant uses an isolated actual native candidate and original source;
 * no fake reader, producer, semantic verdict or replacement native owner. */
export async function verifyBrc38PrivateProofInventory(
  controller: ActualController,
  expected: Readonly<{
    proofs: readonly IndependentLocalCandidateRow[]
    aliases: number
    cacheInvalidations: number
    cacheTimestamp: Readonly<{ earliest: number; latest: number }> | null
  }>
): Promise<void> {
  requireCase(
    expected.proofs.length <= 64 &&
      Number.isSafeInteger(expected.aliases) &&
      expected.aliases >= 0 &&
      expected.aliases <= 128 &&
      Number.isSafeInteger(expected.cacheInvalidations) &&
      expected.cacheInvalidations >= 0 &&
      expected.cacheInvalidations <= expected.aliases
  )
  let bytes = 0
  for (const row of expected.proofs) {
    requireCase(Object.keys(row.fields).length === 2)
    for (const name of ['rawTx', 'merklePath']) {
      const field = row.fields[name]
      requireCase(field instanceof Uint8Array && field.length >= 1)
      bytes += field.length
    }
  }
  requireCase(bytes <= 1048576)
  const used = controller.options.workingAllocation.used,
    inspect = async () =>
      await controller.withSource(
        async source =>
          await Brc38PrivateNativeMergeNode.with(
            controller.store,
            source,
            controller.options,
            async merge => await merge.inspectProofRows()
          )
      )
  const result = await inspect()
  requireCase(
    result.rows === expected.proofs.length &&
      result.aliases === expected.aliases &&
      result.logicalBytes === String(bytes) &&
      result.cacheInvalidations === expected.cacheInvalidations
  )
  if (expected.cacheTimestamp === null) requireCase(result.cacheUpdatedAt === null)
  else {
    requireCase(
      Number.isSafeInteger(expected.cacheTimestamp.earliest) &&
        Number.isSafeInteger(expected.cacheTimestamp.latest) &&
        expected.cacheTimestamp.latest >= expected.cacheTimestamp.earliest &&
        typeof result.cacheUpdatedAt === 'string'
    )
    const time = Date.parse(result.cacheUpdatedAt)
    requireCase(
      Number.isSafeInteger(time) &&
        new Date(time).toISOString() === result.cacheUpdatedAt &&
        time >= expected.cacheTimestamp.earliest &&
        time <= expected.cacheTimestamp.latest
    )
  }
  const ordered = (rows: readonly IndependentLocalCandidateRow[]) => [...rows].sort((a, b) => a.rowId - b.rowId)
  requireCase(
    JSON.stringify(normalized(ordered(await controller.readProofRows()))) ===
      JSON.stringify(normalized(ordered(expected.proofs))) && controller.options.workingAllocation.used === used
  )
  for (const variant of [
    'same-length-raw',
    'same-length-merkle',
    'wrong-original-source',
    'wrong-pointer',
    'wrong-proof-metadata',
    'wrong-creation-time',
    'wrong-update-time',
    'missing-proof',
    'extra-proof',
    'wrong-alias-map',
    'wrong-proof-effect-bit',
    'wrong-page-cache-epoch',
    'wrong-cache-ready-id',
    'wrong-cache-timestamp',
    'wrong-page-fingerprint'
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
  requireCase(
    JSON.stringify(normalized(ordered(await controller.readProofRows()))) ===
      JSON.stringify(normalized(ordered(expected.proofs)))
  )
  controller.check()
}
