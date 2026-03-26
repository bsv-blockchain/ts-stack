import { TaskReviewDoubleSpends } from '../TaskReviewDoubleSpends'

function makeReq(provenTxReqId: number, txid: string, updatedAt: Date): any {
  const now = new Date()
  return {
    provenTxReqId,
    created_at: now,
    updated_at: updatedAt,
    txid,
    status: 'doubleSpend',
    history: '{}',
    notify: '{}',
    attempts: 0,
    notified: false
  }
}

function makeMonitor(
  statusByTxid: Record<string, string>,
  reqs: any[],
  monitorEvents: Array<{ details?: string }> = []
) {
  const updateProvenTxReq = jest.fn().mockResolvedValue(undefined)
  const findProvenTxReqs = jest.fn(async ({ paged }: any) => reqs.slice(paged.offset, paged.offset + paged.limit))
  const findMonitorEvents = jest.fn().mockResolvedValue(monitorEvents)
  const runAsStorageProvider = jest.fn(async (fn: any) => await fn({ updateProvenTxReq, findMonitorEvents }))
  const logEvent = jest.fn().mockResolvedValue(undefined)

  return {
    monitor: {
      storage: {
        findProvenTxReqs,
        runAsStorageProvider
      },
      services: {
        getStatusForTxids: jest.fn(async (txids: string[]) => ({
          results: txids.map(txid => ({ txid, status: statusByTxid[txid] ?? 'unknown' }))
        }))
      },
      logEvent
    },
    updateProvenTxReq,
    findProvenTxReqs,
    findMonitorEvents,
    runAsStorageProvider,
    logEvent
  }
}

