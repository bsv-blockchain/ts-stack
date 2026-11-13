import { StorageAccessQueue } from './StorageAccessQueue'
import { StorageAccessQueueLimitError } from './StorageAccessQueueLimitError'
import { StorageAccessCancelledError } from './StorageAccessCancelledError'

test('shares bounded reads, fences writers and does not let later readers starve a writer', async () => {
  const queue = new StorageAccessQueue()
  const readers = await Promise.all(Array.from({ length: 8 }, async () => await queue.acquire('read')))
  let writerStarted = false
  const writer = queue.acquire('exclusive').then(release => {
    writerStarted = true
    return release
  })
  let laterStarted = false
  const later = queue.acquire('read').then(release => {
    laterStarted = true
    return release
  })
  await Promise.resolve()
  expect(writerStarted).toBe(false)
  for (const release of readers.slice(0, 7)) release()
  await Promise.resolve()
  expect(writerStarted).toBe(false)
  readers[7]()
  const releaseWriter = await writer
  expect(laterStarted).toBe(false)
  releaseWriter()
  const releaseLater = await later
  expect(laterStarted).toBe(true)
  releaseLater()
  // A duplicate completion cannot release another operation's ownership.
  releaseWriter()
  releaseLater()
  const next = await queue.acquire('exclusive')
  next()
})

test('admits at most eight concurrent readers', async () => {
  const queue = new StorageAccessQueue()
  const readers = await Promise.all(Array.from({ length: 8 }, async () => await queue.acquire('read')))
  let started = false
  const ninth = queue.acquire('read').then(release => {
    started = true
    return release
  })
  await Promise.resolve()
  expect(started).toBe(false)
  readers[0]()
  const release = await ninth
  for (const done of readers) done()
  release()
})

test('rejects overflow without replacing admitted FIFO work and reuses a cancelled slot', async () => {
  const queue = new StorageAccessQueue(2),
    controller = new AbortController(),
    reason = new Error('cancel queued')
  const owner = await queue.acquire('exclusive'),
    order: string[] = []
  const first = queue.acquire('exclusive', 'foreground', controller.signal)
  const cancelled = expect(first).rejects.toMatchObject({ signal: controller.signal, cause: reason })
  const second = queue.acquire('exclusive').then(release => {
    order.push('second')
    release()
  })
  await expect(queue.acquire('exclusive')).rejects.toBeInstanceOf(StorageAccessQueueLimitError)
  controller.abort(reason)
  await cancelled
  const third = queue.acquire('exclusive').then(release => {
    order.push('third')
    release()
  })
  owner()
  await Promise.all([second, third])
  expect(order).toEqual(['second', 'third'])
})

test('cancelling the queued writer removes its fence but never releases the active reader', async () => {
  const queue = new StorageAccessQueue(),
    controller = new AbortController()
  const reader = await queue.acquire('read')
  const writer = queue.acquire('exclusive', 'foreground', controller.signal)
  const rejected = expect(writer).rejects.toBeInstanceOf(StorageAccessCancelledError)
  let laterGranted = false
  const later = queue.acquire('read').then(release => {
    laterGranted = true
    return release
  })
  await Promise.resolve()
  expect(laterGranted).toBe(false)
  controller.abort()
  await rejected
  const releaseLater = await later
  expect(laterGranted).toBe(true)
  let exclusiveGranted = false
  const next = queue.acquire('exclusive').then(release => {
    exclusiveGranted = true
    return release
  })
  releaseLater()
  await Promise.resolve()
  expect(exclusiveGranted).toBe(false)
  reader()
  const releaseNext = await next
  releaseNext()
})

test('abort after admission cannot release the original owner and pre-aborted admission uses no slot', async () => {
  const queue = new StorageAccessQueue(1),
    controller = new AbortController()
  const owner = await queue.acquire('exclusive', 'foreground', controller.signal)
  controller.abort()
  await expect(queue.acquire('read', 'foreground', controller.signal)).rejects.toBeInstanceOf(
    StorageAccessCancelledError
  )
  let started = false
  const next = queue.acquire('exclusive').then(release => {
    started = true
    return release
  })
  await Promise.resolve()
  expect(started).toBe(false)
  owner()
  const release = await next
  release()
})

test.each([0, -1, 1.5, NaN, Infinity, 65537])('refuses an invalid pending limit %s before admission', maximum => {
  expect(() => new StorageAccessQueue(maximum)).toThrow(StorageAccessQueueLimitError)
})

test('bounds requests before asynchronous initialization and duplicate departure cannot release another request', () => {
  const queue = new StorageAccessQueue(1),
    original = Array.from({ length: 9 }, () => queue.admit())
  expect(() => queue.admit()).toThrow(StorageAccessQueueLimitError)
  original[0]()
  original[0]()
  const next = queue.admit()
  expect(() => queue.admit()).toThrow(StorageAccessQueueLimitError)
  original.slice(1).forEach(leave => leave())
  next()
  next()
  const fresh = Array.from({ length: 9 }, () => queue.admit())
  fresh.forEach(leave => leave())
})

test('prefers foreground work while guaranteeing a waiting background page within eight grants', async () => {
  const queue = new StorageAccessQueue()
  const unblock = await queue.acquire('exclusive')
  const order: string[] = []
  const background = queue.acquire('exclusive', 'background').then(release => {
    order.push('background')
    release()
  })
  const foreground = Array.from({ length: 20 }, (_, index) =>
    queue.acquire('exclusive').then(release => {
      order.push(`foreground ${index}`)
      release()
    })
  )
  unblock()
  await Promise.all([background, ...foreground])
  expect(order[0]).toBe('foreground 0')
  expect(order.indexOf('background')).toBeLessThanOrEqual(8)
  expect(order.filter(item => item !== 'background')).toEqual(
    Array.from({ length: 20 }, (_, index) => `foreground ${index}`)
  )
})

test('ages a background page ahead of newly queued foreground work', async () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(1000)
  try {
    const queue = new StorageAccessQueue()
    const unblock = await queue.acquire('exclusive')
    const order: string[] = []
    const background = queue.acquire('exclusive', 'background').then(release => {
      order.push('background')
      release()
    })
    now.mockReturnValue(2001)
    const foreground = queue.acquire('exclusive').then(release => {
      order.push('foreground')
      release()
    })
    unblock()
    await Promise.all([background, foreground])
    expect(order).toEqual(['background', 'foreground'])
  } finally {
    now.mockRestore()
  }
})

test.each(['foreground', 'background'] as const)('retains FIFO order with only %s waiters', async priority => {
  const queue = new StorageAccessQueue()
  const unblock = await queue.acquire('exclusive')
  const order: number[] = []
  const waiting = Array.from({ length: 12 }, (_, index) =>
    queue.acquire('exclusive', priority).then(release => {
      order.push(index)
      release()
    })
  )
  unblock()
  await Promise.all(waiting)
  expect(order).toEqual(Array.from({ length: 12 }, (_, index) => index))
})

test('finds an aged background waiter behind the foreground head', async () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(1000)
  try {
    const queue = new StorageAccessQueue()
    const unblock = await queue.acquire('exclusive')
    const order: string[] = []
    const waiting = (['foreground', 'background', 'foreground'] as const).map((priority, index) =>
      queue.acquire('exclusive', priority).then(release => {
        order.push(`${priority} ${index}`)
        release()
      })
    )
    now.mockReturnValue(2000)
    unblock()
    await Promise.all(waiting)
    expect(order).toEqual(['background 1', 'foreground 0', 'foreground 2'])
  } finally {
    now.mockRestore()
  }
})
