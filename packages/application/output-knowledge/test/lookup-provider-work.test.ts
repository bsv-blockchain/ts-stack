import fc from 'fast-check'
import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { PrivateKey, OutputProtocolError } from '@bsv/sdk'
import { LookupProviderWork, checkLookupWork } from '../src/lookup/LookupProviderWork.js'
import { LookupWake } from '../src/lookup/LookupWake.js'

// Attach rejection ownership immediately: an assertion failure must not leave
// an intentionally pending wait unhandled when fixture cleanup closes it.
function observed<T>(pending: Promise<T>): Promise<T> {
  void pending.catch(() => {})
  return pending
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

describe('bounded physical provider work and notification ownership', () => {
  it('retains capacity after cancellation until late physical work settles', async () => {
    const work = new LookupProviderWork(1, 1),
      abort = new AbortController()
    const pending = deferred<string>(),
      started = deferred<void>()
    const task = work.run(null, abort.signal, async () => {
      started.resolve()
      return await pending.promise
    })
    await started.promise
    abort.abort()
    await expect(task).rejects.toMatchObject({ code: 'cancelled' })
    await expect(work.run(null, undefined, async () => 'too soon')).rejects.toMatchObject({
      code: 'limited'
    })
    pending.reject(new Error('late physical failure'))
    for (let step = 0; step < 8; step++) await Promise.resolve()
    expect(await work.run(null, undefined, async () => 'recovered')).toBe('recovered')
  })

  it('bounds each principal independently and includes anonymous work in one shared quota', async () => {
    const work = new LookupProviderWork(2, 1),
      a = deferred<void>(),
      b = deferred<void>()
    const identity = new PrivateKey(2).toPublicKey().toString()
    const first = work.run(null, undefined, async () => await a.promise)
    await expect(work.run(null, undefined, async () => {})).rejects.toMatchObject({
      code: 'limited'
    })
    const second = work.run(identity, undefined, async () => await b.promise)
    await expect(
      work.run(new PrivateKey(3).toPublicKey().toString(), undefined, async () => {})
    ).rejects.toMatchObject({ code: 'limited' })
    a.resolve()
    b.resolve()
    await Promise.all([first, second])
    expect(await work.run(null, undefined, async () => 1)).toBe(1)
  })

  it('bounds caller time without releasing a non-cancellable physical request', async () => {
    jest.useFakeTimers()
    const work = new LookupProviderWork(1, 1, 20),
      physical = deferred<void>()
    const task = work.run(null, undefined, async () => await physical.promise)
    const checked = expect(task).rejects.toMatchObject({ code: 'unavailable', retryable: true })
    await jest.advanceTimersByTimeAsync(20)
    await checked
    await expect(work.run(null, undefined, async () => {})).rejects.toMatchObject({
      code: 'limited'
    })
    physical.resolve()
    await jest.advanceTimersByTimeAsync(0)
    expect(await work.run(null, undefined, async () => 'done')).toBe('done')
    expect(jest.getTimerCount()).toBe(0)
  })

  it('does not invoke physical work for an already cancelled caller', async () => {
    const signal = AbortSignal.abort(),
      action = jest.fn(async () => {})
    await expect(new LookupProviderWork().run(null, signal, action)).rejects.toMatchObject({
      code: 'cancelled'
    })
    expect(action).not.toHaveBeenCalled()
  })

  it('latches notifications between registration, durable read and sleep', async () => {
    jest.useFakeTimers()
    const wake = new LookupWake(1),
      signal = new AbortController().signal
    const first = wake.watch()
    expect(() => wake.watch()).toThrow('capacity')
    wake.notify()
    await first.wait(25000, signal)
    expect(jest.getTimerCount()).toBe(0)
    first.close()
    const second = wake.watch(),
      task = observed(second.wait(25000, signal))
    expect(jest.getTimerCount()).toBe(1)
    wake.notify()
    await task
    second.close()
    expect(jest.getTimerCount()).toBe(0)
  })

  it('cancels and closes waiters without consuming an event or retaining timers', async () => {
    jest.useFakeTimers()
    const wake = new LookupWake(1),
      abort = new AbortController(),
      first = wake.watch()
    const task = observed(first.wait(25000, abort.signal))
    abort.abort()
    await expect(task).rejects.toMatchObject({ code: 'cancelled' })
    first.close()
    const next = wake.watch(),
      waiting = observed(next.wait(25000, new AbortController().signal))
    next.close()
    await expect(waiting).rejects.toMatchObject({ code: 'cancelled' })
    expect(jest.getTimerCount()).toBe(0)
    await expect(next.wait(1, new AbortController().signal)).rejects.toMatchObject({
      code: 'invalid'
    })
  })

  it.each([
    [0, 1, 1],
    [1, 2, 1],
    [1, 1, 30001],
    [NaN, 1, 1]
  ])('rejects invalid work bounds %j', (a, b, c) => {
    expect(() => new LookupProviderWork(a, b, c)).toThrow('Invalid')
  })
})

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

it('retains exactly the configured physical slots over generated cancellation schedules', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.boolean(), { minLength: 1, maxLength: 4 }),
      async cancellations => {
        const work = new LookupProviderWork(cancellations.length, cancellations.length)
        const physical = cancellations.map(() => deferred<number>())
        const started = cancellations.map(() => deferred<void>())
        const controllers = cancellations.map(() => new AbortController())
        const settled = cancellations.map((_, i) =>
          work
            .run(null, controllers[i].signal, async () => {
              started[i].resolve()
              return await physical[i].promise
            })
            .then(
              value => ({ ok: true, value }),
              (error: unknown) => ({ ok: false, error })
            )
        )
        await Promise.all(started.map(x => x.promise))
        for (let i = 0; i < cancellations.length; i++) if (cancellations[i]) controllers[i].abort()
        await expect(work.run(null, undefined, async () => 0)).rejects.toMatchObject({
          code: 'limited'
        })
        for (let i = 0; i < physical.length; i++) physical[i].resolve(i)
        const results = await Promise.all(settled)
        for (let i = 0; i < results.length; i++) expect(results[i].ok).toBe(!cancellations[i])
        for (let i = 0; i < 8; i++) await Promise.resolve()
        expect(await work.run(null, undefined, async () => 'recovered')).toBe('recovered')
      }
    )
  )
})

