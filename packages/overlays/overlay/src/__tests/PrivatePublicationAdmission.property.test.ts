import fc from 'fast-check'
import { Utils, outputPrivatePublicationRequestDigest } from '@bsv/sdk'
import { privateAdmissionFixture } from './PrivatePublicationAdmissionFixture.js'
import { topic } from './ProposalAdmissionFixture.js'
import { admissionSemanticDigest } from '../storage/AdmissionStorage.js'
import { overlayAdmissionContextDigest } from '../EngineAdmission.js'

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

test('retained output membership, context and assessment survive retries without re-admission or other-topic disclosure', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uint8Array({ maxLength: 64 }),
      fc.boolean(),
      fc.nat({ max: 1000000 }),
      async (bytes, included, operation) => {
        const f = privateAdmissionFixture()
        f.job.request.privateValues = Utils.toBase64(Array.from(bytes))
        f.job.requestDigest = outputPrivatePublicationRequestDigest(f.job.request)
        f.context.requestDigest = f.job.requestDigest
        const admission = f.original()
        admission.identity.contextDigest = overlayAdmissionContextDigest(Array.from(bytes))
        admission.receipt.semanticDigest = admissionSemanticDigest(admission.identity)
        const complete = JSON.parse(admission.receipt.steak)
        complete[topic].outputsToAdmit = included ? [0] : []
        admission.receipt.steak = JSON.stringify(complete)
        f.read.mockResolvedValue({ state: 'committed', admission })
        const first = await f.run()
        const operationId = operation.toString(16).padStart(64, '0')
        const second = await f.bridge.recover({ ...f.job, operationId }, f.selection, f.context)
        expect(first.status).toBe(included ? 'admitted' : 'excluded')
        expect(second).toEqual({ ...first, operationId })
        if (first.status === 'unresolved') throw new Error('Expected retained admission')
        expect(first.context).toBe('matching-private-values')
        expect(Object.keys(first.steak)).toEqual([topic])
        expect(
          f.read.mock.calls.every(
            ([query]) => query.contextDigest === admission.identity.contextDigest
          )
        ).toBe(true)
        expect(f.submit).not.toHaveBeenCalled()
      }
    )
  )
}, 30000)
