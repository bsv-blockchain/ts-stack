import { promiseFromSync } from '../../utility/promiseFromSync'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import { Brc38PrivateLocalCandidate, type Brc38PrivateLocalCandidateOptions } from './Brc38PrivateLocalCandidateNode'
import { brc38NativeLocalBaselineTables, type Brc38NativeLocalBaselineTable } from './Brc38NativeLocalBaselineTables'

export interface IndependentLocalCandidateRow {
  readonly rowId: number
  readonly metadata: Readonly<Record<string, unknown>>
  readonly fields: Readonly<Record<string, Uint8Array | null>>
}
type Inventory = Readonly<Record<Brc38NativeLocalBaselineTable, readonly IndependentLocalCandidateRow[]>>
interface ActualController {
  readonly store: KnexBrc38StagingStore
  readonly options: Brc38PrivateLocalCandidateOptions
  withSource<T>(work: (source: Brc38NativeLocalBaselineSource) => Promise<T>): Promise<T>
  /** Separate actual bounded SQL + logical packed-field reader, not the
   * source/candidate implementation under test and not point-hash inference. */
  readCandidate(): Promise<Inventory>
  mutateSource(): Promise<void>
  check(): void
}
function requireCase(value: unknown): asserts value {
  if (!value) throw new Error('Actual private local candidate differs from the independent fixture')
}
function normalized(value: unknown): unknown {
  if (value instanceof Uint8Array) return { bytes: Buffer.from(value).toString('hex') }
  if (typeof value === 'bigint') return { integer: value.toString() }
  if (Array.isArray(value)) return value.map(normalized)
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, normalized(item)])
    )
  return value
}
function bounded(expected: Inventory): void {
  let rows = 0,
    bytes = 0
  for (const table of brc38NativeLocalBaselineTables) {
    requireCase(Array.isArray(expected[table]))
    rows += expected[table].length
    for (const row of expected[table]) {
      requireCase(Number.isSafeInteger(row.rowId))
      for (const field of Object.values(row.fields)) {
        requireCase(field === null || field instanceof Uint8Array)
        bytes += field?.length ?? 0
      }
    }
  }
  requireCase(rows <= 128 && bytes <= 1048576)
}
async function inventory(controller: ActualController, expected: Inventory): Promise<void> {
  controller.check()
  const actual = await controller.readCandidate()
  for (const table of brc38NativeLocalBaselineTables) {
    const order = (rows: readonly IndependentLocalCandidateRow[]): readonly IndependentLocalCandidateRow[] =>
      [...rows].sort((a, b) => a.rowId - b.rowId)
    requireCase(JSON.stringify(normalized(order(actual[table]))) === JSON.stringify(normalized(order(expected[table]))))
  }
  controller.check()
}
/** UNRUN source case. Supply independent finite all47 fixtures, genuine
 * authenticated private structured stage, original resources, actual source
 * reader/writer and an independent candidate logical-field reader. Initial and
 * changed expectations are authored BEFORE source mutation. The changed graph
 * must include a parent deleted before a later child update, signed physical
 * key reuse, auxiliary binary/TEXT, null and empty values, actual snapshot
 * session checkpoints, ID mappings and exact primary epochs. No fake controller
 * or production readiness claim is supplied by this case. */
