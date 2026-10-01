import {
  drainSnapshotArchiveRequest,
  SnapshotArchiveCleanupPendingError,
  snapshotArchiveCleanupLimits,
  validateSnapshotArchiveCancellation
} from './SnapshotArchiveCleanup'
import { SnapshotArchiveTransportFailure } from './SnapshotArchiveTransportFailure'
import { getEventListeners } from 'node:events'

const requestId = 'a'.repeat(64)
const pending = () => ({ version: 1, outcome: 'cleanup-pending', requestId })
function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(() => {
  jest.restoreAllMocks()
  jest.useRealTimers()
})

test('only a true cancellation acknowledgement proves completed cleanup', () => {
  expect(validateSnapshotArchiveCancellation(true, requestId)).toBeUndefined()
  expect(() => validateSnapshotArchiveCancellation(pending(), requestId)).toThrow(SnapshotArchiveCleanupPendingError)
})

test.each([
  undefined,
  null,
  false,
  1,
  'true',
  [],
  {},
  { ...pending(), version: 2 },
  { ...pending(), outcome: 'closed' },
  { ...pending(), requestId: 'b'.repeat(64) },
  { version: 1, outcome: 'cleanup-pending', other: requestId },
  { ...pending(), extra: true },
  { ...pending(), [Symbol('extra')]: true },
  Object.create(pending()),
  Object.defineProperty({ ...pending() }, 'version', { value: 1, enumerable: false })
])('malformed or foreign cancellation receipt %p cannot acknowledge cleanup', value => {
  expect(() => validateSnapshotArchiveCancellation(value, requestId)).toThrow(
    new TypeError('Invalid snapshot archive cancellation receipt')
  )
})

test('cancellation receipt validation never invokes an accessor', () => {
  const getter = jest.fn(() => requestId)
  const value = Object.defineProperty({ version: 1, outcome: 'cleanup-pending' }, 'requestId', {
    get: getter,
    enumerable: true
  })
  expect(() => validateSnapshotArchiveCancellation(value, requestId)).toThrow(TypeError)
  expect(getter).not.toHaveBeenCalled()
})

test('pending cleanup uses bounded exponential delay and one signal until a real acknowledgement', async () => {
  jest.useFakeTimers({ now: 1000000 })
  const calls: number[] = []
  const signals: AbortSignal[] = []
  const cancel = jest.fn(async (signal: AbortSignal) => {
    expect(getEventListeners(signal, 'abort')).toHaveLength(0)
    calls.push(Date.now())
    signals.push(signal)
    if (calls.length < 6) throw new SnapshotArchiveCleanupPendingError()
  })
  let completed = false
  const closing = drainSnapshotArchiveRequest(cancel).then(() => {
    completed = true
  })
  await jest.advanceTimersByTimeAsync(2499)
  expect(completed).toBe(false)
  expect(calls).toEqual([1000000, 1000100, 1000300, 1000700, 1001500])
  await jest.advanceTimersByTimeAsync(1)
  await closing
  expect(calls).toEqual([1000000, 1000100, 1000300, 1000700, 1001500, 1002500])
  expect(new Set(signals).size).toBe(1)
  expect(signals[0].aborted).toBe(false)
  expect(getEventListeners(signals[0], 'abort')).toHaveLength(0)
  expect(jest.getTimerCount()).toBe(0)
})

test('repeated pending receipts terminate at the fixed attempt bound without claiming completion', async () => {
  jest.useFakeTimers()
  const cancel = jest.fn(async () => {
    throw new SnapshotArchiveCleanupPendingError()
  })
  const closing = drainSnapshotArchiveRequest(cancel)
  const outcome = expect(closing).rejects.toBeInstanceOf(SnapshotArchiveCleanupPendingError)
  await jest.advanceTimersByTimeAsync(30000)
  await outcome
  expect(snapshotArchiveCleanupLimits).toEqual({ lifetimeMs: 30000, attempts: 32, delayMs: 1000 })
  expect(Object.isFrozen(snapshotArchiveCleanupLimits)).toBe(true)
  expect(cancel).toHaveBeenCalledTimes(32)
  expect(jest.getTimerCount()).toBe(0)
})

