import type { StorageKnex } from '../StorageKnex'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import type { Brc38DestinationSelection } from './Brc38KnexDestinationFence'
import type { Brc38PrivateNativeMergeOptions } from './Brc38PrivateNativeMergeNode'
import {
  runBrc38PrivateNativeMerge,
  type Brc38PrivateNativeMergeRunnerProgress,
  type Brc38PrivateNativeComposedInventory
} from './Brc38PrivateNativeMergeRunnerNode'
import { brc38NativeLocalBaselineTables, type Brc38NativeLocalBaselineTable } from './Brc38NativeLocalBaselineTables'
import type { IndependentLocalCandidateRow } from './Brc38PrivateLocalCandidateNode.case'
import { wipeIndependentNativeInventory } from './Brc38IndependentNativeInventoryFixture'

type Inventory = Readonly<Record<Brc38NativeLocalBaselineTable, readonly IndependentLocalCandidateRow[]>>
interface ActualController {
  readonly store: KnexBrc38StagingStore
  readonly storage: StorageKnex
  readonly selection: Brc38DestinationSelection
  readonly options: Brc38PrivateNativeMergeOptions
  readCandidate(): Promise<Inventory>
  /** Must prove no source read/native facade or queued merge operation is
   * retained at generator progress; the genuine fixture supplies owner probes. */
  assertProgressScopesDrained(): Promise<void>
  /** A real source mutation after acknowledged import progress; use a fresh
   * independently authored all47 changed oracle. No fabricated source actor. */
  mutateLiveSource(): Promise<void>
  check(): void
}
function requireCase(value: unknown): asserts value {
  if (!value) throw new Error('Independent bounded native merge runner case differs')
}
function normalize(value: unknown): unknown {
  if (value instanceof Uint8Array) return { bytes: Buffer.from(value).toString('hex') }
  if (typeof value === 'bigint') return { integer: value.toString() }
  if (Array.isArray(value)) return value.map(normalize)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, item]) => [name, normalize(item)])
    )
  return value
}
async function finish(
  controller: ActualController,
  mutate: boolean
): Promise<Readonly<Brc38PrivateNativeComposedInventory>> {
  const iterator = runBrc38PrivateNativeMerge(
    controller.store,
    controller.storage,
    controller.selection,
    controller.options,
    4096
  )
  let mutated = false,
    priorOperation = 0,
    progress: Readonly<Brc38PrivateNativeMergeRunnerProgress> | undefined
  try {
    for (let n = 0; n < 4097; n++) {
      const next = await iterator.next()
      if (next.done) {
        requireCase(!mutate || mutated)
        await controller.assertProgressScopesDrained()
        return next.value
      }
      progress = next.value
      requireCase(
        progress.operation > priorOperation && progress.operation <= 4096 && progress.elapsedMilliseconds >= 0
      )
      priorOperation = progress.operation
      await controller.assertProgressScopesDrained()
      if (mutate && !mutated && progress.progress.phase === 'IMPORT') {
        await controller.mutateLiveSource()
        mutated = true
      }
      controller.check()
    }
    throw new Error('Finite native runner case exceeded its independent operation guard')
  } finally {
    await iterator.return(undefined as never)
  }
}
/** UNRUN genuine initial/replacement native factories. Independently authored
 * graphs include original all47 pending/auxiliary rows, full incoming aliases,
 * new operational checkpoint, inert archive provenance and source changes.
 * The actual generator must drain before progress and refold a real foreground
 * update. Run ACK-loss/reopen, cancellation/return, expiry, disabled epoch and
 * original operation-bound variants on isolated genuine fixture instances. */
export async function verifyBrc38PrivateNativeMergeRunner(
  controller: ActualController,
  expected: Inventory,
  mutate = false
): Promise<void> {
  let rows = 0,
    bytes = 0
  for (const table of brc38NativeLocalBaselineTables) {
    requireCase(Array.isArray(expected[table]))
    rows += expected[table].length
    for (const row of expected[table])
      for (const value of Object.values(row.fields)) {
        requireCase(value instanceof Uint8Array || value === null)
        bytes += value?.length ?? 0
      }
  }
  requireCase(rows <= 128 && bytes <= 1048576)
  const used = controller.options.workingAllocation.used,
    result = await finish(controller, mutate),
    actual = await controller.readCandidate()
  try {
    requireCase(
      result.rows === rows &&
        result.logicalBytes === String(bytes) &&
        result.pages >= 1 &&
        result.journals >= 1 &&
        controller.options.workingAllocation.used === used
    )
    for (const table of brc38NativeLocalBaselineTables) {
      const ordered = (values: readonly IndependentLocalCandidateRow[]) => [...values].sort((a, b) => a.rowId - b.rowId)
      requireCase(
        JSON.stringify(normalize(ordered(actual[table]))) === JSON.stringify(normalize(ordered(expected[table])))
      )
    }
  } finally {
    wipeIndependentNativeInventory(actual)
  }
  const repeated = await finish(controller, false)
  requireCase(JSON.stringify(repeated) === JSON.stringify(result) && controller.options.workingAllocation.used === used)
  await controller.assertProgressScopesDrained()
  controller.check()
}
