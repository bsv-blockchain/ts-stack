import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import { Brc38PrivateLocalCandidate, type Brc38PrivateLocalCandidateOptions } from './Brc38PrivateLocalCandidateNode'

export interface IndependentPriorImportRecord {
  readonly lineage: string
  readonly tableId: number
  readonly sourceRowId: number
  readonly metadata: Readonly<Record<string, unknown>>
  readonly field: Uint8Array | undefined
}
interface ActualController {
  readonly store: KnexBrc38StagingStore
  readonly options: Brc38PrivateLocalCandidateOptions
  withSource<T>(work: (source: Brc38NativeLocalBaselineSource) => Promise<T>): Promise<T>
  /** Separate actual SQL/tag decoder and chunk reader; expected records are
   * authored independently before source construction or copying. */
  readPriorRecords(): Promise<readonly IndependentPriorImportRecord[]>
  /** Real writer interruption after a durable chunk commit, supplied by the
   * actual qualification controller, never a fake return or receipt. */
  interruptAfterCommittedChunk(): Promise<void>
  check(): void
}
function requireCase(value: unknown): asserts value {
  if (!value) throw new Error('Independent private prior-import case differs')
}
function equal(a: unknown, b: unknown): boolean {
  return a instanceof Uint8Array && b instanceof Uint8Array
    ? a.byteLength === b.byteLength && a.every((byte, at) => byte === b[at])
    : Object.is(a, b)
}
/** UNRUN actual-controller case. Fixture includes all eighteen original
 * families plus two historical lineages reusing the same table/row IDs, a
 * retained payload with different chunk boundaries, and signed physical keys.
 * Independent full typed data, not metadata hashes, proves repeated retention. */
export async function verifyBrc38PrivatePriorImportResume(
  controller: ActualController,
  expected: readonly IndependentPriorImportRecord[]
): Promise<void> {
  requireCase(
    expected.length >= 2 &&
      expected.length <= 128 &&
      expected.every(
        record =>
          /^[0-9a-f]{64}$/.test(record.lineage) &&
          Number.isSafeInteger(record.tableId) &&
          record.tableId >= 0 &&
          record.tableId < 18 &&
          Number.isSafeInteger(record.sourceRowId) &&
          (record.field === undefined || record.field.byteLength <= 131072)
      )
  )
  requireCase(
    expected.some((record, at) =>
      expected.some(
        (other, index) =>
          at !== index &&
          record.lineage !== other.lineage &&
          record.tableId === other.tableId &&
          record.sourceRowId === other.sourceRowId
      )
    )
  )
  const used = controller.options.workingAllocation.used
  let escaped: Brc38PrivateLocalCandidate | undefined
  await controller.interruptAfterCommittedChunk()
  let interrupted = false
  try {
    await controller.withSource(
      async source =>
        await Brc38PrivateLocalCandidate.with(controller.store, source, controller.options, async candidate => {
          escaped = candidate
          for (let step = 0; step < 1024; step++) {
            controller.check()
            if ((await candidate.copyPriorImportStep()).complete) break
          }
        })
    )
  } catch {
    interrupted = true
  }
  requireCase(interrupted && controller.options.workingAllocation.used === used)
  await controller.withSource(
    async source =>
      await Brc38PrivateLocalCandidate.with(controller.store, source, controller.options, async candidate => {
        let complete = false
        for (let step = 0; step < 1024 && !complete; step++) {
          controller.check()
          complete = (await candidate.copyPriorImportStep()).complete
        }
        requireCase(complete)
        const inventory = await candidate.inspectPriorImports()
        requireCase(inventory.records === expected.length && (await candidate.copyPriorImportStep()).complete)
      })
  )
  const actual = await controller.readPriorRecords()
  requireCase(actual.length === expected.length && controller.options.workingAllocation.used === used)
  for (const record of expected) {
    const values = actual.filter(
      value =>
        value.lineage === record.lineage && value.tableId === record.tableId && value.sourceRowId === record.sourceRowId
    )
    requireCase(
      values.length === 1 &&
        Object.keys(values[0].metadata).length === Object.keys(record.metadata).length &&
        Object.keys(record.metadata).every(name => equal(values[0].metadata[name], record.metadata[name])) &&
        equal(values[0].field, record.field)
    )
  }
  if (escaped !== undefined) {
    let refused = false
    try {
      await escaped.copyPriorImportStep()
    } catch {
      refused = true
    }
    requireCase(refused)
  }
}