test.each(['pending', 'complete', 'failure'] as const)(
  'cleanup deadline aborts I/O but awaits its %s settlement',
  async settlement => {
    jest.useFakeTimers()
    const entered = gate()
    const release = gate()
    const failure = new Error('synthetic independent cleanup failure')
    let signal: AbortSignal | undefined
    let settled = false
    const cancel = jest.fn(async (current: AbortSignal) => {
      signal = current
      entered.resolve()
      await release.promise
      if (settlement === 'pending') throw new SnapshotArchiveCleanupPendingError()
      if (settlement === 'failure') throw failure
    })
    const closing = drainSnapshotArchiveRequest(cancel)
    const observed = closing.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    try {
      await entered.promise
      expect(signal!.aborted).toBe(false)
      await jest.advanceTimersByTimeAsync(30000)
      expect(signal!.aborted).toBe(true)
      expect(settled).toBe(false)
      release.resolve()
      if (settlement === 'complete') await expect(closing).resolves.toBeUndefined()
      else if (settlement === 'failure') await expect(closing).rejects.toBe(failure)
      else await expect(closing).rejects.toBeInstanceOf(SnapshotArchiveCleanupPendingError)
      expect(cancel).toHaveBeenCalledTimes(1)
      await observed
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      release.resolve()
      await observed
    }
  }
)

test.each(['wall', 'monotonic'] as const)('stalled timers cannot extend the %s cleanup deadline', async clock => {
  jest.useFakeTimers({ now: 1000000 })
  const monotonic = jest.spyOn(performance, 'now').mockReturnValue(4000)
  const cancel = jest.fn(async () => {
    if (clock === 'wall') jest.setSystemTime(1030000)
    else {
      jest.setSystemTime(-1000000)
      monotonic.mockReturnValue(34000)
    }
    throw new SnapshotArchiveCleanupPendingError()
  })
  await expect(drainSnapshotArchiveRequest(cancel)).rejects.toBeInstanceOf(SnapshotArchiveCleanupPendingError)
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(jest.getTimerCount()).toBe(0)
})

test('only native transport loss retries, with the identical cleanup signal', async () => {
  jest.useFakeTimers()
  const signals: AbortSignal[] = []
  const loss = new SnapshotArchiveTransportFailure('synthetic lost cancellation acknowledgement')
  const cancel = jest.fn(async (signal: AbortSignal) => {
    signals.push(signal)
    throw loss
  })
  await expect(drainSnapshotArchiveRequest(cancel)).rejects.toBe(loss)
  expect(cancel).toHaveBeenCalledTimes(2)
  expect(signals[0]).toBe(signals[1])
  expect(jest.getTimerCount()).toBe(0)
})

test('a native failure at the deadline cannot start its retry', async () => {
  jest.useFakeTimers({ now: 1000000 })
  const cancel = jest.fn(async () => {
    jest.setSystemTime(1030000)
    throw new SnapshotArchiveTransportFailure('synthetic deadline loss')
  })
  await expect(drainSnapshotArchiveRequest(cancel)).rejects.toBeInstanceOf(SnapshotArchiveCleanupPendingError)
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(jest.getTimerCount()).toBe(0)
})

test('timeout during pending backoff clears the delay and never starts another request', async () => {
  jest.useFakeTimers()
  const cancel = jest.fn(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 29950))
    throw new SnapshotArchiveCleanupPendingError()
  })
  const closing = drainSnapshotArchiveRequest(cancel)
  const rejected = expect(closing).rejects.toBeInstanceOf(SnapshotArchiveCleanupPendingError)
  await jest.advanceTimersByTimeAsync(30000)
  await rejected
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(jest.getTimerCount()).toBe(0)
})
