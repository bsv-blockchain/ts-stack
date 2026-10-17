import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import { Brc38PrivateLocalCandidate, Brc38PrivateCompositionRequiredError } from './Brc38PrivateLocalCandidateNode'
import {
  Brc38PrivateNativeMergeNode,
  type Brc38PrivateNativeMergeOptions,
  type Brc38PrivateNativeMergeProgress
} from './Brc38PrivateNativeMergeNode'
import { brc38NativeLocalBaselineTables, type Brc38NativeLocalBaselineTable } from './Brc38NativeLocalBaselineTables'
import type { IndependentLocalCandidateRow } from './Brc38PrivateLocalCandidateNode.case'
import { wipeIndependentNativeInventory } from './Brc38IndependentNativeInventoryFixture'

type Inventory = Readonly<Record<Brc38NativeLocalBaselineTable, readonly IndependentLocalCandidateRow[]>>
interface ActualController {
  /** Current genuine reopened stage; a fixture may replace its actual kernel
   * after the committed acknowledgement-loss operation. */
  readonly store: KnexBrc38StagingStore
  readonly options: Brc38PrivateNativeMergeOptions
  withSource<T>(work: (source: Brc38NativeLocalBaselineSource) => Promise<T>): Promise<T>
  /** Independent finite SQL/packed-byte readers, never receipt/hash inference. */
  readCandidate(): Promise<Inventory>
  readJournals(): Promise<
    readonly Readonly<{ importId: string; admissionJson: string; receiptJson: string; mappedIds: number }>[]
  >
  readIncomingUsage(): Promise<readonly Readonly<{ tableId: number; used: number; first: number; count: number }>[]>
  /** Drop the acknowledgement AFTER the actual page transaction committed,
   * then drain/reopen the genuine stage. It must throw its explicit marker. */
  loseCommittedAcknowledgement(work: () => Promise<Brc38PrivateNativeMergeProgress>): Promise<never>
  readonly lostAcknowledgement: object
  mutateSource(): Promise<void>
  check(): void
}
function requireCase(value: unknown): asserts value {
  if (!value) throw new Error('Independent native merge/recovery case differs')
}
function normalize(value: unknown): unknown {
  if (value instanceof Uint8Array) return { bytes: Buffer.from(value).toString('hex') }
  if (typeof value === 'bigint') return { integer: value.toString() }
  if (Array.isArray(value)) return value.map(normalize)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, normalize(item)])
    )
  return value
}
function fixtureBound(expected: Inventory): void {
  let rows = 0,
    bytes = 0
  for (const table of brc38NativeLocalBaselineTables) {
    requireCase(Array.isArray(expected[table]))
    rows += expected[table].length
    for (const row of expected[table])
      for (const field of Object.values(row.fields)) {
        requireCase(field === null || field instanceof Uint8Array)
        bytes += field?.length ?? 0
      }
  }
  requireCase(rows <= 128 && bytes <= 1048576)
}
async function compare(controller: ActualController, expected: Inventory): Promise<void> {
  const actual = await controller.readCandidate()
  try {
    for (const table of brc38NativeLocalBaselineTables) {
      const ordered = (rows: readonly IndependentLocalCandidateRow[]) => [...rows].sort((a, b) => a.rowId - b.rowId)
      requireCase(
        JSON.stringify(normalize(ordered(actual[table]))) === JSON.stringify(normalize(ordered(expected[table])))
      )
    }
  } finally {
    wipeIndependentNativeInventory(actual)
  }
  controller.check()
}
/** UNRUN. Requires independently authored all47 composed graphs BEFORE any
 * operation: occupied scalar aliases, binary/TEXT null/empty distinctions,
 * parent transactions/proofs, notify/history, inert archived sync provenance
 * and exact operational checkpoint effects. The changed graph includes source
 * natural-key moves and foreground IDs above the original reservation floors.
 * A genuine packaged native fixture must supply real source/private ownership,
 * full logical-byte readers and committed ACK loss; no fake controller or
 * production/funded acceptance is provided here. */
