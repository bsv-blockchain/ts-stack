import { jest } from '@jest/globals'
import type { RootEvictionCommitGuard } from '../src/root-eviction/RootEvictionCommitContext.js'
import {
  RootEvictionScheduler,
  type RootEvictionSchedulerOptions,
  type RootEvictionAutomaticEvaluation
} from '../src/root-eviction/RootEvictionScheduler.js'
import { SQLiteRootEvictionMaintenance } from '../src/root-eviction/SQLiteRootEvictionMaintenance.js'
import {
  coordinatedFixture,
  coordinatedRequest,
  contractSelection
} from './root-eviction-coordination-fixture.js'
import { policy, requester, signed } from './root-eviction-fixture.js'

export async function schedulerFixture() {
  const f = await coordinatedFixture()
  const state = { now: '150', context: true, access: true, policy }
  const maintenance = SQLiteRootEvictionMaintenance.open(f.path, f.configuration)
  const guard: jest.Mock<() => Promise<RootEvictionCommitGuard>> = jest.fn(async () => ({
    expectedPolicyDigest: state.policy,
    clock: () => state.now,
    authorize: () => state.access,
    contextCurrent: () => state.context
  }))
  const evaluate: jest.Mock<RootEvictionAutomaticEvaluation['evaluate']> = jest.fn(async observed =>
    observed.value.result.outcomes.flatMap((outcome, index) =>
      outcome.actionStatus === 'pending'
        ? [
            {
              index,
              disposition: 'reject' as const,
              reasonCode: 'installed-review',
              eligible: false
            }
          ]
        : []
    )
  )
  const automatic: RootEvictionAutomaticEvaluation = {
    policyId: 'urn:test:review:1',
    policyDigest: policy,
    journal: f.store,
    contracts: f.contracts,
    guard,
    evaluate
  }
  const options: RootEvictionSchedulerOptions = {
    maintenance,
    maintenanceGuard: { clock: () => state.now, authorize: () => true },
    automatic,
    maximum: 1
  }
  const workers: RootEvictionScheduler[] = []
  return {
    ...f,
    state,
    maintenance,
    automatic,
    guard,
    evaluate,
    options,
    worker(overrides: Partial<RootEvictionSchedulerOptions> = {}) {
      const worker = new RootEvictionScheduler({ ...options, ...overrides })
      workers.push(worker)
      return worker
    },
    async retain(id = 'scheduler_request_one') {
      const body = coordinatedRequest(id)
      return await f.store.retainCoordinated(
        signed(body),
        requester,
        contractSelection(),
        f.contracts,
        await guard()
      )
    },
    async cleanup() {
      await Promise.all(workers.map(worker => worker.stop()))
      await maintenance.close()
      await f.cleanup()
    }
  }
}
