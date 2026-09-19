import type { Db } from 'mongodb'
import type { AdmissionCommit, AdmissionReceipt } from '../../storage/AdmissionStorage.js'
import { admissionReceiptFor } from '../../storage/mongo/MongoAdmissionPlan.js'
import { MongoAdmissionStorage } from '../../storage/mongo/MongoAdmissionStorage.js'
import type { MongoTransactionRunner } from '../../storage/mongo/MongoTransactionRunner.js'
import { admissionPlan } from '../admission/AdmissionStorageContract.js'
import { referenceScope } from '../admission/ReferenceAdmissionStorage.js'

// These tests exercise MongoAdmissionStorage's own orchestration logic --
// write-conflict retry exhaustion, the pending-wait poll loop, and its
// classification of thrown errors -- entirely through the injected
// MongoTransactionRunner seam, with no real MongoDB required. Deep
// applyPlan()-internal behavior (the transaction body itself) is covered
// separately against a real replica set in MongoAdmissionStorage.test.ts.

const dummyDb = { collection: () => ({}) } as unknown as Db

const clone = <T>(value: T): T => structuredClone(value)

function plan(): AdmissionCommit {
  const next = clone(admissionPlan('orchestration'))
  next.decisions[0].reads = []
  return next
}

function receiptFor(value: AdmissionCommit): AdmissionReceipt {
  return admissionReceiptFor(value, [])
}

function runner(
  overrides: Partial<Pick<MongoTransactionRunner, 'reconcile' | 'run'>> = {}
): MongoTransactionRunner {
  return {
    reconcile:
      overrides.reconcile ?? (async () => ({ state: 'pending' as const, attemptId: 'unlocated' })),
    run:
      overrides.run ??
      (async () => ({
        state: 'committed' as const,
        receipt: receiptFor(plan())
      })),
    close: async () => {}
  } as unknown as MongoTransactionRunner
}

function storage(overrides: ConstructorParameters<typeof MongoAdmissionStorage>[2] = {}) {
  return new MongoAdmissionStorage(dummyDb, referenceScope, {
    runner: runner(),
    readGuards: { initialize: async () => {} } as never,
    ...overrides
  })
}

describe('MongoAdmissionStorage write-conflict retry exhaustion and pending-wait', () => {
  test('exhausting every write-conflict retry attempt surfaces the last raw conflict rather than looping forever', async () => {
    const conflict = { code: 112, message: 'transient' }
    const run = jest.fn(async () => {
      throw conflict
    })
    // The retry loop's own bound (attempt < 8, continuing only while
    // attempt < 7) guarantees it always returns/throws by the 8th attempt,
    // so the last attempt's write conflict -- not classified into any typed
    // rejection code by asResult, since it is not an Error instance --
    // propagates as a rejection of commitAdmission itself.
    await expect(storage({ runner: runner({ run }) }).commitAdmission(plan())).rejects.toBe(
      conflict
    )
    expect(run).toHaveBeenCalledTimes(8)
  })

  test('a stuck pending attempt exhausts its 50-poll wait and commitAdmission then submits a fresh attempt', async () => {
    const reconcile = jest.fn(async () => ({
      state: 'pending' as const,
      attemptId: 'stuck-forever'
    }))
    const run = jest.fn(async () => ({ state: 'committed' as const, receipt: receiptFor(plan()) }))
    // The pre-existing attempt never resolves to committed/rejected/aborted
    // across all 50 polls (waitForPending's own timeout, ~1s of 20ms
    // delays), so commitAdmission falls through and submits a brand-new
    // attempt via the write-conflict retry path instead of hanging forever.
    const result = await storage({ runner: runner({ reconcile, run }) }).commitAdmission(plan())
    expect(result).toEqual({ state: 'committed', receipt: receiptFor(plan()) })
    // The initial reconcile at commit entry, plus 50 polls inside waitForPending.
    expect(reconcile).toHaveBeenCalledTimes(51)
    expect(run).toHaveBeenCalledTimes(1)
  }, 10000)

  test('a non-Mongo, non-object rejection from the transaction body is neither retried nor swallowed', async () => {
    const run = jest
      .fn()
      .mockRejectedValueOnce('disk exploded')
      .mockResolvedValue({
        state: 'committed' as const,
        receipt: receiptFor(plan())
      })
    await expect(storage({ runner: runner({ run }) }).commitAdmission(plan())).rejects.toBe(
      'disk exploded'
    )
    // A bare string is not classified as a write conflict, so there is no retry.
    expect(run).toHaveBeenCalledTimes(1)

    const runNull = jest.fn(async () => {
      // eslint-disable-next-line no-throw-literal
      throw null
    })
    await expect(
      storage({ runner: runner({ run: runNull }) }).commitAdmission(plan())
    ).rejects.toBe(null)
    expect(runNull).toHaveBeenCalledTimes(1)
  })
})