export async function verifyBrc38PrivateNativeMergeRefold(
  controller: ActualController,
  initial: Inventory,
  changed: Inventory
): Promise<void> {
  fixtureBound(initial)
  fixtureBound(changed)
  const working = controller.options.workingAllocation.used
  const withMerge = async <T>(work: (merge: Brc38PrivateNativeMergeNode) => Promise<T>) =>
    await controller.withSource(
      async source => await Brc38PrivateNativeMergeNode.with(controller.store, source, controller.options, work)
    )
  let prepared = false,
    escaped: Brc38PrivateNativeMergeNode | undefined,
    originalId = ''
  for (let n = 0; !prepared && n < 4096; n++)
    await withMerge(async merge => {
      escaped = merge
      const progress = await merge.step()
      requireCase(progress.episode <= 3)
      prepared = progress.phase === 'PREPARED'
      if (prepared) {
        const status = await merge.status()
        requireCase(status.phase === 'IMPORT' && status.receipt?.nextRow === 0 && status.admission !== undefined)
        originalId = status.admission.scope.importId
      }
      controller.check()
    })
  requireCase(prepared && escaped !== undefined && controller.options.workingAllocation.used === working)
  let refused = false
  try {
    await escaped.status()
  } catch {
    refused = true
  }
  requireCase(refused)
  const preparedJournals = await controller.readJournals()
  requireCase(preparedJournals.length === 1 && preparedJournals[0].importId === originalId)
  await withMerge(async merge => {
    const status = await merge.status()
    requireCase(status.admission?.scope.importId === originalId && status.receipt?.nextRow === 0)
  })
  requireCase(JSON.stringify(await controller.readJournals()) === JSON.stringify(preparedJournals))
  let ackLost = false
  try {
    await controller.loseCommittedAcknowledgement(async () => await withMerge(async merge => await merge.step()))
  } catch (cause) {
    requireCase(cause === controller.lostAcknowledgement)
    ackLost = true
  }
  requireCase(ackLost && controller.options.workingAllocation.used === working)
  await withMerge(async merge => {
    const status = await merge.status()
    requireCase(
      status.admission?.scope.importId === originalId && status.receipt !== undefined && status.receipt.nextRow > 0
    )
  })
  const finish = async (expected: Inventory): Promise<void> => {
    let done = false
    for (let n = 0; !done && n < 4096; n++)
      await withMerge(async merge => {
        const progress = await merge.step()
        requireCase(progress.episode <= 3)
        done = progress.phase === 'INVENTORY_REQUIRED'
        if (done) {
          const inventory = await merge.inspectComposedRows()
          let rows = 0,
            bytes = 0
          for (const table of brc38NativeLocalBaselineTables) {
            rows += expected[table].length
            for (const row of expected[table])
              for (const value of Object.values(row.fields)) bytes += value?.length ?? 0
          }
          requireCase(
            inventory.rows === rows &&
              inventory.logicalBytes === String(bytes) &&
              inventory.pages >= 1 &&
              inventory.journals >= 1
          )
        }
        controller.check()
      })
    requireCase(done && controller.options.workingAllocation.used === working)
  }
  await finish(initial)
  await compare(controller, initial)
  const journals = await controller.readJournals(),
    usage = await controller.readIncomingUsage()
  requireCase(journals.length === 1 && usage.length <= 10 && usage.some(row => row.used > 0))
  await controller.mutateSource()
  // Ordinary copying must refuse BEFORE mutation when incoming effects exist.
  refused = false
  try {
    await controller.withSource(
      async source =>
        await Brc38PrivateLocalCandidate.with(
          controller.store,
          source,
          controller.options,
          async candidate => await candidate.step()
        )
    )
  } catch (cause) {
    requireCase(cause instanceof Brc38PrivateCompositionRequiredError)
    refused = true
  }
  requireCase(refused)
  await compare(controller, initial)
  requireCase(JSON.stringify(await controller.readJournals()) === JSON.stringify(journals))
  await withMerge(async merge => {
    const progress = await merge.step()
    requireCase(progress.phase === 'REFOLD' && progress.episode === 1)
  })
  // Drain during CLEAR. New scopes cannot reinitialize rows or reset consumed
  // IDs, and immutable historical import records remain byte-for-byte intact.
  await withMerge(async merge => {
    requireCase((await merge.step()).phase === 'BASELINE')
  })
  requireCase(
    JSON.stringify(await controller.readJournals()) === JSON.stringify(journals) &&
      JSON.stringify(await controller.readIncomingUsage()) === JSON.stringify(usage)
  )
  await finish(changed)
  await compare(controller, changed)
  const after = await controller.readJournals(),
    nextUsage = await controller.readIncomingUsage()
  requireCase(
    after.length === 2 &&
      after.some(row => JSON.stringify(row) === JSON.stringify(journals[0])) &&
      after.some(row => row.importId !== originalId)
  )
  for (const row of usage) {
    const next = nextUsage.find(value => value.tableId === row.tableId)
    requireCase(next !== undefined && next.first === row.first && next.count === row.count && next.used >= row.used)
  }
  controller.check()
}
/** The same genuine candidate must reject changed structured resource DATA
 * before any copy/page/preview mutation; expiration is never refreshed. */
