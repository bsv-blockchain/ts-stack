import type { TrxToken } from '../../sdk/WalletStorage.interfaces'
import { retainReadSnapshot, type RetainedReadSnapshotLifetime } from './RetainedReadSnapshot'

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => {
    resolve = yes
  })
  return { promise, resolve }
}

const lifetimes: RetainedReadSnapshotLifetime[] = []
const gates: Array<ReturnType<typeof gate>> = []
const expectedFailures = new Set<unknown>()

function hold() {
  const value = gate()
  gates.push(value)
  return value
}

function fixture(
  options: Parameters<typeof retainReadSnapshot>[2] = {},
  controls: {
    acquire?: Promise<void>
    initialize?: Promise<void>
    cleanup?: Promise<void>
    initializeError?: Error
    beginError?: Error
    cleanupError?: Error
  } = {}
) {
  const token: TrxToken = { synthetic: true }
  const events: string[] = []
  const initializing = gate()
  const run = jest.fn(async (read: (trx: TrxToken) => Promise<void>) => {
    await controls.acquire
    events.push('acquired')
    try {
      if (controls.beginError) throw controls.beginError
      await read(token)
      events.push('commit')
    } finally {
      await controls.cleanup
      events.push('released')
    }
    if (controls.cleanupError) throw controls.cleanupError
  })
  const initialize = jest.fn(async (trx: TrxToken) => {
    expect(trx).toBe(token)
    events.push('initialize')
    initializing.resolve()
    await controls.initialize
    if (controls.initializeError) throw controls.initializeError
  })
  const lifetime = retainReadSnapshot(run, initialize, options)
  // Preserve the promise for assertions while ensuring failed-test cleanup
  // cannot create an unrelated unhandled rejection from a still-opening view.
  void lifetime.opened.catch(() => undefined)
  void lifetime.closed.catch(() => undefined)
  lifetimes.push(lifetime)
  return { token, events, run, initialize, initializing: initializing.promise, lifetime }
}

afterEach(async () => {
  gates.splice(0).forEach(value => value.resolve())
  const results = await Promise.allSettled(lifetimes.splice(0).map(value => value.close()))
  for (const result of results) {
    if (result.status === 'rejected') expect(expectedFailures.has(result.reason)).toBe(true)
  }
  expectedFailures.clear()
  jest.useRealTimers()
  jest.restoreAllMocks()
})

test('establishes the read view before opening and retains the exact token across idle boundaries', async () => {
  const initialize = hold()
  const f = fixture({}, { initialize: initialize.promise })
  let opened = false
  void f.lifetime.opened.then(
    () => {
      opened = true
    },
    () => undefined
  )
  await Promise.resolve()
  expect(opened).toBe(false)
  initialize.resolve()
  const view = await f.lifetime.opened
  expect(f.events).toEqual(['acquired', 'initialize'])
  expect(view.isOpen).toBe(true)
  expect(await view.read(async token => token)).toBe(f.token)
  await new Promise(resolve => setImmediate(resolve))
  expect(await view.read(async token => token)).toBe(f.token)
  await Promise.all([view.close(), view.close(), view.closed])
  expect(view.isOpen).toBe(false)
  expect(f.events).toEqual(['acquired', 'initialize', 'commit', 'released'])
  await expect(view.read(async () => 1)).rejects.toThrow('closed')
})

test('refuses concurrent and nested reads without queuing or invoking them', async () => {
  const f = fixture()
  const view = await f.lifetime.opened
  const releaseRead = hold()
  const first = view.read(async () => await releaseRead.promise)
  void first.catch(() => undefined)
  const extra = jest.fn(async () => 2)
  await expect(view.read(extra)).rejects.toThrow('read in flight')
  expect(extra).not.toHaveBeenCalled()
  releaseRead.resolve()
  await first
  await view.read(async () => {
    await expect(view.read(extra)).rejects.toThrow('read in flight')
  })
  expect(extra).not.toHaveBeenCalled()
})

