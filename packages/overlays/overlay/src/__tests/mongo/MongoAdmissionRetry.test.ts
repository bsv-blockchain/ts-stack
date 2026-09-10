import type { Db } from 'mongodb'
import {
  admissionSemanticDigest,
  asStorageUint64,
  type AdmissionCommit,
  type AdmissionReceipt
} from '../../storage/AdmissionStorage.js'
import { MongoReadGuardConflictError } from '../../storage/mongo/MongoReadGuards.js'
import {
  AdmissionRejectedError,
  admissionReceiptFor
} from '../../storage/mongo/MongoAdmissionPlan.js'
import { MongoAdmissionStorage } from '../../storage/mongo/MongoAdmissionStorage.js'
import { MongoOverlayStorage } from '../../storage/mongo/MongoOverlayStorage.js'
import type { MongoTransactionRunner } from '../../storage/mongo/MongoTransactionRunner.js'
import { encodeMongoUint64 } from '../../storage/mongo/MongoSchema.js'
import { admissionPlan } from '../admission/AdmissionStorageContract.js'
import { referenceScope } from '../admission/ReferenceAdmissionStorage.js'

const dummyDb = { collection: () => ({}) } as unknown as Db

function cursorDb(score?: string): Db {
  return {
    collection: () => ({
      findOne: async () => (score === undefined ? null : { score })
    })
  } as unknown as Db
}

const clone = <T>(value: T): T => structuredClone(value)

