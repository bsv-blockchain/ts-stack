import { afterEach, expect, it, jest } from '@jest/globals'
import { schedulerFixture } from './root-eviction-scheduler-fixture.js'
import { rootAwaitStart, rootDeferred } from './root-eviction-service-fixture.js'
import { requester } from './root-eviction-fixture.js'
import { RootEvictionScheduler } from '../src/root-eviction/RootEvictionScheduler.js'

afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

it.each([
  ['pageSize', 0],
  ['pageSize', 65],
  ['pageSize', 1.5],
  ['maximum', 0],
  ['maximum', 65],
  ['intervalMs', 0],
  ['intervalMs', 60001],
  ['timeoutMs', 0],
  ['timeoutMs', 30001]
])('rejects invalid scheduler %s=%s', async (key, value) => {
  const f = await schedulerFixture()
  try {
    expect(() => f.worker({ [key]: value })).toThrow('bound')
  } finally {
    await f.cleanup()
  }
})

it('leaves manual work pending until expiry without closing caller storage', async () => {
  const f = await schedulerFixture()
  try {
    await f.retain()
    const worker = f.worker({ automatic: undefined })
    expect(await worker.runOnce()).toEqual({
      scanned: 1,
      expiredTargets: 0,
      started: 0,
      failures: []
    })
    f.state.now = '200'
    f.state.context = false
    f.state.access = false
    expect(await worker.runOnce()).toEqual({
      scanned: 1,
      expiredTargets: 1,
      started: 0,
      failures: []
    })
    expect(f.evaluate).not.toHaveBeenCalled()
    const result = await f.store.result(requester, 'scheduler_request_one', '200')
    expect(result.outcomes[0]).toMatchObject({
      actionStatus: 'rejected',
      reasonCode: 'request-expired'
    })
    await worker.stop()
    await expect(worker.runOnce()).rejects.toMatchObject({ code: 'cancelled' })
    expect(await f.store.head()).toBeDefined()
    expect(
      (await f.maintenance.pendingPage({ maximum: 1 }, f.options.maintenanceGuard)).value.digests
    ).toEqual([])
  } finally {
    await f.cleanup()
  }
})

it('recovers and applies only the installed policy under the retained revision', async () => {
  const f = await schedulerFixture()
  try {
    await f.retain()
    const worker = f.worker()
    expect(await worker.runOnce()).toEqual({
      scanned: 1,
      expiredTargets: 0,
      started: 1,
      failures: []
    })
    expect(
      (await f.store.result(requester, 'scheduler_request_one', '150')).outcomes[0]
    ).toMatchObject({ actionStatus: 'rejected', reasonCode: 'installed-review' })
    expect(f.evaluate).toHaveBeenCalledTimes(1)
    expect(await worker.runOnce()).toEqual({
      scanned: 0,
      expiredTargets: 0,
      started: 0,
      failures: []
    })
  } finally {
    await f.cleanup()
  }
})

it('cannot replace the observed revision or bypass changed context', async () => {
  const f = await schedulerFixture()
  try {
    await f.retain()
    f.evaluate.mockImplementation(async observed => {
      observed.head.revision = '99'
      f.state.context = false
      return [{ index: 0, disposition: 'accept', eligible: true, reasonCode: 'test' }]
    })
    expect((await f.worker().runOnce()).failures).toEqual([
      {
        digest: expect.any(String),
        phase: 'evaluation',
        error: expect.objectContaining({ code: 'context-changed' })
      }
    ])
    expect(
      (await f.store.result(requester, 'scheduler_request_one', '150')).outcomes[0].actionStatus
    ).toBe('pending')
    expect(await f.store.projections(64)).toEqual([])
  } finally {
    await f.cleanup()
  }
})

it('rejects changed policy before evaluation and independently expires the request', async () => {
  const f = await schedulerFixture()
  try {
    await f.retain()
    const worker = f.worker()
    f.state.policy = 'ab'.repeat(32)
    expect((await worker.runOnce()).failures[0].error).toMatchObject({ code: 'context-changed' })
    expect(f.evaluate).not.toHaveBeenCalled()
    f.state.now = '200'
    expect((await worker.runOnce()).expiredTargets).toBe(1)
  } finally {
    await f.cleanup()
  }
})

it('rotates deferred evaluation without starving later requests', async () => {
  const f = await schedulerFixture()
  try {
    for (let i = 0; i < 4; i++) await f.retain('scheduler_round_robin_' + i)
    f.evaluate.mockResolvedValue([])
    const worker = f.worker({ pageSize: 2 })
    for (let i = 0; i < 4; i++) expect((await worker.runOnce()).failures).toEqual([])
    expect(new Set(f.evaluate.mock.calls.map(([o]) => o.value.retained.digest)).size).toBe(4)
    expect(f.evaluate).toHaveBeenCalledTimes(4)
  } finally {
    await f.cleanup()
  }
})

