import fc from 'fast-check'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Brc38StagingAdmissionNode, type Brc38StagingReservation } from './Brc38StagingAdmissionNode'
import { resumeBinding, resumeLimits } from './Brc38ResumeFixture'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(
    MIN_PROPERTY_RUNS,
    Number(process.env.FAST_CHECK_NUM_RUNS ?? process.env.FC_NUM_RUNS ?? MIN_PROPERTY_RUNS)
  ),
  seed: Number(process.env.FAST_CHECK_SEED ?? process.env.FC_SEED ?? 3242026)
})

async function closeModel(
  root: Brc38StagingAdmissionNode,
  stores: readonly KnexBrc38StagingStore[],
  directory: string
): Promise<void> {
  const results = await Promise.allSettled(stores.map(store => store.close()))
  results.push(...(await Promise.allSettled([root.close()])))
  const failures = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
  if (failures.length !== 0) throw new AggregateError(failures, 'Native capacity model failed physical close')
  await fs.rm(directory, { recursive: true, force: true })
}

async function runModelCase(slots: number, attempts: readonly boolean[]): Promise<void> {
  const directory = await fs.mkdtemp(join(tmpdir(), 'brc38-capacity-property-'))
  const root = await Brc38StagingAdmissionNode.create(directory, {
    maximumImports: slots,
    maximumPhysicalBytes: 3145728 + 4194304 * slots,
    maximumLogicalBytes: 1048576 * slots
  })
  const reserved: Brc38StagingReservation[] = []
  const owned: KnexBrc38StagingStore[] = []
  try {
    for (const release of attempts) {
      if (reserved.length === slots)
        await expect(root.admit(resumeLimits(), resumeBinding())).rejects.toThrow('capacity is reserved')
      else {
        const next = await root.admit(resumeLimits(), resumeBinding())
        owned.push(next.store)
        reserved.push(next)
      }
      if (release && reserved.length > 0) {
        const first = reserved.at(0)
        if (first === undefined) throw new Error('Independent native model lost a reservation')
        await root.discard(first, new Error('generated model release'))
        reserved.shift()
      }
      expect(await root.usage()).toEqual({
        imports: reserved.length,
        physicalBytes: 3145728 + 4194304 * reserved.length,
        logicalBytes: 1048576 * reserved.length
      })
    }
  } finally {
    try {
      for (const value of reserved) await root.discard(value, new Error('property close'))
    } finally {
      await closeModel(root, owned, directory)
    }
  }
}
jest.setTimeout(180000)
test('300 native capacity schedules preserve independent reservation arithmetic and exact release', async () => {
  const active = new Set<Promise<void>>()
  let failed = false,
    firstCause: unknown
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 3 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 4 }),
        (slots, attempts) => {
          const work = runModelCase(slots, attempts)
          active.add(work)
          void work.then(
            () => active.delete(work),
            () => active.delete(work)
          )
          return work
        }
      ),
      {
        numRuns: Math.max(300, Number(process.env.FAST_CHECK_NUM_RUNS ?? process.env.FC_NUM_RUNS ?? 300)),
        seed: Number(process.env.FAST_CHECK_SEED ?? process.env.FC_SEED ?? 3242026),
        path: process.env.FAST_CHECK_PATH ?? process.env.FC_PATH ?? '',
        interruptAfterTimeLimit: 150000,
        markInterruptAsFailure: true
      }
    )
  } catch (cause) {
    failed = true
    firstCause = cause
  }
  // fast-check can report interruption before its active async callback settles.
  // Drain that exact owned promise before Jest is permitted to tear down.
  const drained = await Promise.allSettled(active)
  const failures = drained.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
  if (failures.length !== 0)
    throw new AggregateError(
      [...(failed ? [firstCause] : []), ...failures],
      'Native capacity property and physical drain failed'
    )
  if (failed) throw firstCause
})
