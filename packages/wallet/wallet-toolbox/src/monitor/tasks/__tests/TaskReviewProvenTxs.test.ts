import { TaskReviewProvenTxs } from '../TaskReviewProvenTxs'
import { HeightRange } from '../../../services/chaintracker/chaintracks/util/HeightRange'

function makeMonitor(options: {
  tipHeight: number
  headersByHeight?: Record<number, { height: number; merkleRoot: string; hash: string } | undefined>
  staleRootsByHeight?: Record<number, string[]>
  reproveResultsByHeightRoot?: Record<string, { updated: any[]; unchanged: any[]; unavailable: any[]; log: string }>
  monitorEvents?: Array<{ details?: string }>
  provenTxs?: Array<{ height: number }>
  reviewResult?: {
    log: string
    reviewedHeights: number
    mismatchedHeights: number
    affectedTransactions: number
    updatedTransactions: number
    unresolvedHeights: number[]
  }
}) {
  const reviewHeightRange = jest.fn().mockResolvedValue(
    options.reviewResult || {
      log: '',
      reviewedHeights: 0,
      mismatchedHeights: 0,
      affectedTransactions: 0,
      updatedTransactions: 0,
      unresolvedHeights: []
    }
  )
  const findStaleMerkleRoots = jest.fn(
    async ({ height }: { height: number }) => options.staleRootsByHeight?.[height] ?? []
  )
  const findMonitorEvents = jest.fn(async () => options.monitorEvents || [])
  const getProvenTxsReviewStartHeight = jest.fn(async () => {
    const heights = (options.provenTxs ?? [{ height: 0 }]).map(row => row.height)
    return heights.length === 0 ? undefined : Math.min(...heights)
  })
  const runAsStorageProvider = jest.fn(
    async (fn: any) =>
      await fn({
        findStaleMerkleRoots,
        findMonitorEvents,
        getProvenTxsReviewStartHeight
      })
  )
  const reproveHeightMerkleRoot = jest.fn(async (height: number, staleRoot: string) => {
    return (
      options.reproveResultsByHeightRoot?.[`${height}:${staleRoot}`] || {
        log: `  reproved ${height}:${staleRoot}\n`,
        updated: [],
        unchanged: [],
        unavailable: []
      }
    )
  })
  const logEvent = jest.fn().mockResolvedValue(undefined)

  const chaintracks = {
    currentHeight: jest.fn().mockResolvedValue(options.tipHeight),
    findHeaderForHeight: jest.fn(async (height: number) => options.headersByHeight?.[height])
  }

  return {
    monitor: {
      storage: {
        runAsStorageProvider,
        reproveHeightMerkleRoot
      },
      chaintracks,
      chaintracksWithEvents: undefined,
      logEvent
    },
    reviewHeightRange,
    findStaleMerkleRoots,
    findMonitorEvents,
    runAsStorageProvider,
    reproveHeightMerkleRoot,
    logEvent,
    chaintracks
  }
}

