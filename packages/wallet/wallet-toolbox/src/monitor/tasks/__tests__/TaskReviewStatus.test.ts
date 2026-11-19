import { Monitor } from '../../Monitor'
import { TaskReviewStatus } from '../TaskReviewStatus'

test('resumes the bounded SQL status and request cursors without calling full scans', async () => {
  const provider = {
    supportsPrimaryWriteFences: async () => true,
    findMonitorEvents: async () => [{ details: JSON.stringify({ transaction: 1234, request: 72 }) }],
    reviewStatusPage: jest.fn(async () => ({ after: 2200, complete: false, examined: 966, log: '', failed: 0 })),
    reconcileCompletedProvenTxReqs: jest.fn(async () => ({ after: 80, complete: false, log: '' })),
    reviewStatus: jest.fn()
  }
  const logEvent = jest.fn(async () => {})
  const monitor = {
    logEvent,
    storage: { runAsStorageProvider: async (f: (p: typeof provider) => unknown) => await f(provider) }
  }
  const task = new TaskReviewStatus(monitor as unknown as Monitor)
  await task.asyncSetup()
  await task.runTask()
  expect(provider.reviewStatusPage).toHaveBeenCalledWith(expect.anything(), 1234)
  expect(provider.reconcileCompletedProvenTxReqs).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ after: 72, limit: 8 })
  )
  expect(provider.reviewStatus).not.toHaveBeenCalled()
  expect(logEvent).toHaveBeenCalledWith('ReviewStatusProgress', expect.stringContaining('"transaction":2200'))
  await task.runTask()
  expect(provider.reviewStatusPage).toHaveBeenLastCalledWith(expect.anything(), 2200)
})

test('does not advance its in-memory cursor if the checkpoint write fails', async () => {
  const provider = {
    supportsPrimaryWriteFences: async () => true,
    reviewStatusPage: jest.fn(async () => ({ after: 22, complete: false, examined: 22, log: '', failed: 0 })),
    reconcileCompletedProvenTxReqs: async () => ({ complete: true, log: '' })
  }
  const monitor = {
    logEvent: jest.fn(async () => {}).mockRejectedValueOnce(new Error('checkpoint write failed')),
    storage: { runAsStorageProvider: async (f: (p: typeof provider) => unknown) => await f(provider) }
  }
  const task = new TaskReviewStatus(monitor as unknown as Monitor)
  await expect(task.runTask()).rejects.toThrow('checkpoint write failed')
  await task.runTask()
  expect(provider.reviewStatusPage).toHaveBeenLastCalledWith(expect.anything(), 0)
})

test('accepts the original log-only result from a custom request reconciler', async () => {
  const provider = {
    supportsPrimaryWriteFences: async () => true,
    findMonitorEvents: async () => [{ details: JSON.stringify({ transaction: 42, request: 72 }) }],
    reviewStatusPage: async () => ({ after: 50, complete: false, examined: 8, log: '', failed: 0 }),
    reconcileCompletedProvenTxReqs: jest.fn(async () => ({ log: 'notifications restored' }))
  }
  const monitor = {
    logEvent: jest.fn(async () => {}),
    storage: { runAsStorageProvider: async (f: (p: typeof provider) => unknown) => await f(provider) }
  }
  const task = new TaskReviewStatus(monitor as unknown as Monitor)
  await task.asyncSetup()
  await expect(task.runTask()).resolves.toBe('notifications restored')
  expect(monitor.logEvent).toHaveBeenCalledWith('ReviewStatusProgress', expect.stringContaining('"request":0'))
  await task.runTask()
  expect(provider.reconcileCompletedProvenTxReqs).toHaveBeenCalledTimes(1)
})