it('retains physical capacity through timeout and drains before storage closes', async () => {
  const f = await schedulerFixture()
  const started = rootDeferred<void>(),
    release = rootDeferred<void>()
  let stopping: Promise<void> | undefined
  try {
    await f.retain('scheduler_slow_request')
    await f.retain('scheduler_other_request')
    f.evaluate.mockImplementation(async () => {
      started.resolve()
      await release.promise
      return []
    })
    const worker = f.worker({ timeoutMs: 20, pageSize: 1 })
    const pass = worker.runOnce()
    await rootAwaitStart(started.promise, pass)
    expect((await pass).failures[0].error).toMatchObject({ code: 'unavailable' })
    expect((await worker.runOnce()).started).toBe(0)
    expect(f.evaluate).toHaveBeenCalledTimes(1)
    f.state.now = '200'
    let expired = 0
    for (let i = 0; i < 3; i++) expired += (await worker.runOnce()).expiredTargets
    expect(expired).toBe(2)
    let drained = false
    stopping = worker.stop().then(() => {
      drained = true
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(drained).toBe(false)
    release.resolve()
    await stopping
    expect(drained).toBe(true)
    expect(await f.store.projections(64)).toEqual([])
  } finally {
    release.resolve()
    await stopping
    await f.cleanup()
  }
})

it('cancels in-progress evaluation before its final commit', async () => {
  const f = await schedulerFixture(),
    started = rootDeferred<void>(),
    release = rootDeferred<void>()
  try {
    await f.retain()
    f.evaluate.mockImplementation(async () => {
      started.resolve()
      await release.promise
      return [{ index: 0, disposition: 'accept', eligible: true, reasonCode: 'late' }]
    })
    const worker = f.worker(),
      pass = worker.runOnce()
    await rootAwaitStart(started.promise, pass)
    const stop = worker.stop()
    release.resolve()
    await stop
    expect((await pass).failures[0].error).toMatchObject({ code: 'cancelled' })
    expect(
      (await f.store.result(requester, 'scheduler_request_one', '150')).outcomes[0].actionStatus
    ).toBe('pending')
    expect(await f.store.projections(64)).toEqual([])
  } finally {
    release.resolve()
    await f.cleanup()
  }
})

it('recovers on startup and periodic scans without wake hints', async () => {
  const f = await schedulerFixture()
  let lifetime: Promise<void> | undefined
  try {
    const worker = f.worker({ automatic: undefined, intervalMs: 10 })
    const first = rootDeferred<void>(),
      second = rootDeferred<void>()
    const reports: number[] = []
    lifetime = worker.start(report => {
      reports.push(report.expiredTargets)
      first.resolve()
      if (report.expiredTargets === 1) second.resolve()
    })
    await rootAwaitStart(first.promise, lifetime)
    await f.retain()
    f.state.now = '200'
    await rootAwaitStart(second.promise, lifetime)
    await worker.stop()
    await lifetime
    expect(reports.reduce((a, b) => a + b, 0)).toBe(1)
  } finally {
    await f.cleanup()
    await lifetime
  }
})

it('stops the background loop and exposes observer failures', async () => {
  const f = await schedulerFixture()
  try {
    const worker = f.worker({ automatic: undefined })
    await expect(
      worker.start(() => {
        throw new Error('observer unavailable')
      })
    ).rejects.toThrow('observer unavailable')
    worker.wake()
    await expect(worker.runOnce()).rejects.toMatchObject({ code: 'cancelled' })
    await worker.stop()
  } finally {
    await f.cleanup()
  }
})

it('rejects non-durable ports and malformed installed policy before starting', async () => {
  const f = await schedulerFixture()
  try {
    expect(
      () =>
        new RootEvictionScheduler({
          ...f.options,
          maintenance: { ...f.maintenance, durability: 'volatile' } as never
        })
    ).toThrow('durable')
    expect(() => f.worker({ automatic: { ...f.automatic, policyDigest: 'bad' } })).toThrow()
    expect(() => f.worker({ automatic: { ...f.automatic, policyId: '' } })).toThrow()
  } finally {
    await f.cleanup()
  }
})

it('coalesces concurrent callers into one bounded maintenance scan', async () => {
  const f = await schedulerFixture(),
    release = rootDeferred<void>()
  try {
    const page = jest.spyOn(f.maintenance, 'pendingPage').mockImplementation(async () => {
      await release.promise
      return {
        value: { digests: [] },
        head: { revision: '0', policyDigest: f.state.policy },
        observedAt: '150'
      }
    })
    const worker = f.worker({ automatic: undefined })
    const first = worker.runOnce(),
      second = worker.runOnce()
    expect(page).toHaveBeenCalledTimes(1)
    release.resolve()
    expect(await first).toEqual(await second)
    expect(page).toHaveBeenCalledTimes(1)
  } finally {
    release.resolve()
    await f.cleanup()
  }
})

it('coalesces wake hints and interrupts the periodic wait promptly', async () => {
  const f = await schedulerFixture()
  let lifetime: Promise<void> | undefined
  try {
    const worker = f.worker({ automatic: undefined, intervalMs: 60000 })
    const first = rootDeferred<void>(),
      second = rootDeferred<void>()
    let passes = 0
    lifetime = worker.start(() => {
      passes++
      if (passes === 1) first.resolve()
      else second.resolve()
    })
    await rootAwaitStart(first.promise, lifetime)
    worker.wake()
    worker.wake()
    worker.wake()
    await rootAwaitStart(second.promise, lifetime)
    await worker.stop()
    await lifetime
    expect(passes).toBe(2)
    await expect(worker.start(() => {})).rejects.toMatchObject({ code: 'cancelled' })
  } finally {
    await f.cleanup()
    await lifetime
  }
})

it('reports expiry failures without applying a decision and exposes scan failures', async () => {
  const f = await schedulerFixture()
  try {
    await f.retain()
    const expiry = jest
      .spyOn(f.maintenance, 'expirePending')
      .mockRejectedValue(new Error('storage unavailable'))
    const worker = f.worker()
    const report = await worker.runOnce()
    expect(report.started).toBe(0)
    expect(report.failures).toHaveLength(2)
    expect(report.failures.every(item => item.phase === 'expiry')).toBe(true)
    expect(f.evaluate).not.toHaveBeenCalled()
    expiry.mockRestore()
    jest.spyOn(f.maintenance, 'pendingPage').mockRejectedValue(new Error('scan unavailable'))
    await expect(worker.runOnce()).rejects.toThrow('scan unavailable')
  } finally {
    await f.cleanup()
  }
})

it('rechecks current authority inside the commit after asynchronous evaluation', async () => {
  const f = await schedulerFixture()
  try {
    await f.retain()
    f.evaluate.mockImplementation(async () => {
      f.state.access = false
      return [{ index: 0, disposition: 'accept', eligible: true, reasonCode: 'late-access' }]
    })
    expect((await f.worker().runOnce()).failures[0].error).toMatchObject({ code: 'not-found' })
    expect(await f.store.projections(64)).toEqual([])
  } finally {
    await f.cleanup()
  }
})

it('rejects asynchronous commit callbacks even when their declared result looks authorized', async () => {
  const f = await schedulerFixture()
  try {
    await f.retain()
    const original = await f.guard()
    f.guard.mockResolvedValue({ ...original, authorize: (async () => true) as never })
    expect((await f.worker().runOnce()).failures[0].error).toMatchObject({
      message: 'Root scheduler callbacks must be synchronous'
    })
    expect(f.evaluate).not.toHaveBeenCalled()
  } finally {
    await f.cleanup()
  }
})

it('awaits asynchronous observation and exposes its rejection without detached work', async () => {
  const f = await schedulerFixture(),
    started = rootDeferred<void>(),
    release = rootDeferred<void>()
  try {
    const worker = f.worker({ automatic: undefined })
    const lifetime = worker.start(async () => {
      started.resolve()
      await release.promise
      throw new Error('asynchronous observer unavailable')
    })
    const failure = expect(lifetime).rejects.toThrow('asynchronous observer unavailable')
    await rootAwaitStart(started.promise, lifetime)
    let stopped = false
    const drain = worker.stop().then(() => {
      stopped = true
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(stopped).toBe(false)
    release.resolve()
    await failure
    await drain
    expect(stopped).toBe(true)
  } finally {
    release.resolve()
    await f.cleanup()
  }
})

it('requires durable recovery as well as durable maintenance', async () => {
  const f = await schedulerFixture()
  try {
    expect(() =>
      f.worker({
        automatic: { ...f.automatic, journal: { ...f.store, durability: 'volatile' } as never }
      })
    ).toThrow('Root recovery must be durable')
  } finally {
    await f.cleanup()
  }
})

it('does not start a second lifetime loop or replace its observer', async () => {
  const f = await schedulerFixture(),
    entered = rootDeferred<void>(),
    release = rootDeferred<void>()
  try {
    const worker = f.worker({ automatic: undefined })
    const firstObserver = jest.fn(async () => {
      entered.resolve()
      await release.promise
    })
    const otherObserver = jest.fn(() => {})
    const first = worker.start(firstObserver)
    await rootAwaitStart(entered.promise, first)
    const other = worker.start(otherObserver)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(firstObserver).toHaveBeenCalledTimes(1)
    expect(otherObserver).not.toHaveBeenCalled()
    release.resolve()
    await worker.stop()
    await Promise.all([first, other])
  } finally {
    release.resolve()
    await f.cleanup()
  }
})

it('preserves a wake received during report handling without waiting for the periodic timer', async () => {
  const f = await schedulerFixture()
  jest.useFakeTimers()
  try {
    const worker = f.worker({ automatic: undefined, intervalMs: 60000 })
    let passes = 0
    const lifetime = worker.start(() => {
      passes++
      if (passes === 1) worker.wake()
    })
    await jest.advanceTimersByTimeAsync(0)
    expect(passes).toBe(2)
    await worker.stop()
    await lifetime
    expect(jest.getTimerCount()).toBe(0)
  } finally {
    await f.cleanup()
    jest.useRealTimers()
  }
})

it('stops between maintenance items and waits for the already-started storage call', async () => {
  const f = await schedulerFixture(),
    entered = rootDeferred<void>(),
    release = rootDeferred<void>()
  try {
    await f.retain('scheduler_stop_first_request')
    await f.retain('scheduler_stop_second_request')
    f.state.now = '200'
    const original = f.maintenance.expirePending.bind(f.maintenance)
    const expiry = jest
      .spyOn(f.maintenance, 'expirePending')
      .mockImplementation(async (...args) => {
        entered.resolve()
        await release.promise
        return await original(...args)
      })
    const worker = f.worker({ automatic: undefined }),
      pass = worker.runOnce()
    await rootAwaitStart(entered.promise, pass)
    const drain = worker.stop()
    release.resolve()
    await drain
    expect((await pass).expiredTargets).toBe(1)
    expect(expiry).toHaveBeenCalledTimes(1)
    expect(
      (await f.maintenance.pendingPage({ maximum: 64 }, f.options.maintenanceGuard)).value.digests
    ).toHaveLength(1)
  } finally {
    release.resolve()
    await f.cleanup()
  }
})

it('does not duplicate a still-running digest when other physical capacity is available', async () => {
  const f = await schedulerFixture(),
    entered = rootDeferred<void>(),
    release = rootDeferred<void>()
  try {
    await f.retain()
    f.evaluate.mockImplementation(async () => {
      entered.resolve()
      await release.promise
      return []
    })
    const worker = f.worker({ maximum: 2, timeoutMs: 20 })
    const pass = worker.runOnce()
    await rootAwaitStart(entered.promise, pass)
    expect((await pass).failures[0].error).toMatchObject({
      code: 'unavailable',
      message: 'Root evaluation deadline reached'
    })
    expect((await worker.runOnce()).started).toBe(0)
    expect(f.evaluate).toHaveBeenCalledTimes(1)
    release.resolve()
    await worker.stop()
  } finally {
    release.resolve()
    await f.cleanup()
  }
})

it('does not evaluate work that expires between discovery and its evaluation expiry check', async () => {
  const f = await schedulerFixture()
  try {
    await f.retain()
    const original = f.maintenance.pendingPage.bind(f.maintenance)
    let pages = 0
    jest.spyOn(f.maintenance, 'pendingPage').mockImplementation(async (...args) => {
      const result = await original(...args)
      if (++pages === 2) f.state.now = '200'
      return result
    })
    const report = await f.worker().runOnce()
    expect(report).toEqual({ scanned: 1, expiredTargets: 1, started: 0, failures: [] })
    expect(f.evaluate).not.toHaveBeenCalled()
  } finally {
    await f.cleanup()
  }
})

it('classifies a missing commit callback before attempting journal recovery', async () => {
  const f = await schedulerFixture()
  try {
    await f.retain()
    f.guard.mockResolvedValue({ ...(await f.guard()), authorize: undefined as never })
    expect((await f.worker().runOnce()).failures[0].error).toMatchObject({
      message: 'Root scheduler callbacks must be synchronous'
    })
    expect(f.evaluate).not.toHaveBeenCalled()
  } finally {
    await f.cleanup()
  }
})