export async function verifyBrc38PrivateLocalCandidateResume(
  controller: ActualController,
  initial: Inventory,
  changed: Inventory
): Promise<void> {
  bounded(initial)
  bounded(changed)
  const owned = controller.options.workingAllocation.used
  let escaped: Brc38PrivateLocalCandidate | undefined
  // Stop partway through COPY; committed points survive callback drainage.
  await controller.withSource(
    async source =>
      await Brc38PrivateLocalCandidate.with(controller.store, source, controller.options, async candidate => {
        escaped = candidate
        requireCase((await candidate.step()).phase === 'COPY')
        controller.check()
      })
  )
  requireCase(controller.options.workingAllocation.used === owned && escaped !== undefined)
  let refused = false
  try {
    await escaped.step()
  } catch {
    refused = true
  }
  requireCase(refused)
  const finish = async (): Promise<void> => {
    await controller.withSource(
      async source =>
        await Brc38PrivateLocalCandidate.with(controller.store, source, controller.options, async candidate => {
          let done = false
          for (let pages = 0; !done && pages < 1024; pages++) {
            controller.check()
            const progress = await candidate.step()
            requireCase(progress.copiedRows >= 0 && progress.copiedRows <= controller.options.maximumStepRows)
            done = progress.recoveryRequired && progress.garbageComplete
          }
          requireCase(done)
          // RECOVERY is stable yet explicitly unfinished: it never grants an
          // active provider or a complete recovery-state/primary-cutover verdict.
          const again = await candidate.step()
          requireCase(
            again.phase === 'RECOVERY' && again.recoveryRequired && again.copiedRows === 0 && again.garbageComplete
          )
        })
    )
    requireCase(controller.options.workingAllocation.used === owned)
  }
  await finish()
  await inventory(controller, initial)
  // Original resource policy is replay-bound, not silently resized on resume.
  refused = false
  try {
    await controller.withSource(
      async source =>
        await Brc38PrivateLocalCandidate.with(
          controller.store,
          source,
          {
            ...controller.options,
            maximumReadBytes:
              controller.options.maximumReadBytes === 16384 ? 16383 : controller.options.maximumReadBytes + 1
          },
          () => promiseFromSync(() => undefined)
        )
    )
  } catch {
    refused = true
  }
  requireCase(refused && controller.options.workingAllocation.used === owned)
  await controller.mutateSource()
  await finish()
  await inventory(controller, changed)
  // Exact source epoch and original binding must survive every restart; the
  // owning fixture's separate epoch/binding-refusal cases exercise replacement.
  controller.check()
}

/** Separate genuine fixture: changed must reuse an old parent's natural UNIQUE
 * key under a different physical ID, and move a surviving child to that parent.
 * It must also swap two independent natural keys through a temporary source
 * value. Expectations precede mutation. No implementation-derived oracle. */
export async function verifyBrc38PrivateLocalCandidateUniqueRebuild(
  controller: ActualController,
  initial: Inventory,
  changed: Inventory
): Promise<void> {
  bounded(initial)
  bounded(changed)
  const owned = controller.options.workingAllocation.used
  const finish = async (): Promise<void> => {
    await controller.withSource(
      async source =>
        await Brc38PrivateLocalCandidate.with(controller.store, source, controller.options, async candidate => {
          let complete = false
          for (let step = 0; !complete && step < 2048; step++) {
            const progress = await candidate.step()
            requireCase(progress.rebuilds <= 3 && progress.copiedRows <= controller.options.maximumStepRows)
            complete = progress.recoveryRequired && progress.garbageComplete
            controller.check()
          }
          requireCase(complete)
        })
    )
  }
  await finish()
  await inventory(controller, initial)
  await controller.mutateSource()
  // Commit the conflict and exactly one bounded cleanup operation, then drain
  // the actual callback. A fresh scope must continue with no initializer rows
  // reappearing in an already cleared table.
  let observed = false
  await controller.withSource(
    async source =>
      await Brc38PrivateLocalCandidate.with(controller.store, source, controller.options, async candidate => {
        for (let step = 0; !observed && step < 512; step++) {
          const progress = await candidate.step()
          requireCase(!progress.recoveryRequired)
          observed = progress.phase === 'CLEAR'
          if (observed) {
            requireCase(progress.rebuilds === 1 && progress.clearTable === brc38NativeLocalBaselineTables.length - 1)
            const cleanup = await candidate.step()
            requireCase(cleanup.phase === 'CLEAR' && cleanup.rebuilds === 1 && cleanup.copiedRows === 0)
          }
          controller.check()
        }
        requireCase(observed)
      })
  )
  requireCase(controller.options.workingAllocation.used === owned)
  await finish()
  await inventory(controller, changed)
  requireCase(controller.options.workingAllocation.used === owned)
  controller.check()
}
