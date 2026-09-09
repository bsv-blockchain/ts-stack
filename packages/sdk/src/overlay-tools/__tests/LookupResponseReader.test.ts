import { readLookupResponseBytes } from '../LookupResponseReader.js'
import { LookupResourceLimitError } from '../LookupResources.js'

function responseForReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  contentLength?: string
): Response {
  const headers = new Headers()
  if (contentLength !== undefined) headers.set('content-length', contentLength)
  return {
    body: { getReader: () => reader },
    headers
  } as unknown as Response
}

function readerForChunks(chunks: Uint8Array[]): ReadableStreamDefaultReader<Uint8Array> {
  let index = 0
  return {
    read: async () =>
      index < chunks.length
        ? { done: false, value: chunks[index++] }
        : { done: true, value: undefined },
    cancel: async () => undefined,
    releaseLock: () => undefined
  } as unknown as ReadableStreamDefaultReader<Uint8Array>
}

describe('readLookupResponseBytes', () => {
  it('joins normal streamed chunks and charges each accepted chunk', async () => {
    const consumed: number[] = []
    const bytes = await readLookupResponseBytes(
      responseForReader(readerForChunks([new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])])),
      { maxResponseBytes: 5, consumeBytes: byteCount => consumed.push(byteCount) }
    )

    expect(bytes).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
    expect(consumed).toEqual([2, 3])
  })

  it('allows a body exactly at the configured boundary', async () => {
    const bytes = await readLookupResponseBytes(
      responseForReader(readerForChunks([new Uint8Array([1, 2]), new Uint8Array([3])]), '3'),
      { maxResponseBytes: 3 }
    )

    expect(bytes).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('rejects a known oversized Content-Length before reading chunks', async () => {
    const read = jest.fn()
    const cancel = jest.fn(async () => undefined)
    const releaseLock = jest.fn()
    const reader = {
      read,
      cancel,
      releaseLock
    } as unknown as ReadableStreamDefaultReader<Uint8Array>

    await expect(
      readLookupResponseBytes(responseForReader(reader, '6'), { maxResponseBytes: 5 })
    ).rejects.toMatchObject({ name: 'LookupResourceLimitError', limit: 'maxResponseBytes' })

    expect(read).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(releaseLock).toHaveBeenCalledTimes(1)
  })

  it('rejects an overflowing chunk before it is charged or accumulated', async () => {
    const cancel = jest.fn(async () => undefined)
    const releaseLock = jest.fn()
    const reader = {
      read: jest
        .fn()
        .mockResolvedValueOnce({ done: false, value: new Uint8Array([1, 2, 3]) })
        .mockResolvedValueOnce({ done: false, value: new Uint8Array([4, 5, 6]) }),
      cancel,
      releaseLock
    } as unknown as ReadableStreamDefaultReader<Uint8Array>
    const consumed: number[] = []

    await expect(
      readLookupResponseBytes(responseForReader(reader), {
        maxResponseBytes: 5,
        consumeBytes: byteCount => consumed.push(byteCount)
      })
    ).rejects.toBeInstanceOf(LookupResourceLimitError)

    expect(consumed).toEqual([3])
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(releaseLock).toHaveBeenCalledTimes(1)
  })

  it('copies producer-owned chunk buffers before the producer reuses them', async () => {
    const producerBuffer = new Uint8Array([1, 2])
    let readCount = 0
    const reader = {
      read: async () => {
        readCount += 1
        if (readCount === 1) return { done: false, value: producerBuffer }
        if (readCount === 2) {
          producerBuffer.set([3, 4])
          return { done: false, value: producerBuffer }
        }
        return { done: true, value: undefined }
      },
      cancel: async () => undefined,
      releaseLock: () => undefined
    } as unknown as ReadableStreamDefaultReader<Uint8Array>

    await expect(
      readLookupResponseBytes(responseForReader(reader), { maxResponseBytes: 4 })
    ).resolves.toEqual(new Uint8Array([1, 2, 3, 4]))
  })

  it('ignores many empty chunks while retaining tiny chunks in bounded storage', async () => {
    const emptyChunks = Array.from({ length: 2048 }, () => new Uint8Array(0))
    const tinyChunks = Array.from({ length: 32 }, (_unused, index) => new Uint8Array([index]))
    const consumed: number[] = []

    const bytes = await readLookupResponseBytes(
      responseForReader(readerForChunks([...emptyChunks, ...tinyChunks])),
      { maxResponseBytes: 32, consumeBytes: byteCount => consumed.push(byteCount) }
    )

    expect(bytes).toEqual(new Uint8Array(Array.from({ length: 32 }, (_unused, index) => index)))
    expect(consumed).toEqual(Array.from({ length: 32 }, () => 1))
  })

  it('yields so a timer abort can stop an endless eager empty stream', async () => {
    const controller = new AbortController()
    const cancel = jest.fn(async () => undefined)
    const reader = {
      read: jest.fn(async () => ({ done: false, value: new Uint8Array(0) })),
      cancel,
      releaseLock: jest.fn()
    } as unknown as ReadableStreamDefaultReader<Uint8Array>
    const timer = setTimeout(() => controller.abort(new Error('empty stream aborted')), 1)

    try {
      await expect(
        readLookupResponseBytes(responseForReader(reader), {
          maxResponseBytes: 1,
          signal: controller.signal
        })
      ).rejects.toThrow('empty stream aborted')
    } finally {
      clearTimeout(timer)
    }

    expect(cancel).toHaveBeenCalledTimes(1)
    expect((reader.read as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(64)
    expect((reader.read as jest.Mock).mock.calls.length).toBeLessThan(256)
  })

  it('copies the sixty-fourth chunk before yielding to timer-driven producer mutation', async () => {
    const producerBuffer = new Uint8Array([1])
    let reads = 0
    const reader = {
      read: async () => {
        reads += 1
        if (reads <= 64) {
          if (reads === 64) setTimeout(() => producerBuffer.fill(9), 0)
          return { done: false, value: producerBuffer }
        }
        return { done: true, value: undefined }
      },
      cancel: async () => undefined,
      releaseLock: () => undefined
    } as unknown as ReadableStreamDefaultReader<Uint8Array>

    await expect(
      readLookupResponseBytes(responseForReader(reader), { maxResponseBytes: 64 })
    ).resolves.toEqual(new Uint8Array(64).fill(1))
  })

  it('cleans up when the aggregate byte budget rejects an accepted chunk', async () => {
    const cancel = jest.fn(async () => undefined)
    const releaseLock = jest.fn()
    const reader = {
      read: jest.fn().mockResolvedValue({ done: false, value: new Uint8Array([1, 2]) }),
      cancel,
      releaseLock
    } as unknown as ReadableStreamDefaultReader<Uint8Array>
    const budgetFailure = new Error('aggregate response budget exhausted')

    await expect(
      readLookupResponseBytes(responseForReader(reader), {
        maxResponseBytes: 10,
        consumeBytes: () => {
          throw budgetFailure
        }
      })
    ).rejects.toBe(budgetFailure)

    expect(cancel).toHaveBeenCalledWith(budgetFailure)
    expect(releaseLock).toHaveBeenCalledTimes(1)
  })

  it('rejects an abort while a reader read remains pending and starts cleanup', async () => {
    let rejectRead: (reason?: unknown) => void = () => undefined
    const pendingRead = new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
      rejectRead = reject
    })
    const cancel = jest.fn(() => {
      rejectRead(new Error('cancelled pending read'))
      return Promise.resolve()
    })
    const releaseLock = jest.fn()
    const reader = {
      read: jest.fn(() => pendingRead),
      cancel,
      releaseLock
    } as unknown as ReadableStreamDefaultReader<Uint8Array>
    const controller = new AbortController()
    const aborted = readLookupResponseBytes(responseForReader(reader), {
      maxResponseBytes: 10,
      signal: controller.signal
    })

    controller.abort(new Error('lookup aborted'))

    await expect(aborted).rejects.toThrow('lookup aborted')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(releaseLock).toHaveBeenCalledTimes(1)
  })

  it('preserves the read failure when cancellation and lock release throw', async () => {
    const readFailure = new Error('stream failed')
    const reader = {
      read: jest.fn().mockRejectedValue(readFailure),
      cancel: jest.fn(() => {
        throw new Error('cancel failed')
      }),
      releaseLock: jest.fn(() => {
        throw new Error('release failed')
      })
    } as unknown as ReadableStreamDefaultReader<Uint8Array>

    await expect(
      readLookupResponseBytes(responseForReader(reader), { maxResponseBytes: 10 })
    ).rejects.toBe(readFailure)
  })

  it('rejects a maxResponseBytes that is not a non-negative safe integer', async () => {
    const response = responseForReader(readerForChunks([]))
    await expect(
      readLookupResponseBytes(response, { maxResponseBytes: -1 })
    ).rejects.toBeInstanceOf(RangeError)
    await expect(readLookupResponseBytes(response, { maxResponseBytes: 1.5 })).rejects.toThrow(
      'maxResponseBytes must be a non-negative safe integer'
    )
    await expect(
      readLookupResponseBytes(response, { maxResponseBytes: Number.MAX_SAFE_INTEGER + 1 })
    ).rejects.toBeInstanceOf(RangeError)
  })

  it('treats a malformed Content-Length as unknown and still reads the body', async () => {
    const bytes = await readLookupResponseBytes(
      responseForReader(readerForChunks([new Uint8Array([9])]), '1e6'),
      { maxResponseBytes: 1 }
    )
    expect(bytes).toEqual(new Uint8Array([9]))
  })

  it('returns an empty body when the response has no stream', async () => {
    const headers = new Headers()
    const empty = { body: null, headers } as unknown as Response
    await expect(readLookupResponseBytes(empty, { maxResponseBytes: 0 })).resolves.toEqual(
      new Uint8Array(0)
    )

    headers.set('content-length', '4')
    await expect(
      readLookupResponseBytes({ body: null, headers } as unknown as Response, {
        maxResponseBytes: 1
      })
    ).rejects.toMatchObject({ name: 'LookupResourceLimitError', limit: 'maxResponseBytes' })
  })

  it('rejects an already-aborted empty body using the AbortError fallback when no reason is set', async () => {
    const signal = {
      aborted: true,
      reason: undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    } as unknown as AbortSignal
    await expect(
      readLookupResponseBytes({ body: null, headers: new Headers() } as unknown as Response, {
        maxResponseBytes: 0,
        signal
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects an already-aborted stream before the first read', async () => {
    const controller = new AbortController()
    const read = jest.fn()
    controller.abort(new Error('already aborted'))
    const reader = {
      read,
      cancel: async () => undefined,
      releaseLock: () => undefined
    } as unknown as ReadableStreamDefaultReader<Uint8Array>
    await expect(
      readLookupResponseBytes(responseForReader(reader), {
        maxResponseBytes: 10,
        signal: controller.signal
      })
    ).rejects.toThrow('already aborted')
    expect(read).not.toHaveBeenCalled()
  })

  it('treats a missing chunk value as empty input', async () => {
    const consumed: number[] = []
    const reader = {
      read: jest
        .fn()
        .mockResolvedValueOnce({ done: false, value: undefined })
        .mockResolvedValueOnce({ done: true, value: undefined }),
      cancel: async () => undefined,
      releaseLock: () => undefined
    } as unknown as ReadableStreamDefaultReader<Uint8Array>

    await expect(
      readLookupResponseBytes(responseForReader(reader), {
        maxResponseBytes: 4,
        consumeBytes: byteCount => consumed.push(byteCount)
      })
    ).resolves.toEqual(new Uint8Array(0))
    expect(consumed).toEqual([])
  })

  it('rejects a later read when consumeBytes aborts the signal', async () => {
    const controller = new AbortController()
    const cancel = jest.fn(async () => undefined)
    const reader = {
      read: jest
        .fn()
        .mockResolvedValueOnce({ done: false, value: new Uint8Array([1]) })
        .mockResolvedValueOnce({ done: false, value: new Uint8Array([2]) }),
      cancel,
      releaseLock: jest.fn()
    } as unknown as ReadableStreamDefaultReader<Uint8Array>

    await expect(
      readLookupResponseBytes(responseForReader(reader), {
        maxResponseBytes: 10,
        signal: controller.signal,
        consumeBytes: () => controller.abort()
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('rejects an abort that races listener registration', async () => {
    const signal = {
      aborted: false,
      reason: new Error('raced abort'),
      addEventListener: () => {
        signal.aborted = true
      },
      removeEventListener: () => undefined
    }
    await expect(
      readLookupResponseBytes(responseForReader(readerForChunks([new Uint8Array([1])])), {
        maxResponseBytes: 10,
        signal: signal as unknown as AbortSignal
      })
    ).rejects.toThrow('raced abort')
  })
})
