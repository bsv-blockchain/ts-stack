import { promiseFromSync, awaitFromSync, awaitVoidFromSync, mapAwaitFromSync } from './promiseFromSync'

test('runs immediately and publishes its result through a fresh promise', async () => {
  const order: string[] = []
  const value = promiseFromSync(() => {
    order.push('work')
    return 42
  })
  order.push('returned')
  void value.then(() => order.push('settled'))
  expect(order).toEqual(['work', 'returned'])
  await expect(value).resolves.toBe(42)
  expect(order).toEqual(['work', 'returned', 'settled'])
})

test('preserves the original synchronous failure as a rejected promise', async () => {
  const cause = new Error('original synchronous failure')
  let pending: Promise<never> | undefined
  expect(() => {
    pending = promiseFromSync(() => {
      throw cause
    })
  }).not.toThrow()
  await expect(pending).rejects.toBe(cause)
})

test('adopts returned promises without returning their identity', async () => {
  const original = Promise.resolve(17)
  const wrapped = promiseFromSync(() => original)
  expect(wrapped).not.toBe(original)
  await expect(wrapped).resolves.toBe(17)
  const cause = new Error('original asynchronous failure')
  await expect(promiseFromSync(() => Promise.reject(cause))).rejects.toBe(cause)
  await expect(promiseFromSync(() => undefined)).resolves.toBeUndefined()
})

test('shared await forwarding preserves native async callback ordering and failures', async () => {
  async function observe(forward: (work: () => PromiseLike<number> | number) => Promise<number>) {
    const order: string[] = []
    const pending = forward(() => {
      order.push('invoked')
      return Promise.resolve(23).then(value => {
        order.push('adopted')
        return value
      })
    })
    order.push('returned')
    void pending.then(() => order.push('settled'))
    queueMicrotask(() => order.push('microtask'))
    await pending
    return order
  }
  const original = async (work: () => PromiseLike<number> | number) => await work()
  expect(await observe(awaitFromSync)).toEqual(await observe(original))
  const cause = new Error('same failure')
  let pending: Promise<never> | undefined
  expect(() => {
    pending = awaitFromSync(() => {
      throw cause
    })
  }).not.toThrow()
  await expect(pending).rejects.toBe(cause)
  const value = Promise.resolve(7)
  expect(awaitFromSync(() => value)).not.toBe(value)
})

test('void forwarding waits for completion and discards its resolved value', async () => {
  let complete = false
  const pending = awaitVoidFromSync(() =>
    Promise.resolve(11).then(value => {
      complete = true
      return value
    })
  )
  expect(complete).toBe(false)
  await expect(pending).resolves.toBeUndefined()
  expect(complete).toBe(true)
  const cause = new Error('original void failure')
  await expect(
    awaitVoidFromSync(() => {
      throw cause
    })
  ).rejects.toBe(cause)
})

test('mapped continuation preserves the original single-await ordering and failures', async () => {
  async function observe(forward: (work: () => Promise<number>, next: (value: number) => number) => Promise<number>) {
    const order: string[] = []
    const pending = forward(
      () => {
        order.push('work')
        return Promise.resolve(7)
      },
      value => {
        order.push('continuation')
        return value + 1
      }
    )
    order.push('returned')
    void pending.then(() => order.push('settled'))
    queueMicrotask(() => order.push('microtask'))
    expect(await pending).toBe(8)
    return order
  }
  const original = async (work: () => Promise<number>, next: (value: number) => number) => {
    const value = await work()
    return next(value)
  }
  expect(await observe(mapAwaitFromSync)).toEqual(await observe(original))
  const failure = new Error('original stage failure')
  const next = jest.fn()
  await expect(
    mapAwaitFromSync(() => {
      throw failure
    }, next)
  ).rejects.toBe(failure)
  await expect(mapAwaitFromSync(() => Promise.reject(failure), next)).rejects.toBe(failure)
  expect(next).not.toHaveBeenCalled()
  await expect(
    mapAwaitFromSync(
      () => 1,
      () => {
        throw failure
      }
    )
  ).rejects.toBe(failure)
  await expect(
    mapAwaitFromSync(
      () => 1,
      value => Promise.resolve(value + 1)
    )
  ).resolves.toBe(2)
  await expect(
    mapAwaitFromSync(
      () => undefined,
      () => undefined
    )
  ).resolves.toBeUndefined()
})
