import { TaskReorg } from '../TaskReorg'

function makeMonitor(options: {
  headersByHeight?: Record<number, { merkleRoot: string } | undefined>
  staleRootsByHeight?: Record<number, string[]>
}) {
  const findStaleMerkleRoots = jest.fn(
    async ({ height }: { height: number }) => options.staleRootsByHeight?.[height] ?? []
  )
  const reproveHeightMerkleRoot = jest.fn(async (height: number, staleRoot: string) => ({
    log: `  reproved ${height}:${staleRoot}\n`,
    updated: [{}],
    unchanged: [],
    unavailable: []
  }))
  const reproveHeader = jest.fn()
  const chaintracks = {
    findHeaderForHeight: jest.fn(async (height: number) => {
      const header = options.headersByHeight?.[height]
      return header === undefined ? undefined : { height, hash: `hash-${height}`, ...header }
    })
  }
  const events: Array<{ details: string }> = []
  const deactivatedHeaders: any[] = []
  const monitor = {
    logEvent: jest.fn(async (_event: string, details: string) => {
      events.unshift({ details })
    }),
    storage: {
      runAsStorageProvider: jest.fn(
        async (fn: any) => await fn({ findStaleMerkleRoots, findMonitorEvents: async () => events.slice(0, 5) })
      ),
      reproveHeightMerkleRoot,
      reproveHeader
    },
    chaintracks,
    chaintracksWithEvents: undefined,
    deactivatedHeaders,
    shiftDeactivatedHeader: jest.fn(() => deactivatedHeaders.shift()),
    enqueueDeactivatedHeader: jest.fn(header => deactivatedHeaders.push(header)),
    lastNewHeader: undefined as { height: number; hash: string } | undefined
  }
  return { monitor, chaintracks, findStaleMerkleRoots, reproveHeightMerkleRoot, reproveHeader }
}

const roots = (from: number, to: number): Record<number, { merkleRoot: string }> => {
  const r: Record<number, { merkleRoot: string }> = {}
  for (let h = from; h <= to; h++) r[h] = { merkleRoot: `root-${h}` }
  return r
}

