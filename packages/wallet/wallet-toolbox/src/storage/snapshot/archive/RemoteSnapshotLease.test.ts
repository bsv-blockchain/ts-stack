import { RemoteSnapshotLease } from './RemoteSnapshotLease'
import { remoteReaderFixture } from '../../../../test/utils/remoteSnapshotReaderFixtures'
import { snapshotArchiveReaderRequestId } from './SnapshotArchiveReaderRequest'
import { SnapshotCancelledError } from '../SnapshotCancelledError'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'
import { SnapshotArchiveTransportFailure } from './SnapshotArchiveTransportFailure'

function request() {
  const fields = { version: 2 as const, nonce: 'a'.repeat(64), notAfter: Date.now() + 300000, maxBytes: 32768 }
  return { ...fields, requestId: snapshotArchiveReaderRequestId(fields) }
}
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

test.each([0, -1, 3600001, 1.5, NaN, Infinity])('rejects invalid lifetime %p before retaining a timer', lifetimeMs => {
  jest.useFakeTimers()
  const { transport } = remoteReaderFixture([])
  expect(() => new RemoteSnapshotLease(transport, { lifetimeMs })).toThrow('an integer from 1 to 3600000')
  expect(jest.getTimerCount()).toBe(0)
})

test('server time includes the entire offer round trip and wall-clock rollback cannot extend the lease', async () => {
  jest.useFakeTimers({ now: 1790812800000 })
  const { transport } = remoteReaderFixture([])
  const lease = new RemoteSnapshotLease(transport, { lifetimeMs: 1000 })
  expect(() => lease.now()).toThrow('clock is not bound')
  await jest.advanceTimersByTimeAsync(200)
  lease.bindServerTime(100000)
  expect(lease.now()).toBe(100200)
  expect(() => lease.bindServerTime(100001)).toThrow('clock is already bound')
  expect(lease.expiresAt).toBe(1790812801000)
  jest.setSystemTime(1790812800000 - 3600000)
  await jest.advanceTimersByTimeAsync(800)
  expect(lease.isOpen).toBe(false)
  expect(() => lease.now()).toThrow('expired')
  await lease.closed
  expect(jest.getTimerCount()).toBe(0)
})

test('close fences synchronously, drains the client operation and cancels the exact detached immutable tuple', async () => {
  const { transport, rpc } = remoteReaderFixture([])
  const lease = new RemoteSnapshotLease(transport, {})
  const original = request()
  const expected = { ...original }
  lease.own(original)
  original.nonce = 'b'.repeat(64)
  expect(() => lease.own(request())).toThrow('already owned')
  const entered = gate()
  const resume = gate()
  let signal: AbortSignal | undefined
  const pending = lease.run(async current => {
    signal = current
    entered.resolve()
    await resume.promise
    return 1
  })
  void pending.catch(() => undefined)
  try {
    await entered.promise
    await expect(lease.run(async () => 2)).rejects.toThrow('already has an operation')
    let closed = false
    const closing = lease.close()
    void closing.then(() => {
      closed = true
    })
    expect(lease.close()).toBe(closing)
    expect(lease.isOpen).toBe(false)
    expect(signal!.aborted).toBe(true)
    await Promise.resolve()
    expect(closed).toBe(false)
    expect(rpc).not.toHaveBeenCalled()
    resume.resolve()
    await expect(pending).rejects.toThrow('closed')
    await closing
    expect(closed).toBe(true)
    expect(rpc).toHaveBeenCalledWith(
      'cancelSnapshotArchiveRequest',
      [expect.objectContaining({ request: expected })],
      expect.any(AbortSignal)
    )
    expect(rpc).toHaveBeenCalledTimes(1)
  } finally {
    resume.resolve()
    await pending.catch(() => undefined)
    await lease.close()
  }
})

test('cancellation during polling drains the wait and clears both deadline and delay timers', async () => {
  jest.useFakeTimers()
  const { transport, rpc } = remoteReaderFixture([])
  const controller = new AbortController()
  const lease = new RemoteSnapshotLease(transport, { signal: controller.signal })
  lease.own(request())
  const pending = lease.wait(1000)
  void pending.catch(() => undefined)
  await Promise.resolve()
  controller.abort()
  await expect(pending).rejects.toThrow('cancelled')
  await lease.closed
  expect(jest.getTimerCount()).toBe(0)
  expect(rpc).toHaveBeenCalledTimes(1)
  expect(lease.isOpen).toBe(false)
})

