let Brc38PrivateChunkPipe: typeof import('./Brc38PrivateChunkPipe').Brc38PrivateChunkPipe
let detachBrc38PrivateChunk: typeof import('./Brc38PrivateChunkPipe').detachBrc38PrivateChunk
beforeAll(async () => {
  const actual = await import('./Brc38PrivateChunkPipe')
  Brc38PrivateChunkPipe = actual.Brc38PrivateChunkPipe
  detachBrc38PrivateChunk = actual.detachBrc38PrivateChunk
})
afterEach(() => jest.restoreAllMocks())

test('one detached chunk owns its producer until the reader advances', async () => {
  const pipe = new Brc38PrivateChunkPipe(8),
    input = Buffer.from([1, 2, 3, 4]),
    reader = pipe[Symbol.asyncIterator]()
  const write = pipe.append(input.subarray(1, 3))
  input.fill(9)
  const first = await reader.next()
  expect(first.value).toEqual(new Uint8Array([2, 3]))
  await expect(pipe.append(new Uint8Array([7]))).rejects.toThrow('already owns a write')
  expect(() => pipe.end()).toThrow('settlement')
  const next = reader.next()
  await write
  expect(first.value).toEqual(new Uint8Array([0, 0]))
  pipe.end()
  expect(await next).toEqual({ value: undefined, done: true })
  await expect(pipe.append(new Uint8Array())).rejects.toThrow('ended')
  expect(() => pipe[Symbol.asyncIterator]()).toThrow('already owned')
})
test('failure erases an owned yielded plaintext chunk without changing producer input', async () => {
  const input = new Uint8Array([11, 12]),
    pipe = new Brc38PrivateChunkPipe(8),
    reader = pipe[Symbol.asyncIterator](),
    write = pipe.append(input),
    cause = new Error('private authentication rejected')
  // Observe the producer before revoking it; this is the actual owned write.
  const rejected = expect(write).rejects.toBe(cause),
    result = await reader.next()
  pipe.fail(cause)
  await rejected
  expect(result.value).toEqual(new Uint8Array([0, 0]))
  expect(input).toEqual(new Uint8Array([11, 12]))
  await expect(reader.next()).rejects.toBe(cause)
})
test('early private reader return rejects the pending producer and prevents later plaintext admission', async () => {
  const pipe = new Brc38PrivateChunkPipe(8),
    reader = pipe[Symbol.asyncIterator](),
    write = pipe.append(new Uint8Array([1]))
  await reader.next()
  await reader.return?.()
  await expect(write).rejects.toThrow('stopped before authentication')
  await expect(pipe.append(new Uint8Array([2]))).rejects.toThrow('stopped before authentication')
})
test('failed pending read and write retain the first exact reason, including undefined', async () => {
  const pipe = new Brc38PrivateChunkPipe(8),
    reader = pipe[Symbol.asyncIterator](),
    read = reader.next()
  pipe.fail(undefined)
  pipe.fail(new Error('later failure'))
  await expect(read).rejects.toBeUndefined()
  await expect(pipe.append(new Uint8Array([1]))).rejects.toBeUndefined()
})
test.each([0, -1, 1.5, 65537, NaN])('invalid fixed chunk bound %s refuses', maximum => {
  expect(() => new Brc38PrivateChunkPipe(maximum)).toThrow('limit')
})
test('native extent preflight ignores overridden extent, buffer and copy properties', () => {
  const value = new Uint8Array(9),
    read = jest.fn(() => {
      throw new Error('caller property read')
    })
  Object.defineProperties(value, {
    byteLength: { get: read },
    buffer: { get: read },
    slice: { get: read }
  })
  expect(() => detachBrc38PrivateChunk(value, 8)).toThrow('chunk policy')
  expect(read).not.toHaveBeenCalled()
})
test.each([new Uint16Array(1), new Uint8Array(new SharedArrayBuffer(1)), new Proxy(new Uint8Array(1), {})])(
  'nonordinary native byte backing refuses before allocation',
  value => {
    expect(() => detachBrc38PrivateChunk(value as Uint8Array, 8)).toThrow()
  }
)

test.each([new Uint16Array(1), new Proxy(new Uint8Array(1), {})])(
  'non-byte native views retain the explicit private staging refusal',
  value => {
    expect(() => detachBrc38PrivateChunk(value as Uint8Array, 8)).toThrow(
      'Private staging requires an ordinary native byte view'
    )
  }
)

test('the exact 64-KiB boundary retains owned backpressure and erasure', async () => {
  const pipe = new Brc38PrivateChunkPipe(65536),
    reader = pipe[Symbol.asyncIterator](),
    input = new Uint8Array(65536).fill(7),
    write = pipe.append(input)
  const received = await reader.next()
  expect(received.done).toBe(false)
  expect(received.value).toEqual(input)
  expect(received.value).not.toBe(input)
  const ended = reader.next()
  await write
  expect(received.value).toEqual(new Uint8Array(65536))
  expect(input[65535]).toBe(7)
  pipe.end()
  expect(await ended).toEqual({ value: undefined, done: true })
})

test('failure after reader acceptance still rejects the unsettled producer with the original cause', async () => {
  const pipe = new Brc38PrivateChunkPipe(8),
    reader = pipe[Symbol.asyncIterator](),
    write = pipe.append(new Uint8Array([1])),
    cause = new Error('revoked after acceptance')
  await reader.next()
  const next = reader.next()
  pipe.fail(cause)
  await expect(write).rejects.toBe(cause)
  await expect(next).rejects.toBe(cause)
})

test('a real erasure failure cannot strand the private producer when its reader closes', async () => {
  const pipe = new Brc38PrivateChunkPipe(8),
    reader = pipe[Symbol.asyncIterator](),
    input = new Uint8Array([3]),
    write = pipe.append(input),
    cause = new Error('physical erasure reported failure')
  const received = await reader.next(),
    fill = Uint8Array.prototype.fill
  // Erase the actual owned bytes, then report a physical cleanup failure.
  // The enclosing reader must still revoke and settle its actual producer.
  jest.spyOn(Uint8Array.prototype, 'fill').mockImplementationOnce(function (this: Uint8Array, ...args) {
    Reflect.apply(fill, this, args)
    throw cause
  })
  const rejected = expect(write).rejects.toThrow('Private staging reader stopped before authentication')
  try {
    await expect(reader.return?.()).rejects.toBe(cause)
    await rejected
    expect(received.value).toEqual(new Uint8Array([0]))
    expect(input).toEqual(new Uint8Array([3]))
  } finally {
    pipe.fail(new Error('Owned test cleanup'))
    await write.catch(() => undefined)
  }
})
