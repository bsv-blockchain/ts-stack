import { StorageAccessQueue } from './StorageAccessQueue'

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