test('failed remote cancellation remains observable through close and closed', async () => {
  const { transport } = remoteReaderFixture([])
  const error = new Error('synthetic durable cancellation failure')
  jest.spyOn(transport, 'cancelRequest').mockRejectedValue(error)
  const lease = new RemoteSnapshotLease(transport, {})
  lease.own(request())
  const closing = lease.close()
  await expect(closing).rejects.toBe(error)
  await expect(lease.closed).rejects.toBe(error)
  expect(lease.close()).toBe(closing)
  expect(lease.isOpen).toBe(false)
})

test('already-aborted acquisition never starts a request or leaves a timer behind', async () => {
  jest.useFakeTimers()
  const { transport, rpc } = remoteReaderFixture([])
  const controller = new AbortController()
  controller.abort()
  const lease = new RemoteSnapshotLease(transport, { signal: controller.signal })
  await expect(lease.run(async () => 1)).rejects.toThrow('cancelled')
  await lease.closed
  expect(rpc).not.toHaveBeenCalled()
  expect(jest.getTimerCount()).toBe(0)
})

test.each(['native', 'sdk', 'validation'] as const)(
  'lease expiry classifies %s transport settlement without suppressing independent validation failures',
  async kind => {
    jest.useFakeTimers()
    const { transport } = remoteReaderFixture([])
    const lease = new RemoteSnapshotLease(transport, { lifetimeMs: 10 })
    const entered = gate()
    const resume = gate()
    const failure =
      kind === 'native'
        ? new SnapshotArchiveTransportFailure(new Error('synthetic connection loss'))
        : kind === 'sdk'
          ? new SnapshotCancelledError('synthetic authenticated request cancelled')
          : new Error('synthetic authentication failure')
    const pending = lease.run(async () => {
      entered.resolve()
      await resume.promise
      throw failure
    })
    void pending.catch(() => undefined)
    try {
      await entered.promise
      await jest.advanceTimersByTimeAsync(10)
      expect(lease.isOpen).toBe(false)
      resume.resolve()
      if (kind === 'validation') await expect(pending).rejects.toBe(failure)
      else await expect(pending).rejects.toBeInstanceOf(SnapshotResourceLimitError)
      await lease.closed
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      resume.resolve()
      await pending.catch(() => undefined)
      await lease.close()
    }
  }
)

test('immutable operation recovery retains one slot, signal and fixed deadline', async () => {
  const { transport } = remoteReaderFixture([])
  const lease = new RemoteSnapshotLease(transport, {})
  const entered = gate()
  const resume = gate()
  const signals: AbortSignal[] = []
  const expiresAt = lease.expiresAt
  const operation = jest.fn(async (signal: AbortSignal) => {
    signals.push(signal)
    if (signals.length === 1) throw new SnapshotArchiveTransportFailure('synthetic loss')
    entered.resolve()
    await resume.promise
    return 7
  })
  const pending = lease.runIdempotent(operation)
  try {
    await entered.promise
    expect(operation).toHaveBeenCalledTimes(2)
    expect(signals[0]).toBe(signals[1])
    expect(signals[0].aborted).toBe(false)
    expect(lease.expiresAt).toBe(expiresAt)
    await expect(lease.run(async () => 2)).rejects.toThrow('already has an operation')
    resume.resolve()
    await expect(pending).resolves.toBe(7)
  } finally {
    resume.resolve()
    await pending.catch(() => undefined)
    await lease.close()
  }
})

test.each(['cancelled', 'expired'] as const)('a %s lease never starts its connection-loss retry', async kind => {
  jest.useFakeTimers()
  const { transport } = remoteReaderFixture([])
  const controller = new AbortController()
  const lease = new RemoteSnapshotLease(transport, { lifetimeMs: 10, signal: controller.signal })
  const operation = jest.fn(async () => {
    if (kind === 'cancelled') controller.abort()
    else jest.setSystemTime(Date.now() + 10)
    throw new SnapshotArchiveTransportFailure('synthetic loss')
  })
  await expect(lease.runIdempotent(operation)).rejects.toThrow(kind)
  expect(operation).toHaveBeenCalledTimes(1)
  await lease.closed
  expect(jest.getTimerCount()).toBe(0)
})