describe('notification capacity, zero-wait and cleanup boundaries', () => {
  it('enforces bounded waiter configuration and classifies capacity exhaustion as retryable', () => {
    for (const maximum of [0, NaN, 1.5, 4097])
      expect(() => new LookupWake(maximum)).toThrow(
        expect.objectContaining({ code: 'invalid', message: 'Invalid lookup waiter capacity' })
      )
    expect(new LookupWake(4096).maximum).toBe(4096)
    const wake = new LookupWake(1),
      first = wake.watch()
    expect(() => wake.watch()).toThrow(
      expect.objectContaining({ code: 'limited', retryable: true })
    )
    first.close()
    wake.watch().close()
  })

  it('resolves zero waits without a timer and validates negative or non-finite waits', async () => {
    jest.useFakeTimers()
    const watch = new LookupWake().watch(),
      signal = new AbortController().signal
    try {
      for (const milliseconds of [NaN, Infinity, -1, 25001])
        await expect(watch.wait(milliseconds, signal)).rejects.toMatchObject({
          code: 'invalid',
          message: 'Invalid bounded lookup wait'
        })
      let completed = false
      const task = observed(
        watch.wait(0, signal).then(() => {
          completed = true
        })
      )
      await Promise.resolve()
      expect(completed).toBe(true)
      expect(jest.getTimerCount()).toBe(0)
      await task
    } finally {
      watch.close()
    }
  })

  it('does not permit overlapping waits and removes its abort listener after a notification', async () => {
    jest.useFakeTimers()
    const wake = new LookupWake(),
      watch = wake.watch(),
      abort = new AbortController()
    const remove = jest.spyOn(abort.signal, 'removeEventListener')
    const first = observed(watch.wait(25000, abort.signal))
    await expect(watch.wait(1, abort.signal)).rejects.toMatchObject({
      code: 'invalid',
      message: 'Lookup watch is closed or already waiting'
    })
    wake.notify()
    await first
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(jest.getTimerCount()).toBe(0)
    watch.close()
  })

  it('handles an abort that occurs while registering the listener without waiting for a timer', async () => {
    jest.useFakeTimers()
    const watch = new LookupWake().watch(),
      abort = new AbortController()
    const register = abort.signal.addEventListener.bind(abort.signal)
    jest.spyOn(abort.signal, 'addEventListener').mockImplementation((...args) => {
      abort.abort()
      register(...args)
    })
    await expect(watch.wait(25000, abort.signal)).rejects.toMatchObject({ code: 'cancelled' })
    expect(jest.getTimerCount()).toBe(0)
    watch.close()
  })
})

