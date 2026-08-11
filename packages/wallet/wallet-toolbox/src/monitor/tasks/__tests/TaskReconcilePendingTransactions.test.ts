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

  test('honors the quick trigger interval and disables a zero interval', () => {
    const harness = makeMonitor([], { name: 'arcade', status: 'success', results: [] })
    const task = new TaskReconcilePendingTransactions(harness.monitor as any, 1_000, 100, 60, 50)

    expect(task.trigger(49)).toEqual({ run: false })
    expect(task.trigger(51)).toEqual({ run: true })
    task.triggerNextMsecs = 0
    expect(task.trigger(1_000)).toEqual({ run: false })
  })

  test('resumes after the checkpointed request and advances a fully reconciled page', async () => {
    const first = makeReq()
    const second = { ...makeReq(), provenTxReqId: 2, txid: '44'.repeat(32) }
    const harness = makeMonitor([first, second], {
      name: 'arcade',
      status: 'success',
      results: [
        {
          txid: second.txid,
          status: 'unknown',
          terminal: true,
          inputConflict: false
        }
      ]
    })
    harness.sp.findMonitorEvents.mockResolvedValue([
      {
        details: JSON.stringify({ resumeOffset: 0, expectedProvenTxReqId: first.provenTxReqId })
      }
    ])
    const task = new TaskReconcilePendingTransactions(harness.monitor as any, 1_000, 1, 60, 50)

    const result = JSON.parse(await task.runTask())

    expect(harness.findProvenTxReqs).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ paged: { limit: 1, offset: 0 } })
    )
    expect(harness.findProvenTxReqs).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ paged: { limit: 1, offset: 1 } })
    )
    expect(result).toMatchObject({ reconciled: 1, retained: 0, cycleComplete: false, resumeOffset: 1 })
    expect(task.triggerNextMsecs).toBe(50)
    expect(harness.monitor.callOnTransactionStatusChanged).toHaveBeenCalledWith(second.txid, 'REJECTED')
  })

  test('restarts a moved checkpoint and retains the page with an expected request id', async () => {
    const first = makeReq()
    const second = { ...makeReq(), provenTxReqId: 2, txid: '44'.repeat(32) }
    const harness = makeMonitor([first, second], {
      name: 'arcade',
      status: 'error',
      results: []
    })
    harness.sp.findMonitorEvents.mockResolvedValue([
      {
        details: JSON.stringify({ resumeOffset: 1, expectedProvenTxReqId: 999 })
      }
    ])
    const task = new TaskReconcilePendingTransactions(harness.monitor as any, 1_000, 1, 60, 50)

    const result = JSON.parse(await task.runTask())

    expect(harness.findProvenTxReqs).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ paged: { limit: 1, offset: 0 } })
    )
    expect(result).toMatchObject({ reconciled: 0, retained: 1, resumeOffset: 0, expectedProvenTxReqId: 1 })
  })

  test('ignores unusable checkpoints and stops at the latest completed cycle', async () => {
    const req = makeReq()
    const harness = makeMonitor([req], { name: 'arcade', status: 'success', results: [] })
    harness.sp.findMonitorEvents.mockResolvedValue([
      {},
      { details: '{not-json' },
      { details: JSON.stringify({ reviewed: 1 }) },
      { details: JSON.stringify({ cycleComplete: true, resumeOffset: 50 }) }
    ])
    const task = new TaskReconcilePendingTransactions(harness.monitor as any, 1_000, 100, 60, 50)

    await task.runTask()

    expect(harness.findProvenTxReqs).toHaveBeenCalledWith(
      expect.objectContaining({ paged: { limit: 100, offset: 0 } })
    )
  })

  test('skips provider polling for a fresh request and uses the normal interval after a short page', async () => {
    const req = makeReq('unmined', new Date('2026-08-11T11:30:01.000Z'))
    const harness = makeMonitor([req], { name: 'arcade', status: 'success', results: [] })
    const task = new TaskReconcilePendingTransactions(harness.monitor as any, 1_000, 2, 60, 50)

    const result = JSON.parse(await task.runTask())

    expect(harness.monitor.services.getStatusForTxids).not.toHaveBeenCalled()
    expect(result).toMatchObject({ reviewed: 0, reconciled: 0, retained: 1, cycleComplete: true })
    expect(task.triggerNextMsecs).toBe(1_000)
  })

  test('handles a terminal verdict with no notified transactions or stale local inputs', async () => {
    const req = { ...makeReq(), notify: JSON.stringify({}) }
    const harness = makeMonitor([req], {
      name: 'arcade',
      status: 'success',
      results: [
        {
          txid: req.txid,
          status: 'unknown',
          terminal: true,
          inputConflict: true,
          providerStatus: 'DOUBLE_SPEND_ATTEMPTED',
          statusCode: 409,
          description: 'a competing transaction won'
        }
      ]
    })
    harness.sp.findOutputsByOutpoints.mockResolvedValue({})
    const task = new TaskReconcilePendingTransactions(harness.monitor as any, 0, 100, 60, 1)

    await task.runTask()

    expect(harness.sp.updateTransactionsStatus).not.toHaveBeenCalled()
    expect(harness.sp.updateOutput).not.toHaveBeenCalled()
    expect(harness.monitor.callOnTransactionStatusChanged).toHaveBeenCalledWith(req.txid, 'DOUBLE_SPEND_ATTEMPTED')
  })
})