test.each(['close', 'abort', 'expiry'] as const)(
  '%s discards a late read and retains capacity until physical read and cleanup both settle',
  async action => {
    jest.useFakeTimers()
    const controller = new AbortController()
    const releaseRead = hold()
    const cleanup = hold()
    const f = fixture({ lifetimeMs: 100, signal: controller.signal }, { cleanup: cleanup.promise })
    const view = await f.lifetime.opened
    let released = false
    void view.closed.then(
      () => {
        released = true
      },
      () => undefined
    )
    const pending = view.read(async () => {
      await releaseRead.promise
      return 'late bytes'
    })
    const outcome = pending.catch(error => error)
    if (action === 'close') void view.close().catch(() => undefined)
    if (action === 'abort') controller.abort()
    if (action === 'expiry') await jest.advanceTimersByTimeAsync(100)
    expect(view.isOpen).toBe(false)
    expect(released).toBe(false)
    expect(f.events).toEqual(['acquired', 'initialize'])
    const another = jest.fn(async () => 2)
    await expect(view.read(another)).rejects.toThrow(/closed|cancelled|expired/)
    expect(another).not.toHaveBeenCalled()
    releaseRead.resolve()
    expect(await outcome).toBeInstanceOf(Error)
    await Promise.resolve()
    expect(released).toBe(false)
    cleanup.resolve()
    await view.closed
    expect(f.events).toEqual(['acquired', 'initialize', 'commit', 'released'])
    expect(released).toBe(true)
    expect(jest.getTimerCount()).toBe(0)
  }
)

test.each(['acquire', 'initialize'] as const)(
  'cancelling during %s does not release an unsettled transaction',
  async phase => {
    const controller = new AbortController()
    const held = hold()
    const f = fixture({ signal: controller.signal }, { [phase]: held.promise })
    const opening = f.lifetime.opened.catch(error => error)
    let closed = false
    void f.lifetime.closed.then(
      () => {
        closed = true
      },
      () => undefined
    )
    if (phase === 'initialize') await f.initializing
    else await Promise.resolve()
    controller.abort()
    expect(await opening).toBeInstanceOf(Error)
    expect(closed).toBe(false)
    held.resolve()
    await f.lifetime.closed
    expect(closed).toBe(true)
    if (phase === 'acquire') expect(f.initialize).not.toHaveBeenCalled()
    expect(f.events.at(-1)).toBe('released')
  }
)

test('pre-cancelled views never acquire a connection', async () => {
  const controller = new AbortController()
  controller.abort()
  const f = fixture({ signal: controller.signal })
  await expect(f.lifetime.opened).rejects.toThrow('cancelled')
  await f.lifetime.closed
  expect(f.run).not.toHaveBeenCalled()
})

test.each([0, -1, 0.5, NaN, Infinity, 3_600_001])('refuses invalid lifetime %s before acquisition', lifetimeMs => {
  const run = jest.fn()
  expect(() => {
    const lifetime = retainReadSnapshot(run, async () => undefined, { lifetimeMs })
    void lifetime.opened.catch(() => undefined)
    void lifetime.closed.catch(() => undefined)
    lifetimes.push(lifetime)
  }).toThrow('an integer from 1 to 3600000')
  expect(run).not.toHaveBeenCalled()
})

test('monotonic expiry rejects a read even before its timer callback executes', async () => {
  const f = fixture({ lifetimeMs: 100 })
  const view = await f.lifetime.opened
  jest.spyOn(performance, 'now').mockReturnValue(Number.MAX_SAFE_INTEGER)
  const read = jest.fn(async () => 1)
  await expect(view.read(read)).rejects.toThrow('expired')
  expect(read).not.toHaveBeenCalled()
  await view.closed
})

test.each(['begin', 'initialize', 'read', 'cleanup'] as const)(
  'preserves %s errors and always finishes physical cleanup',
  async phase => {
    const error = new Error(`synthetic ${phase} failure`)
    expectedFailures.add(error)
    const f = fixture(
      {},
      {
        initializeError: phase === 'initialize' ? error : undefined,
        beginError: phase === 'begin' ? error : undefined,
        cleanupError: phase === 'cleanup' ? error : undefined
      }
    )
    if (phase === 'begin' || phase === 'initialize') {
      await expect(f.lifetime.opened).rejects.toBe(error)
    } else {
      const view = await f.lifetime.opened
      if (phase === 'read') {
        await expect(
          view.read(() => {
            throw error
          })
        ).rejects.toBe(error)
      } else {
        await expect(view.close()).rejects.toBe(error)
      }
    }
    await expect(f.lifetime.closed).rejects.toBe(error)
    expect(f.events.at(-1)).toBe('released')
  }
)

