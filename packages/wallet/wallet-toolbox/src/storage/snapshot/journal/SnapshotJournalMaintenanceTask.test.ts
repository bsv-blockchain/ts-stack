import { getEventListeners } from 'node:events'
import { runSnapshotJournalMaintenanceTask as run } from './SnapshotJournalMaintenanceTask'
import { WERR_INVALID_PARAMETER } from '../../../sdk/WERR_errors'
import { SnapshotCancelledError } from '../SnapshotCancelledError'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'

function gate() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
async function pending(promise: Promise<unknown>) {
  let settled = false
  void promise.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(settled).toBe(false)
}
afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

test('invalid lifetimes refuse before allocating native work', () => {
  for (const lifetimeMs of [0, -1, 1.5, NaN, Infinity, 30001, '100']) {
    let allocated = false
    expect(() =>
      run(
        async () => {
          allocated = true
        },
        { lifetimeMs: lifetimeMs as number }
      )
    ).toThrow(WERR_INVALID_PARAMETER)
    expect(() => run(async () => undefined, { lifetimeMs: lifetimeMs as number })).toThrow(
      'The lifetimeMs parameter must be an integer from 1 to 30000'
    )
    expect(allocated).toBe(false)
  }
})
test('already aborted work never enters the native callback', async () => {
  jest.useFakeTimers()
  let allocated = false
  const task = run(
    async () => {
      allocated = true
    },
    { signal: AbortSignal.abort() }
  )
  await expect(task.result).rejects.toBeInstanceOf(SnapshotCancelledError)
  await task.closed
  await task.close()
  expect(allocated).toBe(false)
  expect(jest.getTimerCount()).toBe(0)
})
test.each([1, 30000])('admits exact lifetime boundary %i and releases its timer and listener', async lifetimeMs => {
  jest.useFakeTimers()
  const controller = new AbortController()
  const task = run(async () => 23, { signal: controller.signal, lifetimeMs })
  expect(jest.getTimerCount()).toBe(1)
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1)
  expect(await task.result).toBe(23)
  await task.closed
  expect(jest.getTimerCount()).toBe(0)
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  await Promise.all([task.close(), task.close()])
  controller.abort()
  expect(await task.result).toBe(23)
  expect(jest.getTimerCount()).toBe(0)
})
test('cancellation detaches result-lifetime resources while native cleanup remains owned', async () => {
  jest.useFakeTimers()
  const controller = new AbortController(),
    entered = gate(),
    drain = gate()
  let physicallyClosed = false
  const task = run(
    async active => {
      entered.resolve()
      await drain.promise
      physicallyClosed = true
      active()
    },
    { signal: controller.signal }
  )
  await entered.promise
  expect(jest.getTimerCount()).toBe(1)
  controller.abort()
  await expect(task.result).rejects.toBeInstanceOf(SnapshotCancelledError)
  expect(jest.getTimerCount()).toBe(0)
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  expect(physicallyClosed).toBe(false)
  drain.resolve()
  await task.closed
  expect(physicallyClosed).toBe(true)
})
test('the first cancellation reason remains exact through repeated close and native drain', async () => {
  const controller = new AbortController(),
    entered = gate(),
    drain = gate()
  let nativeStop: unknown
  const task = run(
    async active => {
      entered.resolve()
      await drain.promise
      try {
        active()
      } catch (error) {
        nativeStop = error
        throw error
      }
    },
    { signal: controller.signal }
  )
  await entered.promise
  controller.abort()
  const reason = await task.result.catch(error => error as unknown)
  expect(reason).toBeInstanceOf(SnapshotCancelledError)
  const closing = Promise.all([task.close(), task.close()])
  drain.resolve()
  await closing
  expect(nativeStop).toBe(reason)
  expect(await task.result.catch(error => error as unknown)).toBe(reason)
})
test('normal results and closure wait for physical cleanup and close remains idempotent', async () => {
  const cleanup = gate()
  const task = run(async () => {
    await cleanup.promise
    return 23
  })
  await pending(task.result)
  await pending(task.closed)
  cleanup.resolve()
  expect(await task.result).toBe(23)
  await task.closed
  await Promise.all([task.close(), task.close()])
})
test('cancellation rejects promptly but native drain owns closure', async () => {
  const cleanup = gate(),
    entered = gate(),
    controller = new AbortController()
  const task = run(
    async active => {
      entered.resolve()
      await cleanup.promise
      active()
      return 'late'
    },
    { signal: controller.signal }
  )
  await entered.promise
  controller.abort()
  await expect(task.result).rejects.toBeInstanceOf(SnapshotCancelledError)
  await pending(task.closed)
  const closing = task.close()
  await pending(closing)
  cleanup.resolve()
  await closing
})
test('expiry discards late results without releasing before native drain', async () => {
  const cleanup = gate(),
    entered = gate()
  const task = run(
    async () => {
      entered.resolve()
      await cleanup.promise
      return 'late'
    },
    { lifetimeMs: 20 }
  )
  await entered.promise
  const error = await task.result.catch(error => error as unknown)
  expect(error).toBeInstanceOf(SnapshotResourceLimitError)
  expect(error).toMatchObject({ message: 'Snapshot journal maintenance expired' })
  await pending(task.closed)
  cleanup.resolve()
  await task.closed
})
test('wall and monotonic deadlines independently refuse late results', async () => {
  for (const clock of ['wall', 'monotonic']) {
    const wall = Date.now()
    let now = wall,
      monotonic = 100
    jest.spyOn(Date, 'now').mockImplementation(() => now)
    jest.spyOn(performance, 'now').mockImplementation(() => monotonic)
    const cleanup = gate(),
      entered = gate()
    const task = run(
      async () => {
        entered.resolve()
        await cleanup.promise
        return 'late'
      },
      { lifetimeMs: 1000 }
    )
    await entered.promise
    if (clock === 'wall') now += 1000
    else {
      now -= 100000
      monotonic += 1000
    }
    cleanup.resolve()
    const error = await task.result.catch(error => error as unknown)
    expect(error).toBeInstanceOf(SnapshotResourceLimitError)
    expect(error).toMatchObject({ message: 'Snapshot journal maintenance expired' })
    await task.closed
    jest.restoreAllMocks()
  }
})
test('post-commit cancellation does not claim rollback of durable state', async () => {
  const cleanup = gate(),
    committed = gate(),
    controller = new AbortController()
  let floor = 0
  const task = run(
    async () => {
      floor = 8
      committed.resolve()
      await cleanup.promise
      return floor
    },
    { signal: controller.signal }
  )
  await committed.promise
  controller.abort()
  await expect(task.result).rejects.toBeInstanceOf(SnapshotCancelledError)
  await pending(task.closed)
  expect(floor).toBe(8)
  cleanup.resolve()
  await task.closed
  expect(floor).toBe(8)
})
test('unrelated native cleanup errors remain observable after cancellation', async () => {
  const cleanup = gate(),
    entered = gate(),
    controller = new AbortController(),
    error = new Error('native close failure')
  const task = run(
    async () => {
      entered.resolve()
      await cleanup.promise
    },
    { signal: controller.signal }
  )
  await entered.promise
  controller.abort()
  await expect(task.result).rejects.toBeInstanceOf(SnapshotCancelledError)
  cleanup.reject(error)
  await expect(task.closed).rejects.toBe(error)
  await expect(task.close()).rejects.toBe(error)
})
test('ordinary source failure including undefined cannot match an unset cancellation', async () => {
  for (const error of [new Error('source failure'), undefined]) {
    const task = run(async () => {
      throw error
    })
    const outcomes = await Promise.allSettled([task.result, task.closed])
    expect(outcomes).toEqual([
      { status: 'rejected', reason: error },
      { status: 'rejected', reason: error }
    ])
  }
})
test('early manual close refuses allocation and repeated close drains the same owner', async () => {
  let allocated = false
  const task = run(async () => {
    allocated = true
  })
  await Promise.all([task.close(), task.close()])
  await expect(task.result).rejects.toThrow('closed')
  expect(allocated).toBe(false)
})
async function executeSchedule(stage: number, index: number): Promise<void> {
  const controller = new AbortController(),
    entered = gate(),
    commit = gate(),
    committed = gate(),
    drain = gate()
  let durable = false,
    allocated = false
  const task = run(
    async active => {
      allocated = true
      entered.resolve()
      await commit.promise
      active()
      durable = true
      committed.resolve()
      await drain.promise
      return index
    },
    { signal: controller.signal }
  )
  if (stage === 0) controller.abort()
  else {
    await entered.promise
    if (stage === 1) controller.abort()
    commit.resolve()
    if (stage >= 2) {
      await committed.promise
      if (stage === 2) controller.abort()
    }
    if (stage !== 1) await pending(task.closed)
  }
  drain.resolve()
  const outcome = await task.result.then(
    value => ({ value }),
    error => ({ error: error as unknown })
  )
  await task.closed
  if (stage === 3) expect(outcome).toEqual({ value: index })
  else expect(outcome).toEqual({ error: expect.any(SnapshotCancelledError) })
  expect(allocated).toBe(stage !== 0)
  expect(durable).toBe(stage >= 2)
}

test('300 seeded cancellation/commit/drain schedules retain ownership', async () => {
  let seed = 3242026
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed
  }
  for (let index = 0; index < 300; index++) await executeSchedule(random() % 4, index)
})
