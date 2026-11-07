import fc from 'fast-check'
import { fixture, retained, topic } from './ProposalAdmissionFixture.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

test('recovery projects only the selected topic and is independent of newer reservation and index observations', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.nat({ max: 1000000 }),
      fc.boolean(),
      fc.array(fc.nat({ max: 1000 }), { maxLength: 20 }),
      async (id, visible, privateIndices) => {
        const f = fixture()
        const original = retained()
        const steak = JSON.parse(original.receipt.steak)
        steak.tm_private.outputsToAdmit = privateIndices
        original.receipt.steak = JSON.stringify(steak)
        f.read.mockResolvedValue({ state: 'committed', admission: original })
        const first = await f.bridge.recover(f.job, f.proposal, f.selection, f.context)
        original.receipt.indexes[0].state = visible ? 'visible' : 'pending'
        const second = await f.bridge.recover(
          { ...f.job, operationId: `proposal-retry-${id}` },
          f.proposal,
          f.selection,
          { ...f.context, id: `later-${id}` }
        )
        expect(second).toEqual({ ...first, operationId: `proposal-retry-${id}` })
        expect(first.status).toBe('admitted')
        if (first.status === 'admitted') expect(Object.keys(first.steak)).toEqual([topic])
        expect(f.submit).not.toHaveBeenCalled()
      }
    )
  )
}, 30000)