export async function verifyBrc38PrivateNativeMergePolicyResume(
  controller: Pick<ActualController, 'store' | 'options' | 'withSource' | 'readJournals' | 'check'>
): Promise<void> {
  const before = await controller.readJournals(),
    working = controller.options.workingAllocation.used,
    resources = controller.options.structuredResources,
    width = resources.projectionPolicy.maximumScalarBytes,
    altered = {
      ...controller.options,
      structuredResources: {
        ...resources,
        projectionPolicy: { ...resources.projectionPolicy, maximumScalarBytes: width - 1 }
      }
    }
  requireCase(width > 2)
  let refused = false
  try {
    await controller.withSource(
      async source =>
        await Brc38PrivateNativeMergeNode.with(controller.store, source, altered, async merge => await merge.step())
    )
  } catch {
    refused = true
  }
  requireCase(
    refused &&
      controller.options.workingAllocation.used === working &&
      JSON.stringify(await controller.readJournals()) === JSON.stringify(before)
  )
  // The coordinator must translate the original sync-map projection packet
  // into request fields without silently granting another bank or quota.
  for (const bounded of [
    { ...resources, projectionPolicy: { ...resources.projectionPolicy, maximumTemporaryFileBytes: 6291455 } },
    { ...resources, sourcePolicy: { ...resources.sourcePolicy, maximumTemporaryIndexBytes: 2097151 } },
    {
      ...resources,
      maximumCombinedTemporaryBytes:
        2 * resources.sourcePolicy.maximumTemporaryIndexBytes + resources.projectionPolicy.maximumTemporaryFileBytes - 1
    }
  ]) {
    let callbackReached = false,
      denied = false
    try {
      await controller.withSource(
        async source =>
          await Brc38PrivateNativeMergeNode.with(
            controller.store,
            source,
            { ...controller.options, structuredResources: bounded },
            async () => {
              callbackReached = true
            }
          )
      )
    } catch {
      denied = true
    }
    requireCase(
      denied &&
        !callbackReached &&
        controller.options.workingAllocation.used === working &&
        JSON.stringify(await controller.readJournals()) === JSON.stringify(before)
    )
  }
  controller.check()
}

interface ActualComposedController extends ActualController {
  /** Real mutation between drained partition reads, performed by the genuine
   * fixture. No monkey-patched verifier or fake owner may supply this hook. */
  withInventoryVariant<T>(
    variant:
      | 'user-after-compare'
      | 'proof-after-compare'
      | 'scalar-after-compare'
      | 'output-after-compare'
      | 'request-after-compare'
      | 'checkpoint-after-compare'
      | 'recovery-after-compare'
      | 'primary-after-compare'
      | 'enabled-generation-change'
      | 'changed-complete-receipt'
      | 'changed-original-pages'
      | 'full-row-budget'
      | 'expired-before-cleanup'
      | 'live-core-during-inventory'
      | 'live-auxiliary-during-inventory'
      | 'live-primary-during-inventory',
    work: () => Promise<T>
  ): Promise<T>
}
/** UNRUN. Full genuine composed inventory must refuse when an actual later
 * transaction invalidates any earlier partition. Independent all47 metadata/
 * full-field oracles predate the import. Repeated inspection drains its actual
 * comparison holds and queued content, without changing wallet rows or clocks.
 * This case is not publication/current-source/cutover qualification. */
export async function verifyBrc38PrivateComposedInventory(
  controller: ActualComposedController,
  expected: Inventory
): Promise<void> {
  fixtureBound(expected)
  let rows = 0,
    bytes = 0
  for (const table of brc38NativeLocalBaselineTables) {
    rows += expected[table].length
    for (const row of expected[table]) for (const value of Object.values(row.fields)) bytes += value?.length ?? 0
  }
  const used = controller.options.workingAllocation.used,
    inspect = async () =>
      await controller.withSource(
        async source =>
          await Brc38PrivateNativeMergeNode.with(
            controller.store,
            source,
            controller.options,
            async merge => await merge.inspectComposedRows()
          )
      )
  const initial = await inspect()
  requireCase(
    initial.rows === rows &&
      initial.logicalBytes === String(bytes) &&
      initial.pages >= 1 &&
      initial.journals >= 1 &&
      controller.options.workingAllocation.used === used
  )
  await compare(controller, expected)
  for (const variant of [
    'user-after-compare',
    'proof-after-compare',
    'scalar-after-compare',
    'output-after-compare',
    'request-after-compare',
    'checkpoint-after-compare',
    'recovery-after-compare',
    'primary-after-compare',
    'enabled-generation-change',
    'changed-complete-receipt',
    'changed-original-pages',
    'full-row-budget',
    'expired-before-cleanup',
    'live-core-during-inventory',
    'live-auxiliary-during-inventory',
    'live-primary-during-inventory'
  ] as const) {
    await controller.withInventoryVariant(variant, async () => {
      let refused = false
      try {
        await inspect()
      } catch {
        refused = true
      }
      requireCase(refused && controller.options.workingAllocation.used === used)
    })
    await compare(controller, expected)
    controller.check()
  }
  const repeated = await inspect()
  requireCase(
    JSON.stringify(repeated) === JSON.stringify(initial) && controller.options.workingAllocation.used === used
  )
  await compare(controller, expected)
  controller.check()
}
