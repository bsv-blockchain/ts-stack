import { TaskReviewProvenTxs } from '../TaskReviewProvenTxs'
import { HeightRange } from '../../../services/chaintracker/chaintracks/util/HeightRange'

function makeMonitor(options: {
  tipHeight: number
  headersByHeight?: Record<number, { height: number; merkleRoot: string; hash: string } | undefined>
  staleRootsByHeight?: Record<number, string[]>
  reproveResultsByHeightRoot?: Record<string, { updated: any[]; unchanged: any[]; unavailable: any[]; log: string }>
  monitorEvents?: Array<{ details?: string }>
  reviewResult?: {
    log: string
    reviewedHeights: number
    mismatchedHeights: number
    affectedTransactions: number
    updatedTransactions: number
  }
}) {
  const reviewHeightRange = jest.fn().mockResolvedValue(
    options.reviewResult || {
      log: '',
      reviewedHeights: 0,
      mismatchedHeights: 0,
      affectedTransactions: 0,
      updatedTransactions: 0
    }
  )
  const findStaleMerkleRoots = jest.fn(
    async ({ height }: { height: number }) => options.staleRootsByHeight?.[height] ?? []
  )
  const findMonitorEvents = jest.fn(async () => options.monitorEvents || [])
  const runAsStorageProvider = jest.fn(async (fn: any) => await fn({ findStaleMerkleRoots }))
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

  test('3 runTask starts from height 0 on cold start and caps the range by batch size and minimum age', async () => {
    const m = makeMonitor({
      tipHeight: 250,
      reviewResult: {
        log: '',
        reviewedHeights: 100,
        mismatchedHeights: 0,
        affectedTransactions: 0,
        updatedTransactions: 0
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
        updatedTransactions: 0
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
        updatedTransactions: 0
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
})