describe('TaskReviewProvenTxs tests', () => {
  test('0 reviewHeightRange uses findStaleMerkleRoots and reproves only stale roots in the requested range', async () => {
    const m = makeMonitor({
      tipHeight: 120,
      headersByHeight: {
        107: { height: 107, merkleRoot: 'root-107', hash: 'hash-107' },
        108: { height: 108, merkleRoot: 'root-108-new', hash: 'hash-108' }
      },
      staleRootsByHeight: {
        107: [],
        108: ['root-108-old']
      },
      reproveResultsByHeightRoot: {
        '108:root-108-old': {
          log: '  height 108 stale merkleRoot root-108-old with 2 impacted transactions\n',
          updated: [{}],
          unchanged: [{}],
          unavailable: []
        }
      }
    })
    const task = new TaskReviewProvenTxs(m.monitor as any, 0, 2, 12)

    const result = await task.reviewHeightRange(new HeightRange(107, 108))

    expect(m.findStaleMerkleRoots).toHaveBeenNthCalledWith(1, { height: 107, merkleRoot: 'root-107' })
    expect(m.findStaleMerkleRoots).toHaveBeenNthCalledWith(2, { height: 108, merkleRoot: 'root-108-new' })
    expect(m.reproveHeightMerkleRoot).toHaveBeenCalledTimes(1)
    expect(m.reproveHeightMerkleRoot).toHaveBeenCalledWith(108, 'root-108-old')
    expect(result.reviewedHeights).toBe(2)
    expect(result.mismatchedHeights).toBe(1)
    expect(result.affectedTransactions).toBe(2)
    expect(result.updatedTransactions).toBe(1)
    expect(result.log).toContain('height 108 canonical root-108-new stale root-108-old')
  })

  test('1 reviewHeightRange records unavailable headers and skips empty ranges cleanly', async () => {
    const m = makeMonitor({
      tipHeight: 120,
      headersByHeight: {
        10: undefined
      }
    })
    const task = new TaskReviewProvenTxs(m.monitor as any, 0, 2, 12)

    const result = await task.reviewHeightRange(new HeightRange(10, 10))
    const empty = await task.reviewHeightRange(HeightRange.empty)

    expect(m.reproveHeightMerkleRoot).not.toHaveBeenCalled()
    expect(result.reviewedHeights).toBe(1)
    expect(result.log).toContain('height 10 canonical header unavailable')
    expect(empty.reviewedHeights).toBe(0)
    expect(empty.log).toBe('')
  })

  test('2 getLastReviewedHeight skips plain-text events and uses the latest checkpoint event', async () => {
    const m = makeMonitor({
      tipHeight: 120,
      monitorEvents: [
        { details: 'reviewing heights 10..20 tip=120 minAge=100 maxPerRun=100' },
        { details: JSON.stringify({ reviewedThroughHeight: 20 }) },
        { details: JSON.stringify({ reviewedThroughHeight: 7 }) }
      ]
    })
    const task = new TaskReviewProvenTxs(m.monitor as any)
    jest
      .spyOn(task.storage, 'runAsStorageProvider')
      .mockImplementation(async (fn: any) => await fn({ findMonitorEvents: m.findMonitorEvents }))

    const lastReviewedHeight = await task.getLastReviewedHeight()

    expect(lastReviewedHeight).toBe(20)
  })

  test('3 runTask starts from the earliest proof and caps the range by batch size and minimum age', async () => {
    const m = makeMonitor({
      tipHeight: 250,
      reviewResult: {
        log: '',
        reviewedHeights: 100,
        mismatchedHeights: 0,
        affectedTransactions: 0,
        updatedTransactions: 0,
        unresolvedHeights: []
      }
    })
    const task = new TaskReviewProvenTxs(m.monitor as any, 0, 100, 100)
    jest.spyOn(task, 'getLastReviewedHeight').mockResolvedValue(undefined)
    const reviewSpy = jest.spyOn(task, 'reviewHeightRange').mockResolvedValue(m.reviewHeightRange())

    const log = await task.runTask()

    expect(reviewSpy).toHaveBeenCalledWith(new HeightRange(0, 99))
    expect(log).toContain('"reviewedThroughHeight":99')
    expect(log).toContain('"minBlockAge":100')
    expect(log).toContain('reviewing heights 0..99 tip=250 minAge=100 maxPerRun=100')
    expect(m.logEvent).not.toHaveBeenCalled()
  })

  test('4 runTask resumes from the last reviewed height plus one', async () => {
    const m = makeMonitor({
      tipHeight: 250,
      reviewResult: {
        log: '  height 121 canonical root-121-new stale root-121-old\n  reproved stale root\n',
        reviewedHeights: 21,
        mismatchedHeights: 1,
        affectedTransactions: 1,
        updatedTransactions: 0,
        unresolvedHeights: []
      }
    })
    const task = new TaskReviewProvenTxs(m.monitor as any, 0, 100, 100)
    jest.spyOn(task, 'getLastReviewedHeight').mockResolvedValue(100)
    const reviewSpy = jest.spyOn(task, 'reviewHeightRange').mockResolvedValue(m.reviewHeightRange())

    const log = await task.runTask()

    expect(reviewSpy).toHaveBeenCalledTimes(1)
    expect(reviewSpy).toHaveBeenCalledWith(new HeightRange(101, 150))
    expect(log).toContain('"reviewedThroughHeight":150')
    expect(log).toContain('"minBlockAge":100')
    expect(log).toContain('reviewing heights 101..150 tip=250 minAge=100 maxPerRun=100')
    expect(log).toContain('height 121 canonical root-121-new stale root-121-old')
    expect(m.logEvent).not.toHaveBeenCalled()
  })

  test('5 runTask returns review logs even when the range is clean', async () => {
    const m = makeMonitor({
      tipHeight: 250,
      reviewResult: {
        log: '',
        reviewedHeights: 50,
        mismatchedHeights: 0,
        affectedTransactions: 0,
        updatedTransactions: 0,
        unresolvedHeights: []
      }
    })
    const task = new TaskReviewProvenTxs(m.monitor as any, 0, 50, 100)
    jest.spyOn(task, 'getLastReviewedHeight').mockResolvedValue(149)
    const reviewSpy = jest.spyOn(task, 'reviewHeightRange').mockResolvedValue(m.reviewHeightRange())

    const log = await task.runTask()

    expect(reviewSpy).toHaveBeenCalledTimes(1)
    expect(reviewSpy).toHaveBeenCalledWith(new HeightRange(150, 150))
    expect(log).toContain('"reviewedThroughHeight":150')
    expect(log).toContain('"minBlockAge":100')
    expect(log).toContain('reviewing heights 150..150 tip=250 minAge=100 maxPerRun=50')
    expect(m.logEvent).not.toHaveBeenCalled()
  })

  test('6 runTask returns early when the chain tip is below the minimum age window', async () => {
    const m = makeMonitor({
      tipHeight: 5
    })
    const task = new TaskReviewProvenTxs(m.monitor as any, 0, 100, 100)
    jest.spyOn(task, 'getLastReviewedHeight').mockResolvedValue(undefined)

    const log = await task.runTask()

    expect(m.reviewHeightRange).not.toHaveBeenCalled()
    expect(log).toBe('')
    expect(m.logEvent).not.toHaveBeenCalled()
  })

  test('7 runTask returns early when all eligible heights have already been reviewed', async () => {
    const m = makeMonitor({
      tipHeight: 250
    })
    const task = new TaskReviewProvenTxs(m.monitor as any, 0, 100, 100)
    jest.spyOn(task, 'getLastReviewedHeight').mockResolvedValue(200)

    const log = await task.runTask()

    expect(m.reviewHeightRange).not.toHaveBeenCalled()
    expect(log).toBe('')
    expect(m.logEvent).not.toHaveBeenCalled()
  })

  test('8 runTask returns empty log when the computed range is empty', async () => {
    const m = makeMonitor({
      tipHeight: 250
    })
    const task = new TaskReviewProvenTxs(m.monitor as any, 0, 0, 100)
    jest.spyOn(task, 'getLastReviewedHeight').mockResolvedValue(undefined)

    const log = await task.runTask()

    expect(m.reviewHeightRange).not.toHaveBeenCalled()
    expect(log).toBe('')
    expect(m.logEvent).not.toHaveBeenCalled()
  })

  test('9 unresolved mismatches are retained and retried after the forward cursor advances', async () => {
    const m = makeMonitor({
      tipHeight: 260,
      monitorEvents: [{ details: JSON.stringify({ reviewedThroughHeight: 150, retryHeights: [121] }) }],
      headersByHeight: {
        121: { height: 121, merkleRoot: 'root-121-new', hash: 'hash-121' },
        151: { height: 151, merkleRoot: 'root-151', hash: 'hash-151' },
        152: { height: 152, merkleRoot: 'root-152', hash: 'hash-152' }
      },
      staleRootsByHeight: {
        121: ['root-121-old']
      },
      reproveResultsByHeightRoot: {
        '121:root-121-old': {
          log: '  repaired retry\n',
          updated: [{}],
          unchanged: [],
          unavailable: []
        }
      }
    })
    const task = new TaskReviewProvenTxs(m.monitor as any, 0, 2, 100)

    const log = await task.runTask()
    const checkpoint = JSON.parse(log)

    expect(m.reproveHeightMerkleRoot).toHaveBeenCalledWith(121, 'root-121-old')
    expect(checkpoint.reviewedThroughHeight).toBe(152)
    expect(checkpoint.retryHeights).toEqual([])
    expect(checkpoint.reviewLog).toContain('retrying unresolved heights 121..121')
    expect(checkpoint.reviewLog).toContain('reviewing heights 151..152')
  })

  test('10 unresolved replacement failures remain in the retry checkpoint', async () => {
    const m = makeMonitor({
      tipHeight: 260,
      monitorEvents: [{ details: JSON.stringify({ reviewedThroughHeight: 150, retryHeights: [121] }) }],
      headersByHeight: {
        121: { height: 121, merkleRoot: 'root-121-new', hash: 'hash-121' },
        151: { height: 151, merkleRoot: 'root-151', hash: 'hash-151' }
      },
      staleRootsByHeight: {
        121: ['root-121-old']
      },
      reproveResultsByHeightRoot: {
        '121:root-121-old': {
          log: '  replacement unavailable\n',
          updated: [],
          unchanged: [],
          unavailable: [{}]
        }
      }
    })
    const task = new TaskReviewProvenTxs(m.monitor as any, 0, 1, 100)

    const checkpoint = JSON.parse(await task.runTask())

    expect(checkpoint.reviewedThroughHeight).toBe(151)
    expect(checkpoint.retryHeights).toEqual([121])
  })

  test('11 getLastReviewedHeight starts immediately before the first proven transaction', async () => {
    const m = makeMonitor({ tipHeight: 120, provenTxs: [{ height: 17 }] })
    const task = new TaskReviewProvenTxs(m.monitor as any)

    await expect(task.getLastReviewedHeight()).resolves.toBe(16)
  })

  test('12 retry work is deduplicated, bounded, and retained with a durable fair cursor', async () => {
    const m = makeMonitor({
      tipHeight: 250,
      monitorEvents: [
        {
          details: JSON.stringify({
            reviewedThroughHeight: 150,
            retryHeights: [125, 123, 124, 123, -1, 151]
          })
        }
      ],
      headersByHeight: {
        123: { height: 123, merkleRoot: 'root-123', hash: 'hash-123' },
        125: { height: 125, merkleRoot: 'root-125', hash: 'hash-125' }
      }
    })
    const task = new TaskReviewProvenTxs(m.monitor as any, 0, 0, 100, 1, 2)

    const checkpoint = JSON.parse(await task.runTask())

    expect(m.chaintracks.findHeaderForHeight).toHaveBeenNthCalledWith(1, 123)
    expect(m.chaintracks.findHeaderForHeight).toHaveBeenNthCalledWith(2, 124)
    expect(checkpoint.reviewedThroughHeight).toBe(150)
    expect(checkpoint.retryHeights).toEqual([124, 125, 151])
    expect(checkpoint.reviewLog).toContain('retrying unresolved heights 123..124')
    expect(checkpoint.reviewLog).not.toContain('reviewing heights')
  })

  test('13 pending retries get a turn across restarts while earlier repairs remain unavailable', async () => {
    const monitorEvents = [{ details: JSON.stringify({ reviewedThroughHeight: 150, retryHeights: [121, 122, 123] }) }]
    const unavailable = { log: '', updated: [], unchanged: [], unavailable: [{}] }
    const m = makeMonitor({
      tipHeight: 250,
      monitorEvents,
      headersByHeight: {
        121: { height: 121, merkleRoot: 'new-121', hash: 'hash-121' },
        122: { height: 122, merkleRoot: 'new-122', hash: 'hash-122' },
        123: { height: 123, merkleRoot: 'new-123', hash: 'hash-123' }
      },
      staleRootsByHeight: { 121: ['old'], 122: ['old'], 123: ['old'] },
      reproveResultsByHeightRoot: {
        '121:old': unavailable,
        '122:old': unavailable,
        '123:old': { log: '', updated: [{}], unchanged: [], unavailable: [] }
      }
    })
    const firstTask = new TaskReviewProvenTxs(m.monitor as any, 0, 100, 100, 1, 2)
    const firstCheckpoint = await firstTask.runTask()
    expect(JSON.parse(firstCheckpoint).retryHeights).toEqual([121, 122, 123])
    monitorEvents.unshift({ details: firstCheckpoint })

    const restartedTask = new TaskReviewProvenTxs(m.monitor as any, 0, 100, 100, 1, 2)
    const nextCheckpoint = JSON.parse(await restartedTask.runTask())

    expect(m.reproveHeightMerkleRoot.mock.calls).toEqual([
      [121, 'old'],
      [122, 'old'],
      [123, 'old'],
      [121, 'old']
    ])
    expect(nextCheckpoint.retryHeights).toEqual([121, 122])
    expect(nextCheckpoint.updatedTransactions).toBe(1)
    expect(nextCheckpoint.reviewedThroughHeight).toBe(150)
  })

  test('14 temporarily ineligible retries survive a saved checkpoint and run when the tip recovers', async () => {
    const monitorEvents = [{ details: JSON.stringify({ reviewedThroughHeight: 150, retryHeights: [150, 121] }) }]
    const m = makeMonitor({
      tipHeight: 249,
      monitorEvents,
      headersByHeight: {
        121: { height: 121, merkleRoot: 'new-121', hash: 'hash-121' },
        150: { height: 150, merkleRoot: 'new-150', hash: 'hash-150' }
      },
      staleRootsByHeight: { 121: ['old'], 150: ['old'] },
      reproveResultsByHeightRoot: {
        '121:old': { log: '', updated: [], unchanged: [], unavailable: [{}] },
        '150:old': { log: '', updated: [{}], unchanged: [], unavailable: [] }
      }
    })
    const firstTask = new TaskReviewProvenTxs(m.monitor as any)
    const firstCheckpoint = await firstTask.runTask()
    expect(JSON.parse(firstCheckpoint).retryHeights).toEqual([121, 150])
    expect(m.chaintracks.findHeaderForHeight).toHaveBeenCalledTimes(1)
    expect(m.chaintracks.findHeaderForHeight).toHaveBeenCalledWith(121)
    monitorEvents.unshift({ details: firstCheckpoint })
    m.chaintracks.currentHeight.mockResolvedValue(250)

    const restartedTask = new TaskReviewProvenTxs(m.monitor as any)
    const nextCheckpoint = JSON.parse(await restartedTask.runTask())

    expect(m.reproveHeightMerkleRoot).toHaveBeenCalledWith(150, 'old')
    expect(nextCheckpoint.retryHeights).toEqual([121])
    expect(nextCheckpoint.updatedTransactions).toBe(1)
    expect(nextCheckpoint.reviewedThroughHeight).toBe(150)
  })

  test('15 ignores malformed persisted heights and rejects an unsafe chain tip', async () => {
    const m = makeMonitor({
      tipHeight: Number.MAX_SAFE_INTEGER,
      monitorEvents: [
        { details: JSON.stringify({ reviewedThroughHeight: -1 }) },
        { details: JSON.stringify({ reviewedThroughHeight: 1.5 }) }
      ]
    })
    const task = new TaskReviewProvenTxs(m.monitor as any)
    jest
      .spyOn(task.storage, 'runAsStorageProvider')
      .mockImplementation(
        async (fn: any) =>
          await fn({ findMonitorEvents: m.findMonitorEvents, getProvenTxsReviewStartHeight: async () => undefined })
      )

    await expect(task.getLastReviewedHeight()).resolves.toBeUndefined()
    await expect(task.runTask()).rejects.toThrow('chain tip height')
  })
  test('an empty wallet leaves no checkpoint, then starts at its first proof', async () => {
    const provenTxs: Array<{ height: number }> = []
    const monitorEvents: Array<{ details?: string }> = []
    const m = makeMonitor({ tipHeight: 971500, provenTxs, monitorEvents })
    const first = new TaskReviewProvenTxs(m.monitor as any)
    expect(await first.runTask()).toBe('')
    provenTxs.push({ height: 971225 })
    const restarted = new TaskReviewProvenTxs(m.monitor as any)
    const review = jest.spyOn(restarted, 'reviewHeightRange').mockResolvedValue(m.reviewHeightRange())
    expect(JSON.parse(await restarted.runTask()).startHeight).toBe(971225)
    expect(review).toHaveBeenCalledWith(new HeightRange(971225, 971324))
  })

  test('an old empty-prefix checkpoint skips forward without losing older pending work', async () => {
    const m = makeMonitor({
      tipHeight: 971500,
      provenTxs: [{ height: 971225 }, { height: 971200 }],
      monitorEvents: [{ details: JSON.stringify({ reviewedThroughHeight: 99, retryHeights: [17] }) }]
    })
    const task = new TaskReviewProvenTxs(m.monitor as any)
    const review = jest.spyOn(task, 'reviewHeightRange').mockResolvedValue(m.reviewHeightRange())
    const checkpoint = JSON.parse(await task.runTask())
    expect(review).toHaveBeenNthCalledWith(1, new HeightRange(17, 17))
    expect(review).toHaveBeenNthCalledWith(2, new HeightRange(971200, 971299))
    expect(checkpoint.startHeight).toBe(971200)
  })

  test('a fragmented retry checkpoint survives large diagnostics and parser limits without losing heights', async () => {
    const heights = Array.from({ length: 1000 }, (_, index) => 2_000_000_000 + index * 2)
    const monitorEvents = [{ details: JSON.stringify({ reviewedThroughHeight: 99, retryHeights: [] as number[] }) }]
    const m = makeMonitor({
      tipHeight: 2_000_003_000,
      provenTxs: [{ height: 2_000_000_000 }],
      monitorEvents,
      reviewResult: {
        log: '\u0000'.repeat(20_000),
        reviewedHeights: 1000,
        mismatchedHeights: 0,
        affectedTransactions: 0,
        updatedTransactions: 0,
        unresolvedHeights: heights
      }
    })
    const task = new TaskReviewProvenTxs(m.monitor as any, 0, 1000, 0)
    jest.spyOn(task, 'reviewHeightRange').mockResolvedValue(m.reviewHeightRange())
    const details = await task.runTask()
    expect(details.length).toBeLessThan(8192)
    const checkpoint = JSON.parse(details)
    expect(checkpoint.retryRecovery.ranges.length).toBeLessThanOrEqual(128)
    for (const height of heights) {
      expect(checkpoint.retryRecovery.ranges.some(([min, max]: number[]) => height >= min && height <= max)).toBe(true)
    }
    monitorEvents.unshift({ details })
    const restored = await new TaskReviewProvenTxs(m.monitor as any).getLastCheckpoint()
    expect(restored?.retryRecovery?.ranges).toEqual(checkpoint.retryRecovery.ranges)
  })
  test('a malformed explicit recovery queue falls back to a previous valid durable checkpoint', async () => {
    const m = makeMonitor({
      tipHeight: 500,
      monitorEvents: [
        {
          details: JSON.stringify({
            reviewedThroughHeight: 400,
            retryRecovery: { ranges: 'corrupt', cursor: 0 },
            retryHeights: []
          })
        },
        { details: JSON.stringify({ reviewedThroughHeight: 300, retryHeights: [17] }) }
      ]
    })
    const checkpoint = await new TaskReviewProvenTxs(m.monitor as any).getLastCheckpoint()
    expect(checkpoint?.reviewedThroughHeight).toBe(300)
    expect(checkpoint?.retryRecovery?.ranges).toEqual([[17, 17]])
  })
  test('a completed bootstrap resumes the bounded audit without rescanning the proof table', async () => {
    const m = makeMonitor({
      tipHeight: 500,
      monitorEvents: [{ details: JSON.stringify({ reviewedThroughHeight: 200, bootstrapComplete: true }) }]
    })
    const task = new TaskReviewProvenTxs(m.monitor as any)
    const minimum = jest.spyOn(task as any, 'getFirstProvenHeight')
    jest.spyOn(task, 'reviewHeightRange').mockResolvedValue(m.reviewHeightRange())
    const result = JSON.parse(await task.runTask())
    expect(result.startHeight).toBe(201)
    expect(result.bootstrapComplete).toBe(true)
    expect(minimum).not.toHaveBeenCalled()
  })
  test('retry-only work in an empty legacy wallet does not finish bootstrap before its first proof', async () => {
    const provenTxs: Array<{ height: number }> = []
    const monitorEvents = [{ details: JSON.stringify({ reviewedThroughHeight: 99, retryHeights: [17] }) }]
    const m = makeMonitor({ tipHeight: 971500, provenTxs, monitorEvents })
    const empty = new TaskReviewProvenTxs(m.monitor as any)
    jest.spyOn(empty, 'reviewHeightRange').mockResolvedValue(m.reviewHeightRange())
    const details = await empty.runTask()
    expect(JSON.parse(details).bootstrapComplete).toBe(false)
    monitorEvents.unshift({ details })
    provenTxs.push({ height: 971225 })
    const funded = new TaskReviewProvenTxs(m.monitor as any)
    jest.spyOn(funded, 'reviewHeightRange').mockResolvedValue(m.reviewHeightRange())
    expect(JSON.parse(await funded.runTask()).startHeight).toBe(971225)
  })
})
