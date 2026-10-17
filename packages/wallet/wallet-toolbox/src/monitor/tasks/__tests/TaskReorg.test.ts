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
  const monitor = {
    storage: {
      runAsStorageProvider: jest.fn(async (fn: any) => await fn({ findStaleMerkleRoots })),
      reproveHeightMerkleRoot,
      reproveHeader
    },
    chaintracks,
    chaintracksWithEvents: undefined,
    deactivatedHeaders: [],
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

  test('4 a failed review waits for the next block instead of retrying every tick', async () => {
    const m = makeMonitor({ headersByHeight: roots(0, 200) })
    m.chaintracks.findHeaderForHeight.mockRejectedValueOnce(new Error('chaintracks unavailable'))
    const task = new TaskReorg(m.monitor as any, 0, 3, 4)
    m.monitor.lastNewHeader = { height: 100, hash: 'tip-100' }

    await expect(task.runTask()).rejects.toThrow('chaintracks unavailable')
    expect(task.trigger(Date.now()).run).toBe(false)

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

  test('6 rejects an invalid recentDepth', () => {
    const m = makeMonitor({})
    for (const depth of [-1, 1.5, 1001, Number.NaN]) {
      expect(() => new TaskReorg(m.monitor as any, 0, 3, depth)).toThrow()
    }
    expect(() => new TaskReorg(m.monitor as any, 0, 3, 1000)).not.toThrow()
  })
})
