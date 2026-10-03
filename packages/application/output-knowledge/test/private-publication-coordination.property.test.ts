import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { PrivatePublicationCoordinator } from '../src/private/PrivatePublicationCoordinator.js'
import { coordinatorFixture } from './private-publication-coordinator-fixture.js'
import { allow } from './private-publication-fixture.js'

type Model = 'absent' | 'pending' | 'ready' | 'rejected'
const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  seed: Number.isSafeInteger(requestedSeed) ? requestedSeed : 3242026,
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true,
  ...(replayPath ? { path: replayPath } : {})
})

it('preserves one original publication through 300 native access, cancellation, expiry, lost-reply and restart schedules', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom('admitted', 'excluded', 'unresolved'),
      fc.boolean(),
      fc.array(
        fc.constantFrom(
          'publish',
          'resume',
          'status',
          'deny',
          'allow',
          'expire',
          'cancel',
          'restart'
        ),
        { minLength: 3, maxLength: 10 }
      ),
      async (decision, loseReply, schedule) => {
        const f = coordinatorFixture()
        let allowed = true,
          expired = false,
          lost = false,
          effectCount = 0
        let model: Model = 'absent'
        let operation: string | undefined
        const admission = {
          ...f.admission,
          async recover(job: Parameters<typeof f.admission.recover>[0]) {
            if (operation !== undefined) expect(job.operationId).toBe(operation)
            else operation = job.operationId
            if (decision === 'unresolved')
              return {
                status: 'unresolved' as const,
                operationId: job.operationId,
                txid: job.request.evidence.txid
              }
            if (effectCount === 0) effectCount++
            if (loseReply && !lost) {
              lost = true
              throw new Error('Synthetic lost receipt')
            }
            return {
              status: decision as 'admitted' | 'excluded',
              operationId: job.operationId,
              txid: job.request.evidence.txid,
              steak: {
                [job.request.topic]: {
                  outputsToAdmit: decision === 'admitted' ? [0] : [],
                  coinsToRetain: [],
                  coinsRemoved: []
                }
              },
              assessmentContextId: 'stable-original-assessment',
              context: 'matching-private-values' as const
            }
          }
        }
        let store = f.store,
          coordinator = new PrivatePublicationCoordinator({ ...f.options, store, admission })
        try {
          // Always attempt initial publication, then vary recovery and current authority.
          for (const action of ['publish', ...schedule]) {
            if (action === 'deny') {
              allowed = false
              f.revokeAccess()
            } else if (action === 'allow') {
              allowed = true
              f.grantAccess()
            } else if (action === 'expire') {
              expired = true
              f.time('101')
            } else if (action === 'restart') {
              await coordinator.stop()
              store = f.reopen()
              coordinator = new PrivatePublicationCoordinator({ ...f.options, store, admission })
            } else {
              const before: Model = model,
                priorLost = lost
              let result: Awaited<ReturnType<PrivatePublicationCoordinator['status']>> | undefined,
                error: unknown
              const abort = new AbortController()
              if (action === 'cancel') abort.abort()
              try {
                result =
                  action === 'status'
                    ? await coordinator.status(f.status, f.caller)
                    : action === 'resume'
                      ? await coordinator.resume(f.status, f.caller)
                      : await coordinator.publish(f.contract.request, {
                          ...f.caller,
                          signal: abort.signal
                        })
              } catch (caught) {
                error = caught
              }
              if (
                action === 'cancel' ||
                !allowed ||
                (before === 'absent' && (expired || action !== 'publish'))
              ) {
                expect(error).toBeDefined()
                model = before
              } else if (action !== 'status' && (before === 'absent' || before === 'pending')) {
                if (decision === 'unresolved' || (loseReply && !priorLost)) model = 'pending'
                else model = decision === 'admitted' ? 'ready' : 'rejected'
                if (loseReply && !priorLost && decision !== 'unresolved')
                  expect(error).toBeDefined()
                else expect(error).toBeUndefined()
              } else expect(error).toBeUndefined()
              if (result) {
                expect(result.status).toBe(model)
                expect(JSON.stringify(result)).not.toContain('AQID')
              }
            }
            const retained = store.loadVerified(
              f.status.publicationId,
              () => (expired ? '101' : '20'),
              allow
            )
            if (model === 'absent') expect(retained).toBeUndefined()
            else {
              expect(retained).toBeDefined()
              expect(retained!.blob.privateValues).toBe(f.contract.request.privateValues)
              expect(retained!.original.capability).toEqual(f.contract.record.capability)
              expect(retained!.original.rawTransaction).toBe(f.contract.record.rawTransaction)
              expect(retained!.binding.phase).toBe(model === 'ready' ? 'active' : 'reserved')
              expect(retained!.fence.state.progress.phase).toBe(
                model === 'pending' ? 'admitting' : model === 'rejected' ? 'excluded' : 'ready'
              )
            }
            expect(effectCount).toBeLessThanOrEqual(1)
          }
        } finally {
          await coordinator.stop()
          f.cleanup()
        }
      }
    )
  )
}, 180000)
