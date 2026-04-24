import { TaskSendWaiting } from '../TaskSendWaiting'

function makeReq (provenTxReqId: number, txid: string, updatedAt: Date, batch?: string) {
  const now = new Date()
  return {
    provenTxReqId,
    created_at: now,
    updated_at: updatedAt,
    txid,
    batch,
    status: 'unsent',
    history: '{}',
    notify: '{}',
    attempts: 0,
    notified: false
  }
}

function makeMonitor (reqs: any[]) {
  const findProvenTxReqs = jest.fn(async ({ paged, partial, status }: any) => {
    let filtered = reqs
    if (partial?.batch) filtered = filtered.filter(req => req.batch === partial.batch)
    if (status) {
      const statuses = Array.isArray(status) ? status : [status]
      filtered = filtered.filter(req => statuses.includes(req.status))
    }
    if (paged) return filtered.slice(paged.offset, paged.offset + paged.limit)
    return filtered
  })

  return {
    monitor: {
      storage: {
        findProvenTxReqs
      }
    },
    findProvenTxReqs
  }
}

describe('TaskSendWaiting', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('0 uses the normal cadence after a partial waiting chunk and preserves storage order', async () => {
    const now = new Date('2026-01-01T12:00:00.000Z')
    jest.spyOn(Date, 'now').mockReturnValue(now.getTime())
    const reqs = [
      makeReq(1, 'tx1', new Date('2026-01-01T11:59:40.000Z')),
      makeReq(2, 'tx2', new Date('2026-01-01T11:59:50.000Z'))
    ]
    const m = makeMonitor(reqs)
    const task = new TaskSendWaiting(m.monitor as any, 80, 7_000, 300_000, 10, 5)
    jest.spyOn(task, 'processUnsent').mockResolvedValue('')

    await task.runTask()

    expect(m.findProvenTxReqs).toHaveBeenCalledWith({
      partial: {},
      status: ['unsent', 'sending'],
      paged: { limit: 5, offset: 0 }
    })
    expect(task.processUnsent).toHaveBeenCalledTimes(1)
    const processedReqs = (task.processUnsent as jest.Mock).mock.calls[0][0]
    expect(processedReqs.map((r: any) => r.txid)).toEqual(['tx1', 'tx2'])
    expect(task.triggerNextMsecs).toBe(80)
  })

  test('0a waits only until all fetched reqs reach the aged threshold when some are not ready yet', async () => {
    const now = new Date('2026-01-01T12:00:00.000Z')
    jest.spyOn(Date, 'now').mockReturnValue(now.getTime())
    const reqs = [
      makeReq(1, 'tx1', new Date('2026-01-01T11:59:40.000Z')),
      makeReq(2, 'tx2', new Date('2026-01-01T11:59:56.000Z'))
    ]
    const m = makeMonitor(reqs)
    const task = new TaskSendWaiting(m.monitor as any, 80, 7_000, 300_000, 10, 5)
    jest.spyOn(task, 'processUnsent').mockResolvedValue('')

    await task.runTask()

    expect(task.processUnsent).toHaveBeenCalledTimes(1)
    const processedReqs = (task.processUnsent as jest.Mock).mock.calls[0][0]
    expect(processedReqs.map((r: any) => r.txid)).toEqual(['tx1'])
    expect(task.triggerNextMsecs).toBe(3_000)
  })

  test('0aa gates a whole batch on its youngest req and fetches the full batch before sending', async () => {
    const now = new Date('2026-01-01T12:00:00.000Z')
    jest.spyOn(Date, 'now').mockReturnValue(now.getTime())
    const reqs = [
      makeReq(1, 'tx1', new Date('2026-01-01T11:59:40.000Z'), 'batch-1'),
      makeReq(2, 'tx2', new Date('2026-01-01T11:59:56.000Z'), 'batch-1'),
      makeReq(3, 'tx3', new Date('2026-01-01T11:59:40.000Z'))
    ]
    const m = makeMonitor(reqs)
    const task = new TaskSendWaiting(m.monitor as any, 80, 7_000, 300_000, 10, 4)
    jest.spyOn(task, 'processUnsent').mockResolvedValue('')

    await task.runTask()

    expect(m.findProvenTxReqs).toHaveBeenCalledWith({
      partial: { batch: 'batch-1' },
      status: ['unsent', 'sending']
    })
    const processedReqs = (task.processUnsent as jest.Mock).mock.calls[0][0]
    expect(processedReqs.map((r: any) => r.txid)).toEqual(['tx3'])
    expect(task.triggerNextMsecs).toBe(3_000)
  })

  test('0ab sends the full batch together once the youngest req is aged', async () => {
    const now = new Date('2026-01-01T12:00:00.000Z')
    jest.spyOn(Date, 'now').mockReturnValue(now.getTime())
    const reqs = [
      makeReq(1, 'tx1', new Date('2026-01-01T11:59:40.000Z'), 'batch-1'),
      makeReq(2, 'tx2', new Date('2026-01-01T11:59:50.000Z'), 'batch-1')
    ]
    const m = makeMonitor(reqs)
    const task = new TaskSendWaiting(m.monitor as any, 80, 7_000, 300_000, 10, 1)
    jest.spyOn(task, 'processUnsent').mockResolvedValue('')

    await task.runTask()

    const processedReqs = (task.processUnsent as jest.Mock).mock.calls[0][0]
    expect(processedReqs.map((r: any) => r.txid)).toEqual(['tx1', 'tx2'])
    expect(task.triggerNextMsecs).toBe(10)
  })

  test('0b switches to quick trigger cadence after consuming a full waiting chunk', async () => {
    const now = new Date('2026-01-01T12:00:00.000Z')
    jest.spyOn(Date, 'now').mockReturnValue(now.getTime())
    const reqs = Array.from({ length: 5 }, (_, i) => makeReq(i + 1, `tx${i + 1}`, new Date('2026-01-01T11:59:40.000Z')))
    const m = makeMonitor(reqs)
    const task = new TaskSendWaiting(m.monitor as any, 80, 7_000, 300_000, 10, 5)
    jest.spyOn(task, 'processUnsent').mockResolvedValue('')

    await task.runTask()

    expect(task.processUnsent).toHaveBeenCalledTimes(1)
    expect(task.triggerNextMsecs).toBe(10)
  })

  test('1 falls back to normal trigger cadence when there is no waiting work', async () => {
    const now = new Date('2026-01-01T12:00:00.000Z')
    jest.spyOn(Date, 'now').mockReturnValue(now.getTime())
    const m = makeMonitor([])
    const task = new TaskSendWaiting(m.monitor as any, 80, 7_000, 300_000, 10, 5)
    const processSpy = jest.spyOn(task, 'processUnsent').mockResolvedValue('')

    await task.runTask()

    expect(processSpy).not.toHaveBeenCalled()
    expect(task.triggerNextMsecs).toBe(80)
  })
})
