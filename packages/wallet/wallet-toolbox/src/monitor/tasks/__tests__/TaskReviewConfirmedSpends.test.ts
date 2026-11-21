import { Monitor } from '../../Monitor'
import { TaskReviewConfirmedSpends } from '../TaskReviewConfirmedSpends'
import type { StorageWriterAdmission } from '../../../storage/StorageActiveWrite'

function makeProvider() {
  const saved: string[] = []
  return {
    loadMonitorCheckpoint: jest.fn(async () => saved.slice(-1)),
    saveMonitorCheckpoint: jest.fn(async (_event: string, details: string) => {
      saved.push(details)
    }),
    reviewConfirmedSpendPage: jest.fn(
      async (
        _after: number,
        _height: number,
        _admission: StorageWriterAdmission
      ): Promise<{ after: number; examined: number; repaired: number; unavailable: number } | undefined> => ({
        after: 25,
        examined: 1,
        repaired: 0,
        unavailable: 0
      })
    ),
    reviewConfirmedSpendRecoveries: jest.fn(async () => ({ after: 0, legacyAfter: null, restored: 0, unavailable: 0 }))
  }
}

function makeMonitor(initial: ReturnType<typeof makeProvider>) {
  let provider = initial
  const monitor = {
    options: {},
    lastNewHeader: { height: 142 },
    storage: { runAsStorageProvider: async (fn: (p: typeof initial) => unknown) => await fn(provider) }
  } as unknown as Monitor
  return {
    monitor,
    select: (next: typeof initial) => {
      provider = next
    }
  }
}

test('reloads the spend cursor and honors the durable hourly recovery cadence', async () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(10 * Monitor.oneHour)
  try {
    const provider = makeProvider()
    const { monitor } = makeMonitor(provider)
    const task = new TaskReviewConfirmedSpends(monitor)
    await task.runTask()
    expect(provider.reviewConfirmedSpendRecoveries).toHaveBeenCalledTimes(1)
    const restarted = new TaskReviewConfirmedSpends(monitor)
    await restarted.asyncSetup()
    await restarted.runTask()
    expect(provider.reviewConfirmedSpendPage).toHaveBeenLastCalledWith(
      25,
      142,
      expect.any(Function),
      undefined,
      undefined
    )
    expect(provider.reviewConfirmedSpendRecoveries).toHaveBeenCalledTimes(1)
    now.mockReturnValue(11 * Monitor.oneHour)
    await restarted.runTask()
    expect(provider.reviewConfirmedSpendRecoveries).toHaveBeenCalledTimes(2)
  } finally {
    now.mockRestore()
  }
})

test('an unsupported provider does not permanently disable work on a later SQL provider', async () => {
  const unavailable = makeProvider()
  unavailable.reviewConfirmedSpendPage.mockResolvedValue(undefined)
  const { monitor, select } = makeMonitor(unavailable)
  const task = new TaskReviewConfirmedSpends(monitor)
  await task.runTask()
  expect(unavailable.saveMonitorCheckpoint).not.toHaveBeenCalled()
  const sql = makeProvider()
  select(sql)
  await task.runTask()
  expect(sql.loadMonitorCheckpoint).toHaveBeenCalledWith('ReviewConfirmedSpends')
  expect(sql.saveMonitorCheckpoint).toHaveBeenCalledTimes(1)
})

test('provider replacement rejects both a prepared spend write and a stale checkpoint', async () => {
  const provider = makeProvider()
  const replacement = makeProvider()
  const { monitor, select } = makeMonitor(provider)
  const task = new TaskReviewConfirmedSpends(monitor)
  const write = jest.fn(async () => 1)
  provider.reviewConfirmedSpendPage.mockImplementationOnce(async (_after, _tip, admit) => {
    select(replacement)
    await expect(admit(write)).rejects.toMatchObject({ code: 'WERR_NOT_ACTIVE' })
    return { after: 25, examined: 1, repaired: 0, unavailable: 0 }
  })
  await expect(task.runTask()).rejects.toMatchObject({ code: 'WERR_NOT_ACTIVE' })
  expect(write).not.toHaveBeenCalled()
  expect(provider.saveMonitorCheckpoint).not.toHaveBeenCalled()
  await task.runTask()
  expect(replacement.reviewConfirmedSpendPage).toHaveBeenCalledWith(0, 142, expect.any(Function), undefined, undefined)
})