describe('TaskReviewDoubleSpends', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('0 uses the normal cadence after a partial review chunk and stores checkpoint offset after unfails are removed', async () => {
    const now = new Date('2026-01-01T12:00:00.000Z')
    jest.spyOn(Date, 'now').mockReturnValue(now.getTime())
    const reqs = [
      makeReq(1, 'tx1', new Date('2026-01-01T10:30:00.000Z')),
      makeReq(2, 'tx2', new Date('2026-01-01T10:40:00.000Z'))
    ]
    const m = makeMonitor({ tx1: 'success', tx2: 'unknown' }, reqs)
    const task = new TaskReviewDoubleSpends(m.monitor as any, 0, 100, 60, 60)

    const log = await task.runTask()

    expect(m.findProvenTxReqs).toHaveBeenCalledWith({
      partial: { status: 'doubleSpend' },
      paged: { limit: 100, offset: 0 }
    })
    expect(m.updateProvenTxReq).toHaveBeenCalledWith([1], { status: 'unfail' })
    expect(m.logEvent).not.toHaveBeenCalled()
    expect(log).toContain('"reviewed":2')
    expect(log).toContain('"unfails":1')
    expect(log).toContain('"resumeOffset":0')
    expect(log).toContain('"expectedProvenTxReqId":2')
    expect(log).toContain('unfail 1 tx1 status:success')
    expect(task.triggerNextMsecs).toBe(0)
  })

  test('0a stores the retained req offset in the post-unfail doubleSpend list', async () => {
    const now = new Date('2026-01-01T12:00:00.000Z')
    jest.spyOn(Date, 'now').mockReturnValue(now.getTime())
    const reqs = [
      makeReq(1, 'tx1', new Date('2026-01-01T10:30:00.000Z')),
      makeReq(2, 'tx2', new Date('2026-01-01T10:35:00.000Z')),
      makeReq(3, 'tx3', new Date('2026-01-01T10:40:00.000Z'))
    ]
    const m = makeMonitor({ tx1: 'success', tx2: 'unknown', tx3: 'unknown' }, reqs)
    const task = new TaskReviewDoubleSpends(m.monitor as any, 0, 100, 60, 60)

    const log = await task.runTask()

    expect(m.updateProvenTxReq).toHaveBeenCalledWith([1], { status: 'unfail' })
    expect(log).toContain('"resumeOffset":1')
    expect(log).toContain('"expectedProvenTxReqId":3')
  })

  test('1 skips reqs newer than the minAgeMinutes cutoff and returns empty when nothing is eligible', async () => {
    const now = new Date('2026-01-01T12:00:00.000Z')
    jest.spyOn(Date, 'now').mockReturnValue(now.getTime())
    const reqs = [makeReq(1, 'tx1', new Date('2026-01-01T11:30:01.000Z'))]
    const m = makeMonitor({ tx1: 'unknown' }, reqs)
    const task = new TaskReviewDoubleSpends(m.monitor as any, 0, 100, 60, 60)

    const log = await task.runTask()

    expect(m.updateProvenTxReq).not.toHaveBeenCalled()
    expect(m.logEvent).not.toHaveBeenCalled()
    expect(log).toBe('')
    expect(task.triggerNextMsecs).toBe(0)
  })

  test('1b uses the quick cadence after consuming a full review chunk', async () => {
    const now = new Date('2026-01-01T12:00:00.000Z')
    jest.spyOn(Date, 'now').mockReturnValue(now.getTime())
    const reqs = [
      makeReq(1, 'tx1', new Date('2026-01-01T10:30:00.000Z')),
      makeReq(2, 'tx2', new Date('2026-01-01T10:40:00.000Z'))
    ]
    const m = makeMonitor({ tx1: 'success', tx2: 'unknown' }, reqs)
    const task = new TaskReviewDoubleSpends(m.monitor as any, 0, 2, 60, 60)

    await task.runTask()

    expect(task.triggerNextMsecs).toBe(60)
  })

  test('2 resumes from the checkpoint offset and advances it', async () => {
    const now = new Date('2026-01-01T12:00:00.000Z')
    jest.spyOn(Date, 'now').mockReturnValue(now.getTime())
    const reqs = [
      makeReq(1, 'tx1', new Date('2026-01-01T10:00:00.000Z')),
      makeReq(2, 'tx2', new Date('2026-01-01T10:05:00.000Z')),
      makeReq(3, 'tx3', new Date('2026-01-01T10:10:00.000Z'))
    ]
    const m = makeMonitor({ tx2: 'unknown', tx3: 'success' }, reqs, [
      { details: JSON.stringify({ resumeOffset: 1, expectedProvenTxReqId: 2 }) }
    ])
    const task = new TaskReviewDoubleSpends(m.monitor as any, 0, 2, 60)

    const log = await task.runTask()

    expect(m.findProvenTxReqs).toHaveBeenNthCalledWith(1, {
      partial: { status: 'doubleSpend' },
      paged: { limit: 1, offset: 1 }
    })
    expect(m.findProvenTxReqs).toHaveBeenNthCalledWith(2, {
      partial: { status: 'doubleSpend' },
      paged: { limit: 2, offset: 2 }
    })
    expect(m.updateProvenTxReq).toHaveBeenCalledWith([3], { status: 'unfail' })
    expect(log).toContain('"reviewed":1')
    expect(log).not.toContain('"resumeOffset"')
    expect(log).not.toContain('"expectedProvenTxReqId"')
  })

  test('3 restarts at offset zero when the checkpoint verification id no longer matches', async () => {
    const now = new Date('2026-01-01T12:00:00.000Z')
    jest.spyOn(Date, 'now').mockReturnValue(now.getTime())
    const reqs = [
      makeReq(10, 'tx10', new Date('2026-01-01T10:00:00.000Z')),
      makeReq(11, 'tx11', new Date('2026-01-01T10:05:00.000Z'))
    ]
    const m = makeMonitor({ tx10: 'unknown', tx11: 'success' }, reqs, [
      { details: JSON.stringify({ resumeOffset: 1, expectedProvenTxReqId: 99 }) }
    ])
    const task = new TaskReviewDoubleSpends(m.monitor as any, 0, 2, 60)

    const log = await task.runTask()

    expect(m.findProvenTxReqs).toHaveBeenNthCalledWith(1, {
      partial: { status: 'doubleSpend' },
      paged: { limit: 1, offset: 1 }
    })
    expect(m.findProvenTxReqs).toHaveBeenNthCalledWith(2, {
      partial: { status: 'doubleSpend' },
      paged: { limit: 2, offset: 0 }
    })
    expect(m.updateProvenTxReq).toHaveBeenCalledWith([11], { status: 'unfail' })
    expect(log).toContain('"resumeOffset":0')
    expect(log).toContain('"expectedProvenTxReqId":10')
  })
})