function plan(): AdmissionCommit {
  const next = clone(admissionPlan('retry'))
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

describe('Mongo admission commit guards and write-conflict retry', () => {
  test('constructor rejects invalid and duplicate enlisted indexes', () => {
    expect(
      () =>
        new MongoAdmissionStorage(dummyDb, referenceScope, {
          enlistedIndexes: [
            { protocol: 'other' as 'overlay-mongo-index-v1', target: 'ls', apply: async () => {} }
          ]
        })
    ).toThrow('Invalid enlisted Mongo lookup index')
    expect(
      () =>
        new MongoAdmissionStorage(dummyDb, referenceScope, {
          enlistedIndexes: [
            { protocol: 'overlay-mongo-index-v1', target: '', apply: async () => {} }
          ]
        })
    ).toThrow('Invalid enlisted Mongo lookup index')
    expect(
      () =>
        new MongoAdmissionStorage(dummyDb, referenceScope, {
          enlistedIndexes: [
            { protocol: 'overlay-mongo-index-v1', target: 'ls', apply: async () => {} },
            { protocol: 'overlay-mongo-index-v1', target: 'ls', apply: async () => {} }
          ]
        })
    ).toThrow('Duplicate enlisted Mongo lookup index target')
  })

  test('rejects digest mismatch and unsupported projectors before the body', async () => {
    const adapter = storage()
    const mismatched = plan()
    mismatched.key.semanticDigest = '00'.repeat(32)
    expect(await adapter.commitAdmission(mismatched)).toEqual({
      state: 'rejected',
      code: 'digest-mismatch'
    })
    const invalid = plan()
    invalid.identity.txid = 'not-a-hash'
    expect(await adapter.commitAdmission(invalid)).toEqual({
      state: 'rejected',
      code: 'digest-mismatch'
    })
    expect(
      await storage({ projector: { protocol: 'not-replay-safe' } }).commitAdmission(plan())
    ).toEqual({ state: 'rejected', code: 'unsupported-projection' })
    const historical = plan()
    historical.identity.mode = 'historical'
    historical.key.semanticDigest = admissionSemanticDigest(historical.identity)
    expect(await adapter.commitAdmission(historical)).toEqual({
      state: 'rejected',
      code: 'invalid-plan'
    })
    expect(
      await storage({
        enlistedIndexes: [
          {
            protocol: 'overlay-mongo-index-v1',
            target: 'ls_contract',
            apply: async () => {}
          }
        ]
      }).commitAdmission(plan())
    ).toEqual({ state: 'rejected', code: 'invalid-plan' })
  })

  test('returns an already committed or rejected reconcile without running the body', async () => {
    const committed: AdmissionReceipt = receiptFor(plan())
    const run = jest.fn()
    expect(
      await storage({
        runner: runner({
          reconcile: async () => ({ state: 'committed', receipt: committed }),
          run
        })
      }).commitAdmission(plan())
    ).toEqual({ state: 'committed', receipt: committed })
    expect(
      await storage({
        runner: runner({
          reconcile: async () => ({ state: 'rejected', code: 'spend-conflict' }),
          run
        })
      }).commitAdmission(plan())
    ).toEqual({ state: 'rejected', code: 'spend-conflict' })
    expect(run).not.toHaveBeenCalled()
  })

  test('retries Mongo write conflicts then commits', async () => {
    const value = plan()
    const committed = receiptFor(value)
    const run = jest
      .fn()
      .mockRejectedValueOnce({ code: 112, message: 'transient' })
      .mockRejectedValueOnce({ code: '112' })
      .mockRejectedValueOnce({ codeName: 'WriteConflict' })
      .mockRejectedValueOnce(new Error('Write conflict'))
      .mockRejectedValueOnce({ errmsg: 'Write conflict' })
      .mockResolvedValueOnce({ state: 'committed', receipt: committed })
    expect(await storage({ runner: runner({ run }) }).commitAdmission(value)).toEqual({
      state: 'committed',
      receipt: committed
    })
    expect(run).toHaveBeenCalledTimes(6)
  })

  test('maps typed body failures and rethrows unknown errors', async () => {
    expect(
      await storage({
        runner: runner({
          run: async () => {
            throw new AdmissionRejectedError('spend-conflict')
          }
        })
      }).commitAdmission(plan())
    ).toEqual({ state: 'rejected', code: 'spend-conflict' })
    expect(
      await storage({
        runner: runner({
          run: async () => {
            throw new MongoReadGuardConflictError({
              scope: referenceScope,
              key: 'selection',
              expectedVersion: '1'
            })
          }
        })
      }).commitAdmission(plan())
    ).toEqual({ state: 'rejected', code: 'read-conflict' })
    expect(
      await storage({
        runner: runner({
          run: async () => {
            throw new Error('Mongo payload is not ready for reference')
          }
        })
      }).commitAdmission(plan())
    ).toEqual({ state: 'rejected', code: 'payload-not-ready' })
    await expect(
      storage({
        runner: runner({
          run: async () => {
            throw new Error('disk full')
          }
        })
      }).commitAdmission(plan())
    ).rejects.toThrow('disk full')
  })

  test('waits for a pending attempt, including abort then a fresh body', async () => {
    const committed = receiptFor(plan())
    const reconcile = jest
      .fn()
      .mockResolvedValueOnce({ state: 'pending', attemptId: 'att-1' })
      .mockResolvedValueOnce({ state: 'committed', receipt: committed })
    expect(await storage({ runner: runner({ reconcile }) }).commitAdmission(plan())).toEqual({
      state: 'committed',
      receipt: committed
    })

    const run = jest.fn(async () => ({ state: 'committed' as const, receipt: committed }))
    const aborted = jest
      .fn()
      .mockResolvedValueOnce({ state: 'pending', attemptId: 'att-2' })
      .mockResolvedValueOnce({ state: 'aborted' })
    expect(
      await storage({ runner: runner({ reconcile: aborted, run }) }).commitAdmission(plan())
    ).toEqual({ state: 'committed', receipt: committed })
    expect(run).toHaveBeenCalledTimes(1)

    const fromRun = jest
      .fn()
      .mockResolvedValueOnce({ state: 'pending', attemptId: 'unlocated' })
      .mockResolvedValueOnce({ state: 'committed', receipt: committed })
    expect(
      await storage({
        runner: runner({
          reconcile: fromRun,
          run: async () => ({ state: 'pending', attemptId: 'body-1' })
        })
      }).commitAdmission(plan())
    ).toEqual({ state: 'committed', receipt: committed })
  })

  test('publishes history-update payloads before the write-conflict retry loop', async () => {
    const value = plan()
    value.decisions[0].historyUpdate = {
      nextTopicHistoryGeneration: '4',
      affectedFromHeight: '99',
      handoff: {
        expected: {
          scope: referenceScope,
          topic: 'tm_contract',
          peerId: 'peer-a',
          jobId: 'repair-a',
          leaseToken: '9',
          expiresAtMs: '100',
          chainEpoch: '7',
          topicHistoryGeneration: '3'
        },
        checkpoint: 'repair-checkpoint'
      }
    }
    const publish = jest.fn(async () => ({
      kind: 'outbox-data' as const,
      digest: 'aa'.repeat(32),
      byteLength: '1'
    }))
    const committed = receiptFor(value)
    expect(
      await storage({
        payloads: { publish } as never,
        runner: runner({
          run: async () => ({ state: 'committed', receipt: committed })
        })
      }).commitAdmission(value)
    ).toEqual({ state: 'committed', receipt: committed })
    expect(publish).toHaveBeenCalledTimes(1)
  })

  test('rejects an out-of-range outbox lease before touching storage', async () => {
    const adapter = storage()
    await expect(adapter.claimOutbox('lookup', 0)).rejects.toThrow('Invalid Mongo outbox lease')
    await expect(adapter.claimOutbox('lookup', 60_001)).rejects.toThrow(
      'Invalid Mongo outbox lease'
    )
    await expect(adapter.claimOutbox('propagation', 1.5)).rejects.toThrow(
      'Invalid Mongo outbox lease'
    )
  })
})

describe('Mongo overlay storage admission guards', () => {
  test('preserves safe GASP cursors and rejects unsafe persisted values', async () => {
    const maxSafe = BigInt(Number.MAX_SAFE_INTEGER)
    const getCursor = (score?: string): Promise<number> =>
      new MongoOverlayStorage(cursorDb(score), referenceScope).getLastInteraction(
        'peer.example',
        'tm_contract'
      )

    await expect(getCursor(encodeMongoUint64('42'))).resolves.toBe(42)
    await expect(getCursor()).resolves.toBe(0)
    await expect(getCursor(encodeMongoUint64(maxSafe.toString()))).resolves.toBe(
      Number.MAX_SAFE_INTEGER
    )
    await expect(getCursor(encodeMongoUint64((maxSafe + 1n).toString()))).rejects.toThrow(
      'Mongo GASP cursor exceeds a safe JavaScript integer'
    )
    await expect(getCursor(encodeMongoUint64((maxSafe + 3n).toString()))).rejects.toThrow(
      'Mongo GASP cursor exceeds a safe JavaScript integer'
    )
    // These specific values rounded down/up in the old Number-only decoder.
    await expect(getCursor(encodeMongoUint64('9007199254740993'))).rejects.toThrow(
      'Mongo GASP cursor exceeds a safe JavaScript integer'
    )
    await expect(getCursor(encodeMongoUint64('9007199254740995'))).rejects.toThrow(
      'Mongo GASP cursor exceeds a safe JavaScript integer'
    )
  })

  test('updateTransactionBEEF is intentionally unimplemented', async () => {
    const overlay = new MongoOverlayStorage(dummyDb, referenceScope)
    const txid = 'ab'.repeat(32)
    await expect(overlay.updateTransactionBEEF(txid, [])).rejects.toThrow(
      `Mongo overlay storage does not implement updateTransactionBEEF for ${txid}`
    )
    expect(overlay.enlistedIndexTargets()).toEqual([])
    await expect(
      overlay.publishAdmissionPayload({
        kind: 'not-a-kind' as 'locking-script',
        bytes: new Uint8Array([1])
      })
    ).rejects.toThrow('Invalid Mongo admission payload kind')
    expect(asStorageUint64('0')).toBe('0')
  })
})