test('cleanup retries an identical cancellation once and retains a second transport failure', async () => {
  const { transport } = remoteReaderFixture([])
  const failure = new SnapshotArchiveTransportFailure('synthetic repeated loss')
  const cancel = jest.spyOn(transport, 'cancelRequest').mockRejectedValue(failure)
  const lease = new RemoteSnapshotLease(transport, {})
  lease.own(request())
  await expect(lease.close()).rejects.toBe(failure)
  await expect(lease.closed).rejects.toBe(failure)
  expect(cancel).toHaveBeenCalledTimes(2)
  expect(cancel.mock.calls[0][0]).toBe(cancel.mock.calls[1][0])
})

test.each(['timer', 'abort', 'deadline-check'] as const)(
  '%s automatic closure retains a failed cancellation receipt for its observer',
  async reason => {
    jest.useFakeTimers()
    const { transport } = remoteReaderFixture([])
    const controller = new AbortController()
    const failure = new Error('synthetic cancellation receipt failure')
    const cancel = jest.spyOn(transport, 'cancelRequest').mockRejectedValue(failure)
    const lease = new RemoteSnapshotLease(transport, { lifetimeMs: 10, signal: controller.signal })
    lease.own(request())
    if (reason === 'timer') await jest.advanceTimersByTimeAsync(10)
    else if (reason === 'abort') controller.abort()
    else {
      jest.setSystemTime(Date.now() + 10)
      expect(() => lease.assertOpen()).toThrow('expired')
    }
    await expect(lease.closed).rejects.toBe(failure)
    await expect(lease.close()).rejects.toBe(failure)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(jest.getTimerCount()).toBe(0)
  }
)

test.each([1, 3600000])('inclusive lifetime %p retains its exact deadline', async lifetimeMs => {
  jest.useFakeTimers({ now: 1790812800000 })
  const { transport } = remoteReaderFixture([])
  const lease = new RemoteSnapshotLease(transport, { lifetimeMs })
  expect(lease.lifetimeMs).toBe(lifetimeMs)
  expect(lease.expiresAt).toBe(1790812800000 + lifetimeMs)
  expect(lease.isOpen).toBe(true)
  await lease.close()
  expect(jest.getTimerCount()).toBe(0)
})

test('a nonzero monotonic origin and stalled timers cannot extend the fixed server clock or deadline', async () => {
  jest.useFakeTimers({ now: 1790812800000 })
  const monotonic = jest.spyOn(performance, 'now').mockReturnValue(4000)
  const { transport } = remoteReaderFixture([])
  const lease = new RemoteSnapshotLease(transport, { lifetimeMs: 1000 })
  monotonic.mockReturnValue(4125)
  lease.bindServerTime(100000)
  expect(lease.now()).toBe(100125)
  monotonic.mockReturnValue(4999)
  expect(lease.now()).toBe(100999)
  jest.setSystemTime(1790812800000 - 3600000)
  monotonic.mockReturnValue(5000)
  expect(() => lease.assertOpen()).toThrow('expired')
  await lease.closed
  expect(jest.getTimerCount()).toBe(0)
})

test('poll delay holds the operation until its exact duration without issuing remote work', async () => {
  jest.useFakeTimers()
  const { transport, rpc } = remoteReaderFixture([])
  const lease = new RemoteSnapshotLease(transport, { lifetimeMs: 1000 })
  let finished = false
  const waiting = lease.wait(100).then(() => {
    finished = true
  })
  await jest.advanceTimersByTimeAsync(99)
  expect(finished).toBe(false)
  await jest.advanceTimersByTimeAsync(1)
  await waiting
  expect(finished).toBe(true)
  expect(rpc).not.toHaveBeenCalled()
  await lease.close()
  expect(jest.getTimerCount()).toBe(0)
})
