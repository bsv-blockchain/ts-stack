import { Brc38OwnedByteSource, type Brc38OwnedByteSourceOptions } from './Brc38OwnedByteSource'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'

// Authored UNRUN. These exercise actual promise ownership/late settlement,
// not browser/native physical source or resource qualification.
function options(): Brc38OwnedByteSourceOptions {
  return {
    expiresAt: Date.now() + 10000,
    maximumReadMilliseconds: 1000,
    cleanupMilliseconds: 1000,
    maximumChunkBytes: 32,
    maximumChunks: 10,
    maximumBytes: 100
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
test('source bytes detach and actual EOF closes the original iterator and host', async () => {
  const input = new Uint8Array([4, 5, 6]),
    returned = jest.fn(async () => ({ done: true as const, value: undefined })),
    host = jest.fn(async () => {}),
    iterator = {
      next: jest
        .fn()
        .mockResolvedValueOnce({ done: false, value: input })
        .mockResolvedValueOnce({ done: true, value: undefined }),
      return: returned
    },
    source = await Brc38OwnedByteSource.open(
      { [Symbol.asyncIterator]: () => iterator },
      { ...options(), closeSource: host }
    )
  const first = await source.next()
  if (first.done) throw new Error('Missing detached source bytes')
  input[0] = 99
  expect(Array.from(first.value)).toEqual([4, 5, 6])
  first.value.fill(0)
  expect((await source.next()).done).toBe(true)
  expect(host).toHaveBeenCalledTimes(1)
  expect(returned).toHaveBeenCalledTimes(1)
  await source.close()
  expect(host).toHaveBeenCalledTimes(1)
})
test('cancellation interrupts pending next before iterator return and preserves producer bytes', async () => {
  const controller = new AbortController(),
    pending = deferred<IteratorResult<Uint8Array>>(),
    input = new Uint8Array([11, 12]),
    order: string[] = [],
    source = await Brc38OwnedByteSource.open(
      {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            order.push('next')
            return await pending.promise
          },
          return: async () => {
            order.push('return')
            return { done: true, value: undefined }
          }
        })
      },
      {
        ...options(),
        signal: controller.signal,
        closeSource: async () => {
          order.push('host')
          pending.resolve({ done: false, value: input })
        }
      }
    ),
    cause = new Error('operator cancellation'),
    reading = source.next()
  await Promise.resolve()
  await Promise.resolve()
  controller.abort(cause)
  await expect(reading).rejects.toBe(cause)
  expect(order).toEqual(['next', 'host', 'return'])
  expect(Array.from(input)).toEqual([11, 12])
})
test('undrained source keeps exact outstanding read for retry and does not queue return', async () => {
  const pending = deferred<IteratorResult<Uint8Array>>(),
    returned = jest.fn(async () => ({ done: true as const, value: undefined })),
    host = jest.fn(async () => {}),
    next = jest.fn(async () => await pending.promise),
    source = await Brc38OwnedByteSource.open(
      { [Symbol.asyncIterator]: () => ({ next, return: returned }) },
      { ...options(), maximumReadMilliseconds: 10, cleanupMilliseconds: 10, closeSource: host }
    )
  let caught: unknown
  try {
    await source.next()
  } catch (cause) {
    caught = cause
  }
  expect(caught).toBeInstanceOf(Brc38StagingCleanupError)
  expect(next).toHaveBeenCalledTimes(1)
  expect(returned).not.toHaveBeenCalled()
  pending.resolve({ done: false, value: new Uint8Array([7]) })
  await (caught as Brc38StagingCleanupError).retryCleanup()
  expect(next).toHaveBeenCalledTimes(1)
  expect(returned).toHaveBeenCalledTimes(1)
  expect(host).toHaveBeenCalledTimes(1)
})
test('host close refusal retains retry instead of successful EOF', async () => {
  const failure = new Error('host close failure'),
    host = jest.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined),
    returned = jest.fn(async () => ({ done: true as const, value: undefined })),
    source = await Brc38OwnedByteSource.open(
      {
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ done: true, value: undefined }),
          return: returned
        })
      },
      { ...options(), closeSource: host }
    )
  let caught: unknown
  try {
    await source.next()
  } catch (cause) {
    caught = cause
  }
  expect(caught).toBeInstanceOf(Brc38StagingCleanupError)
  await (caught as Brc38StagingCleanupError).retryCleanup()
  expect(host).toHaveBeenCalledTimes(2)
  expect(returned).toHaveBeenCalledTimes(1)
})
test('original byte and chunk ceilings refuse and drain without mutating caller input', async () => {
  const input = new Uint8Array([1, 2, 3]),
    returned = jest.fn(async () => ({ done: true as const, value: undefined })),
    source = await Brc38OwnedByteSource.open(
      {
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ done: false, value: input }),
          return: returned
        })
      },
      { ...options(), maximumBytes: 2 }
    )
  await expect(source.next()).rejects.toThrow('extent bound')
  expect(Array.from(input)).toEqual([1, 2, 3])
  expect(returned).toHaveBeenCalledTimes(1)
})