test('rejects an invalid callback without poisoning the retained view', async () => {
  const f = fixture()
  const view = await f.lifetime.opened
  await expect(view.read(undefined as never)).rejects.toThrow('callback')
  expect(await view.read(async () => 19)).toBe(19)
})

test('wall-clock expiry also covers suspension before the monotonic clock or timer advances', async () => {
  const f = fixture({ lifetimeMs: 100 })
  const view = await f.lifetime.opened
  jest.spyOn(Date, 'now').mockReturnValue(view.expiresAt)
  expect(view.isOpen).toBe(false)
  await expect(view.read(async () => 1)).rejects.toThrow('expired')
  await view.closed
})

test.each(['acquire', 'initialize'] as const)(
  'expiry during %s retains capacity through delayed physical cleanup',
  async phase => {
    jest.useFakeTimers()
    const held = hold()
    const f = fixture({ lifetimeMs: 100 }, { [phase]: held.promise })
    const opening = f.lifetime.opened.catch(error => error)
    let closed = false
    void f.lifetime.closed.then(
      () => {
        closed = true
      },
      () => undefined
    )
    if (phase === 'initialize') await f.initializing
    else await Promise.resolve()
    jest.advanceTimersByTime(100)
    expect(await opening).toEqual(expect.objectContaining({ message: expect.stringContaining('expired') }))
    expect(closed).toBe(false)
    held.resolve()
    await f.lifetime.closed
    expect(closed).toBe(true)
    expect(f.events.at(-1)).toBe('released')
  }
)

// Inclusive limits and default lifetime are part of the public admission contract.
test.each([1, 3_600_000, undefined])(
  'accepts the lifetime boundary %s and reports its exact expiry',
  async lifetimeMs => {
    jest.useFakeTimers()
    const start = Date.now()
    const f = fixture({ lifetimeMs })
    const view = await f.lifetime.opened
    expect(view.expiresAt).toBe(start + (lifetimeMs ?? 300_000))
    expect(view.isOpen).toBe(true)
    await view.close()
    expect(jest.getTimerCount()).toBe(0)
  }
)

test('monotonic expiry includes its exact boundary despite a backward wall-clock adjustment', async () => {
  const start = performance.now()
  jest.spyOn(performance, 'now').mockReturnValue(start)
  const f = fixture({ lifetimeMs: 100 })
  const view = await f.lifetime.opened
  jest.spyOn(Date, 'now').mockReturnValue(view.expiresAt - 500)
  jest.spyOn(performance, 'now').mockReturnValue(start + 100)
  await expect(view.read(async () => 1)).rejects.toThrow('expired')
  await view.closed
})

test('keeps the first stop reason across repeated cancellation and close, and removes its signal listener', async () => {
  const controller = new AbortController()
  const remove = jest.spyOn(controller.signal, 'removeEventListener')
  const f = fixture({ signal: controller.signal })
  const view = await f.lifetime.opened
  controller.abort()
  await view.close()
  await expect(view.read(async () => 1)).rejects.toThrow('cancelled')
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  expect(remove).toHaveBeenCalledTimes(1)
})

test('acquisition failure clears its expiry timer and removes its signal listener', async () => {
  jest.useFakeTimers()
  const controller = new AbortController()
  const remove = jest.spyOn(controller.signal, 'removeEventListener')
  const failure = new Error('acquire failed')
  expectedFailures.add(failure)
  const f = fixture({ signal: controller.signal }, { beginError: failure })
  await expect(f.lifetime.opened).rejects.toBe(failure)
  await expect(f.lifetime.closed).rejects.toBe(failure)
  expect(jest.getTimerCount()).toBe(0)
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
})

test('closing before consuming the opening promise remains observed and preserves the opening rejection', async () => {
  const lifetime = retainReadSnapshot(
    async read => await read({ synthetic: true }),
    async () => undefined
  )
  lifetimes.push(lifetime)
  // The owner may drain a cancelled opening before its opening consumer resumes.
  // Unlike fixture(), deliberately attach no observer to opened until a later turn.
  await lifetime.close()
  await new Promise(resolve => setImmediate(resolve))
  await expect(lifetime.opened).rejects.toThrow('closed')
})
