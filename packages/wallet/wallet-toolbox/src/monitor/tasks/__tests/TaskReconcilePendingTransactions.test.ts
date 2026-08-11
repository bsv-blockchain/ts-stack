import { Utils } from '@bsv/sdk'
import { TaskReconcilePendingTransactions } from '../TaskReconcilePendingTransactions'

function makeReq(status = 'unmined', updatedAt = new Date('2026-08-11T10:00:00.000Z')): any {
  const sourceTxid = '11'.repeat(32)
  const rawTx = `0100000001${sourceTxid}0000000000ffffffff0101000000000000000000000000`
  return {
    provenTxReqId: 1,
    created_at: updatedAt,
    updated_at: updatedAt,
    txid: '22'.repeat(32),
    rawTx: Utils.toArray(rawTx, 'hex'),
    status,
    history: '{}',
    notify: JSON.stringify({ transactionIds: [7] }),
    attempts: 0,
    notified: false
  }
}

function makeMonitor(reqs: any[], statusResult: any) {
  const sourceTxid = '11'.repeat(32)
  const current = new Map(reqs.map(req => [req.provenTxReqId, { ...req }]))
  const updateProvenTxReqDynamics = jest.fn(async (id: number, update: any) => {
    Object.assign(current.get(id), update)
    return 1
  })
  const sp = {
    isStorageProvider: jest.fn().mockReturnValue(true),
    findMonitorEvents: jest.fn().mockResolvedValue([]),
    findProvenTxReqs: jest.fn(async ({ partial }: any) => {
      const req = current.get(partial.provenTxReqId)
      return req == null ? [] : [req]
    }),
    updateProvenTxReqDynamics,
    updateTransactionsStatus: jest.fn().mockResolvedValue(undefined),
    updateOutput: jest.fn().mockResolvedValue(1),
    findTransactions: jest.fn().mockResolvedValue([{ transactionId: 7, userId: 9, txid: reqs[0]?.txid }]),
    findOutputsByOutpoints: jest.fn().mockResolvedValue({
      [`${sourceTxid}.0`]: {
        outputId: 10,
        userId: 9,
        transactionId: 6,
        txid: sourceTxid,
        vout: 0,
        satoshis: 100,
        spendable: true
      }
    }),
    transaction: jest.fn(async (scope: (trx: object) => Promise<void>) => await scope({ kind: 'trx' }))
  }
  const findProvenTxReqs = jest.fn(async ({ paged }: any) => reqs.slice(paged.offset, paged.offset + paged.limit))
  const storage = {
    findProvenTxReqs,
    runAsStorageProvider: jest.fn(async (scope: (provider: any) => Promise<any>) => await scope(sp))
  }
  return {
    monitor: {
      storage,
      services: {
        getStatusForTxids: jest.fn().mockResolvedValue(statusResult)
      },
      callOnTransactionStatusChanged: jest.fn()
    },
    current,
    findProvenTxReqs,
    sp
  }
}

describe('TaskReconcilePendingTransactions', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-08-11T12:00:00.000Z').getTime())
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('proactively fails an aged orphan-mempool loser and quarantines its local inputs', async () => {
    const req = makeReq()
    const harness = makeMonitor([req], {
      name: 'arcade',
      status: 'success',
      results: [
        {
          txid: req.txid,
          status: 'unknown',
          depth: undefined,
          terminal: true,
          inputConflict: true,
          providerStatus: 'SEEN_IN_ORPHAN_MEMPOOL',
          competingTxs: ['33'.repeat(32)]
        }
      ]
    })
    const task = new TaskReconcilePendingTransactions(harness.monitor as any, 0, 100, 60, 1)

    const log = await task.runTask()

    expect(harness.current.get(1).status).toBe('doubleSpend')
    expect(harness.sp.updateTransactionsStatus).toHaveBeenCalledWith([7], 'failed', { kind: 'trx' })
    expect(harness.sp.updateOutput).toHaveBeenCalledWith(10, { spendable: false }, { kind: 'trx' })
    expect(harness.monitor.callOnTransactionStatusChanged).toHaveBeenCalledWith(req.txid, 'SEEN_IN_ORPHAN_MEMPOOL')
    expect(log).toContain('"reconciled":1')
    expect(log).toContain('SEEN_IN_ORPHAN_MEMPOOL => doubleSpend')
  })

  test('does not mutate on clean unknown or provider failure', async () => {
    const req = makeReq()
    const harness = makeMonitor([req], {
      name: 'arcade',
      status: 'success',
      results: [{ txid: req.txid, status: 'unknown', depth: undefined }]
    })
    const task = new TaskReconcilePendingTransactions(harness.monitor as any, 0, 100, 60, 1)

    const log = await task.runTask()

    expect(harness.sp.updateProvenTxReqDynamics).not.toHaveBeenCalled()
    expect(harness.sp.updateTransactionsStatus).not.toHaveBeenCalled()
    expect(harness.sp.updateOutput).not.toHaveBeenCalled()
    expect(log).toContain('"reconciled":0')
  })

  test('definitive non-conflict rejection fails the action without quarantining live inputs', async () => {
    const req = makeReq()
    const harness = makeMonitor([req], {
      name: 'arcade',
      status: 'success',
      results: [
        {
          txid: req.txid,
          status: 'unknown',
          depth: undefined,
          terminal: true,
          inputConflict: false,
          providerStatus: 'MALFORMED'
        }
      ]
    })
    const task = new TaskReconcilePendingTransactions(harness.monitor as any, 0, 100, 60, 1)

    await task.runTask()

    expect(harness.current.get(1).status).toBe('invalid')
    expect(harness.sp.updateTransactionsStatus).toHaveBeenCalledWith([7], 'failed', { kind: 'trx' })
    expect(harness.sp.updateOutput).not.toHaveBeenCalled()
  })

  test('re-reads under lock and leaves a request that completed during polling unchanged', async () => {
    const req = makeReq()
    const harness = makeMonitor([req], {
      name: 'arcade',
      status: 'success',
      results: [
        {
          txid: req.txid,
          status: 'unknown',
          depth: undefined,
          terminal: true,
          inputConflict: true,
          providerStatus: 'DOUBLE_SPEND_ATTEMPTED'
        }
      ]
    })
    harness.current.get(1).status = 'completed'
    const task = new TaskReconcilePendingTransactions(harness.monitor as any, 0, 100, 60, 1)

    await task.runTask()

    expect(harness.current.get(1).status).toBe('completed')
    expect(harness.sp.updateTransactionsStatus).not.toHaveBeenCalled()
    expect(harness.sp.updateOutput).not.toHaveBeenCalled()
  })
})