it('validates upper work bounds, preserves classified cancellation and rejects malformed principals', async () => {
  expect(() => new LookupProviderWork(4097, 1, 1)).toThrow(
    expect.objectContaining({
      code: 'invalid',
      message: 'Invalid lookup work capacity or deadline'
    })
  )
  expect(new LookupProviderWork(4096, 4096, 30000).maximum).toBe(4096)
  const custom = new OutputProtocolError('unavailable', 'classified interruption', true)
  expect(() => checkLookupWork(AbortSignal.abort(custom))).toThrow(custom)
  expect(() => checkLookupWork(AbortSignal.abort())).toThrow(
    expect.objectContaining({ code: 'cancelled', message: 'Lookup request cancelled' })
  )
  const operation = jest.fn(async () => 1)
  await expect(new LookupProviderWork().run('invalid', undefined, operation)).rejects.toMatchObject(
    { code: 'invalid' }
  )
  expect(operation).not.toHaveBeenCalled()
})

it('retains the other principal slot after one of two physical operations completes', async () => {
  const work = new LookupProviderWork(3, 2),
    one = deferred<void>(),
    two = deferred<void>(),
    three = deferred<void>()
  const first = observed(work.run(null, undefined, async () => await one.promise))
  const second = observed(work.run(null, undefined, async () => await two.promise))
  try {
    one.resolve()
    await first
    const third = observed(work.run(null, undefined, async () => await three.promise))
    await expect(work.run(null, undefined, async () => {})).rejects.toMatchObject({
      code: 'limited',
      retryable: true,
      message: 'Lookup physical work capacity is full'
    })
    two.resolve()
    three.resolve()
    await Promise.all([second, third])
    expect(await work.run(null, undefined, async () => 'available')).toBe('available')
  } finally {
    one.resolve()
    two.resolve()
    three.resolve()
  }
})

it('owns abort listeners across registration races and removes them after either outcome', async () => {
  const abort = new AbortController(),
    work = new LookupProviderWork(1, 1)
  const add = abort.signal.addEventListener.bind(abort.signal)
  const remove = jest.spyOn(abort.signal, 'removeEventListener')
  const register = jest.spyOn(abort.signal, 'addEventListener').mockImplementation((...args) => {
    abort.abort()
    add(...args)
  })
  const operation = jest.fn(async () => 'never')
  await expect(work.run(null, abort.signal, operation)).rejects.toMatchObject({
    code: 'cancelled',
    message: 'Lookup request cancelled'
  })
  expect(operation).not.toHaveBeenCalled()
  expect(register).toHaveBeenCalledWith('abort', expect.any(Function), { once: true })
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  for (let step = 0; step < 8; step++) await Promise.resolve()
  const ordinary = new AbortController(),
    cleanup = jest.spyOn(ordinary.signal, 'removeEventListener')
  expect(await work.run(null, ordinary.signal, async () => 7)).toBe(7)
  expect(cleanup).toHaveBeenCalledWith('abort', expect.any(Function))
})