describe('TaskReorg recent-height review', () => {
  test('0 runs once per processed new block header, and not before one', async () => {
    const m = makeMonitor({ headersByHeight: roots(0, 200) })
    const task = new TaskReorg(m.monitor as any, 0, 3, 4)

    expect(task.trigger(Date.now()).run).toBe(false)

    m.monitor.lastNewHeader = { height: 100, hash: 'tip-100' }
    expect(task.trigger(Date.now()).run).toBe(true)
    expect(await task.runTask()).toBe('')
    expect(m.chaintracks.findHeaderForHeight.mock.calls.map(c => c[0])).toEqual([97, 98, 99, 100])
    expect(task.trigger(Date.now()).run).toBe(false)

    // A replacement header at the same height is a new block and is reviewed again.
    m.monitor.lastNewHeader = { height: 100, hash: 'tip-100-replaced' }
    expect(task.trigger(Date.now()).run).toBe(true)
  })

  test('1 reproves only the stale roots of recent heights and logs them', async () => {
    const m = makeMonitor({
      headersByHeight: { ...roots(97, 100), 99: { merkleRoot: 'root-99-canonical' } },
      staleRootsByHeight: { 99: ['root-99-orphaned'] }
    })
    const task = new TaskReorg(m.monitor as any, 0, 3, 4)
    m.monitor.lastNewHeader = { height: 100, hash: 'tip-100' }

    const log = await task.runTask()

    expect(m.findStaleMerkleRoots).toHaveBeenCalledWith({ height: 99, merkleRoot: 'root-99-canonical' })
    expect(m.reproveHeightMerkleRoot).toHaveBeenCalledTimes(1)
    expect(m.reproveHeightMerkleRoot).toHaveBeenCalledWith(99, 'root-99-orphaned')
    expect(m.reproveHeader).not.toHaveBeenCalled()
    expect(log).toContain('reviewing recent heights 97..100')
    expect(log).toContain('height 99 canonical root-99-canonical stale root-99-orphaned')
  })

  test('2 the window is clamped at height zero', async () => {
    const m = makeMonitor({ headersByHeight: roots(0, 2) })
    const task = new TaskReorg(m.monitor as any, 0, 3, 12)
    m.monitor.lastNewHeader = { height: 2, hash: 'tip-2' }

    await task.runTask()

    expect(m.chaintracks.findHeaderForHeight.mock.calls.map(c => c[0])).toEqual([0, 1, 2])
  })

  test('3 recentDepth zero disables the review', async () => {
    const m = makeMonitor({ headersByHeight: roots(0, 200) })
    const task = new TaskReorg(m.monitor as any, 0, 3, 0)
    m.monitor.lastNewHeader = { height: 100, hash: 'tip-100' }

    expect(task.trigger(Date.now()).run).toBe(false)
    expect(await task.runTask()).toBe('')
    expect(m.chaintracks.findHeaderForHeight).not.toHaveBeenCalled()
  })

  test('4 a failed review retries after one minute even without a new block', async () => {
    const m = makeMonitor({ headersByHeight: roots(0, 200) })
    m.chaintracks.findHeaderForHeight.mockRejectedValueOnce(new Error('chaintracks unavailable'))
    const task = new TaskReorg(m.monitor as any, 0, 3, 4)
    m.monitor.lastNewHeader = { height: 100, hash: 'tip-100' }

    expect(await task.runTask()).toContain('review unavailable')
    expect(m.chaintracks.findHeaderForHeight).toHaveBeenCalledTimes(1)
    expect(m.monitor.logEvent).toHaveBeenLastCalledWith('ReorgRecovery', expect.stringContaining('[[97,100]]'))
    expect(task.trigger(Date.now()).run).toBe(false)
    expect(task.trigger(Date.now() + 60_000).run).toBe(true)

    m.monitor.lastNewHeader = { height: 101, hash: 'tip-101' }
    expect(task.trigger(Date.now()).run).toBe(true)
  })

  test('5 unavailable canonical headers are logged', async () => {
    const m = makeMonitor({ headersByHeight: { 99: { merkleRoot: 'root-99' }, 100: undefined } })
    const task = new TaskReorg(m.monitor as any, 0, 3, 2)
    m.monitor.lastNewHeader = { height: 100, hash: 'tip-100' }

    const log = await task.runTask()

    expect(log).toContain('height 100 canonical header unavailable')
    expect(m.reproveHeightMerkleRoot).not.toHaveBeenCalled()
  })

  test('6 persists unresolved heights across task restart and recent-window aging', async () => {
    const m = makeMonitor({ headersByHeight: roots(0, 200), staleRootsByHeight: { 99: ['old'] } })
    m.reproveHeightMerkleRoot.mockResolvedValueOnce({ log: '', updated: [], unchanged: [], unavailable: [{}] })
    m.monitor.lastNewHeader = { height: 100, hash: 'tip-100' }
    const task = new TaskReorg(m.monitor as any, 0, 3, 4)
    await task.runTask()
    expect(m.monitor.logEvent).toHaveBeenLastCalledWith('ReorgRecovery', expect.stringContaining('[[99,99]]'))
    m.monitor.lastNewHeader = { height: 150, hash: 'tip-150' }
    const restarted = new TaskReorg(m.monitor as any, 0, 3, 4)
    await restarted.asyncSetup()
    await restarted.runTask()
    expect(m.reproveHeightMerkleRoot).toHaveBeenCalledTimes(2)
    expect(m.reproveHeightMerkleRoot).toHaveBeenLastCalledWith(99, 'old')
  })

  test('queues the missed middle of a long offline gap and recovers it in bounded batches', async () => {
    const m = makeMonitor({ headersByHeight: roots(0, 200), staleRootsByHeight: { 110: ['orphaned-middle'] } })
    m.monitor.lastNewHeader = { height: 100, hash: 'tip-100' }
    await new TaskReorg(m.monitor as any, 0, 3, 4).runTask()
    m.monitor.lastNewHeader = { height: 150, hash: 'tip-150' }
    const restarted = new TaskReorg(m.monitor as any, 0, 3, 4)
    await restarted.runTask()
    expect(m.reproveHeightMerkleRoot).not.toHaveBeenCalled()
    for (let attempt = 0; attempt < 4; attempt++) await restarted.runTask()
    expect(m.reproveHeightMerkleRoot).toHaveBeenCalledWith(110, 'orphaned-middle')
  })

  test('7 preserves durable intent if checkpoint persistence fails after remote work', async () => {
    const m = makeMonitor({ headersByHeight: roots(97, 100) })
    m.monitor.lastNewHeader = { height: 100, hash: 'tip-100' }
    m.monitor.logEvent.mockImplementationOnce(async () => {}).mockRejectedValueOnce(new Error('disk full'))
    const task = new TaskReorg(m.monitor as any, 0, 3, 4)
    await expect(task.runTask()).rejects.toThrow('disk full')
    expect(task.trigger(Date.now() + 60_000).run).toBe(true)
    await task.runTask()
    expect(m.chaintracks.findHeaderForHeight).toHaveBeenCalledTimes(8)
  })

  test.each([0, 2])('journals old event heights before bounded notification retries (tries=%s)', async tries => {
    const m = makeMonitor({ headersByHeight: roots(0, 100), staleRootsByHeight: { 10: ['old'] } })
    m.monitor.lastNewHeader = { height: 100, hash: 'tip-100' }
    m.monitor.deactivatedHeaders.push({ header: { height: 10, hash: 'old-hash' }, tries, whenMsecs: 0 })
    m.reproveHeader.mockResolvedValue({ log: 'event proof unavailable', updated: [], unchanged: [], unavailable: [{}] })
    const task = new TaskReorg(m.monitor as any, 0, 3, 4)
    expect(task.trigger(Date.now()).run).toBe(true)
    const log = await task.runTask()
    expect(m.monitor.logEvent.mock.calls[0][1]).toContain('[[10,10]]')
    expect(m.reproveHeightMerkleRoot).toHaveBeenCalledWith(10, 'old')
    expect(log).toContain(tries === 2 ? 'maximum retries' : 'retrying...')
  })

  test('8 rejects an invalid recentDepth', () => {
    const m = makeMonitor({})
    for (const depth of [-1, 1.5, 1001, Number.NaN]) {
      expect(() => new TaskReorg(m.monitor as any, 0, 3, depth)).toThrow()
    }
    expect(() => new TaskReorg(m.monitor as any, 0, 3, 1000)).not.toThrow()
  })
})
