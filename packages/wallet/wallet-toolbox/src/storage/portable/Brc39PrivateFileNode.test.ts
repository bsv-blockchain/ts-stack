import { mkdtemp, open, readdir, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { FileHandle } from 'node:fs/promises'
import fc from 'fast-check'
import { createBrc39NodeFileQuarantine, type Brc39NodeFileQuarantine } from './Brc39PrivateFileNode'
import { decryptBrc39StreamToQuarantine } from './Brc39StreamNode'
import { encryptBRC39, parseBRC38Json, type BRC38WalletData } from './index'
import {
  registerArgon2idBackend,
  unregisterArgon2idBackend,
  type AsyncArgon2idBackend
} from '../../utility/Argon2idBackend'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(MIN_PROPERTY_RUNS, Number(process.env.FAST_CHECK_NUM_RUNS ?? MIN_PROPERTY_RUNS)),
  seed: Number(process.env.FAST_CHECK_SEED ?? 3242026),
  ...(process.env.FAST_CHECK_PATH ? { path: process.env.FAST_CHECK_PATH } : {}),
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true
})

const policy = { maximumFileBytes: 1048576, maximumChunkBytes: 64 }
let parent: string
let backend: AsyncArgon2idBackend | undefined
beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), 'ts-stack-file-quarantine-'))
})
afterEach(async () => {
  if (backend !== undefined) unregisterArgon2idBackend(backend)
  backend = undefined
  jest.restoreAllMocks()
  await rm(parent, { recursive: true, force: true })
})
async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = []
  for await (const bytes of chunks) {
    expect(bytes.length).toBeLessThanOrEqual(64)
    parts.push(bytes)
  }
  // These bounded synthetic fixtures are materialized only by the test oracle.
  return Buffer.concat(parts)
}
async function stagedPath(): Promise<{ directory: string; filename: string }> {
  const names = await readdir(parent)
  expect(names).toHaveLength(1)
  const directory = join(parent, names[0])
  return { directory, filename: join(directory, 'quarantine') }
}
async function* pieces(bytes: Uint8Array, width = 31) {
  for (let offset = 0; offset < bytes.length; offset += width) yield bytes.slice(offset, offset + width)
}
async function append(stage: Brc39NodeFileQuarantine, bytes: Uint8Array, width = 31): Promise<void> {
  async function* writes() {
    for await (const chunk of pieces(bytes, width)) yield stage.appendUntrusted(chunk)
  }
  for await (const result of writes()) expect(result).toBeUndefined()
}

function observeHandles(): FileHandle[] {
  const fs = jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises')
  const actual = fs.open
  const handles: FileHandle[] = []
  jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await actual(...args)
    handles.push(handle)
    return handle
  })
  return handles
}

test('short writes retain every byte in order with actual file backing', async () => {
  const handles = observeHandles()
  const stage = await createBrc39NodeFileQuarantine(
    parent,
    async chunks => {
      expect(await collect(chunks)).toEqual(Buffer.from([1, 2, 3]))
    },
    policy
  )
  // Simulate the first write having committed exactly one byte. Its fulfilled
  // result is returned once; the remaining write uses the real file handle.
  await handles[0].write(new Uint8Array([1]), 0, 1, null)
  const writes = jest.spyOn(handles[0], 'write').mockResolvedValueOnce({ bytesWritten: 1, buffer: '' })
  await stage.appendUntrusted(new Uint8Array([1, 2, 3]))
  expect(writes).toHaveBeenCalledTimes(2)
  expect(writes.mock.calls[1].slice(1)).toEqual([1, 2, null])
  await stage.validateAuthenticated()
  await stage.discard()
})

test.each([0, -1, 4, NaN])('invalid write progress %s refuses and permits cleanup', async bytesWritten => {
  const handles = observeHandles()
  const stage = await createBrc39NodeFileQuarantine(parent, async () => {}, policy)
  jest.spyOn(handles[0], 'write').mockResolvedValueOnce({ bytesWritten, buffer: '' })
  await expect(stage.appendUntrusted(new Uint8Array([1, 2, 3]))).rejects.toThrow('invalid progress')
  await stage.discard()
  expect(await readdir(parent)).toEqual([])
})

test('filesystem write failure retains exact cause and refuses further work', async () => {
  const handles = observeHandles()
  const reason = Object.assign(new Error('synthetic disk pressure'), { code: 'ENOSPC' })
  const stage = await createBrc39NodeFileQuarantine(parent, async () => {}, policy)
  jest.spyOn(handles[0], 'write').mockRejectedValueOnce(reason)
  await expect(stage.appendUntrusted(new Uint8Array([1]))).rejects.toBe(reason)
  await expect(stage.appendUntrusted(new Uint8Array([1]))).rejects.toThrow('not writable')
  await stage.discard()
})

test('fsync failure refuses validation with exact cause', async () => {
  const handles = observeHandles()
  const reason = new Error('synthetic fsync failure')
  const validator = jest.fn(async (chunks: AsyncIterable<Uint8Array>) => {
    await collect(chunks)
  })
  const stage = await createBrc39NodeFileQuarantine(parent, validator, policy)
  await stage.appendUntrusted(new Uint8Array([1]))
  jest.spyOn(handles[0], 'sync').mockRejectedValueOnce(reason)
  await expect(stage.validateAuthenticated()).rejects.toBe(reason)
  expect(validator).not.toHaveBeenCalled()
  await stage.discard()
})

test('writer close failure retains its owned handle for cleanup retry', async () => {
  const handles = observeHandles()
  const reason = new Error('synthetic writer close failure')
  const stage = await createBrc39NodeFileQuarantine(
    parent,
    async chunks => {
      await collect(chunks)
    },
    policy
  )
  await stage.appendUntrusted(new Uint8Array([1]))
  const close = jest.spyOn(handles[0], 'close').mockRejectedValueOnce(reason)
  await expect(stage.validateAuthenticated()).rejects.toBe(reason)
  await stage.discard()
  expect(close).toHaveBeenCalledTimes(2)
  expect(await readdir(parent)).toEqual([])
})

test('semantic and reader cleanup failures are retained together and cleanup retries the reader', async () => {
  const handles = observeHandles()
  const original = new Error('synthetic invalid BRC-38')
  const cleanup = new Error('synthetic reader close failure')
  const stage = await createBrc39NodeFileQuarantine(
    parent,
    async chunks => {
      await collect(chunks)
      jest.spyOn(handles[1], 'close').mockRejectedValueOnce(cleanup)
      throw original
    },
    policy
  )
  await stage.appendUntrusted(new Uint8Array([1]))
  let failure: unknown
  try {
    await stage.validateAuthenticated()
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(AggregateError)
  expect(failure).toMatchObject({ cause: original, errors: [original, cleanup] })
  await stage.discard()
  expect(await readdir(parent)).toEqual([])
})

test('failed filesystem removal is explicit and a subsequent discard can retry', async () => {
  const fs = jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises')
  const reason = new Error('synthetic removal failure')
  const stage = await createBrc39NodeFileQuarantine(parent, async () => {}, policy)
  jest.spyOn(fs, 'rm').mockRejectedValueOnce(reason)
  await expect(stage.discard()).rejects.toMatchObject({ errors: [reason] })
  expect(await readdir(parent)).toHaveLength(1)
  await stage.discard()
  expect(await readdir(parent)).toEqual([])
})

test('factory file creation and removal failures both remain visible', async () => {
  const fs = jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises')
  const original = new Error('synthetic file creation failure')
  const cleanup = new Error('synthetic factory removal failure')
  jest.spyOn(fs, 'open').mockRejectedValueOnce(original)
  jest.spyOn(fs, 'rm').mockRejectedValueOnce(cleanup)
  await expect(createBrc39NodeFileQuarantine(parent, async () => {}, policy)).rejects.toMatchObject({
    cause: original,
    errors: [original, cleanup]
  })
  expect(await readdir(parent)).toHaveLength(1)
})

test('private file modes and detached writes precede authenticated bounded readback', async () => {
  let validated = 0
  const expected = Buffer.from('private UTF8 data: e\u0301 \u{1f642}')
  const stage = await createBrc39NodeFileQuarantine(
    parent,
    async chunks => {
      expect(await collect(chunks)).toEqual(expected)
      validated++
    },
    policy
  )
  expect(Object.isFrozen(stage)).toBe(true)
  expect(Object.keys(stage)).toEqual(['appendUntrusted', 'validateAuthenticated', 'withAuthenticatedChunks', 'discard'])
  await expect(stage.withAuthenticatedChunks(collect)).rejects.toThrow('has not been validated')
  const { directory, filename } = await stagedPath()
  expect((await stat(directory)).mode & 0o777).toBe(0o700)
  const reader = await open(filename, 'r')
  try {
    expect((await reader.stat()).mode & 0o777).toBe(0o600)
    const input = new Uint8Array(expected)
    const pending = stage.appendUntrusted(input)
    input.fill(0)
    await pending
    expect(await reader.readFile()).toEqual(expected)
  } finally {
    await reader.close()
  }
  expect(validated).toBe(0)
  await stage.validateAuthenticated()
  expect(validated).toBe(1)
  expect(await stage.withAuthenticatedChunks(collect)).toEqual(expected)
  await expect(stage.appendUntrusted(new Uint8Array([1]))).rejects.toThrow('not writable')
  await expect(stage.validateAuthenticated()).rejects.toThrow('cannot be validated again')
  await stage.discard()
  await stage.discard()
  expect(await readdir(parent)).toEqual([])
  await expect(stage.withAuthenticatedChunks(collect)).rejects.toThrow('has not been validated')
})

test('concurrent append refuses instead of retaining queued buffers', async () => {
  const stage = await createBrc39NodeFileQuarantine(
    parent,
    async chunks => {
      expect(await collect(chunks)).toEqual(Buffer.from([1, 2]))
    },
    policy
  )
  const pending = stage.appendUntrusted(new Uint8Array([1, 2]))
  await expect(stage.appendUntrusted(new Uint8Array([3, 4]))).rejects.toThrow('already owns an operation')
  await pending
  await stage.validateAuthenticated()
  await stage.discard()
})

test.each([
  { name: 'Uint8Array', make: (bytes: Uint8Array) => new Uint8Array(bytes) },
  { name: 'Buffer', make: (bytes: Uint8Array) => Buffer.from(bytes) },
  {
    name: 'Buffer subview',
    make: (bytes: Uint8Array) => Buffer.concat([Buffer.from([99]), bytes, Buffer.from([100])]).subarray(1, -1)
  }
])('append owns $name bytes before asynchronous writes', async ({ make }) => {
  const handles = observeHandles()
  const expected = new Uint8Array([11, 22, 33])
  const stage = await createBrc39NodeFileQuarantine(
    parent,
    async chunks => {
      expect(await collect(chunks)).toEqual(Buffer.from(expected))
    },
    policy
  )
  const writes = jest.spyOn(handles[0], 'write')
  const input = make(expected)
  const pending = stage.appendUntrusted(input)
  expect(writes).toHaveBeenCalledTimes(1)
  const written: unknown = writes.mock.calls[0][0]
  if (!(written instanceof Uint8Array)) throw new Error('Missing owned write bytes')
  expect(written.buffer).not.toBe(input.buffer)
  input.fill(0)
  expect(written).toEqual(expected)
  await pending
  await stage.validateAuthenticated()
  expect(await stage.withAuthenticatedChunks(collect)).toEqual(Buffer.from(expected))
  await stage.discard()
  expect(await readdir(parent)).toEqual([])
})

test.each([2, 3])('intrinsic %s-byte admission does not call input overrides', async length => {
  const input = new Uint8Array(length).fill(17)
  const getLength = jest.fn(() => 1)
  const slice = jest.fn(() => input)
  const iterator = jest.fn(() => [0][Symbol.iterator]())
  Object.defineProperties(input, {
    length: { get: getLength },
    slice: { value: slice },
    [Symbol.iterator]: { value: iterator }
  })
  const expected = length === 2 ? Buffer.from([17, 17]) : Buffer.from([9])
  const stage = await createBrc39NodeFileQuarantine(
    parent,
    async chunks => {
      expect(await collect(chunks)).toEqual(expected)
    },
    { maximumFileBytes: 3, maximumChunkBytes: 2 }
  )
  if (length === 2) {
    const pending = stage.appendUntrusted(input)
    input.fill(0)
    await pending
  } else {
    await expect(stage.appendUntrusted(input)).rejects.toThrow('byte policy')
    await stage.appendUntrusted(new Uint8Array([9]))
  }
  expect(getLength).not.toHaveBeenCalled()
  expect(slice).not.toHaveBeenCalled()
  expect(iterator).not.toHaveBeenCalled()
  await stage.validateAuthenticated()
  await stage.discard()
  expect(await readdir(parent)).toEqual([])
})

test('a detached input rejects without starting a write or closing admission', async () => {
  const handles = observeHandles()
  const stage = await createBrc39NodeFileQuarantine(
    parent,
    async chunks => {
      expect(await collect(chunks)).toEqual(Buffer.from([9]))
    },
    policy
  )
  const input = new Uint8Array([1])
  structuredClone(input.buffer, { transfer: [input.buffer] })
  const writes = jest.spyOn(handles[0], 'write')
  await expect(stage.appendUntrusted(input)).rejects.toMatchObject({ name: 'TypeError' })
  expect(writes).not.toHaveBeenCalled()
  await stage.appendUntrusted(new Uint8Array([9]))
  await stage.validateAuthenticated()
  await stage.discard()
  expect(await readdir(parent)).toEqual([])
})

test('chunk and cumulative file bounds refuse before additional bytes reach disk', async () => {
  const stage = await createBrc39NodeFileQuarantine(
    parent,
    async chunks => {
      expect(await collect(chunks)).toEqual(Buffer.from([1, 2, 3]))
    },
    { maximumFileBytes: 3, maximumChunkBytes: 2 }
  )
  await expect(stage.appendUntrusted(new Uint8Array([1, 2, 3]))).rejects.toThrow('byte policy')
  await stage.appendUntrusted(new Uint8Array([1, 2]))
  await expect(stage.appendUntrusted(new Uint8Array([3, 4]))).rejects.toThrow('byte policy')
  await stage.appendUntrusted(new Uint8Array([3]))
  await stage.validateAuthenticated()
  await stage.discard()
})

test.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  'invalid file bound %s creates no private file',
  async maximumFileBytes => {
    await expect(
      createBrc39NodeFileQuarantine(parent, async () => {}, {
        ...policy,
        maximumFileBytes
      })
    ).rejects.toThrow('positive safe integer')
    expect(await readdir(parent)).toEqual([])
  }
)
test.each([0, -1, 1.5, NaN, Infinity, 65537])(
  'invalid chunk bound %s creates no private file',
  async maximumChunkBytes => {
    await expect(
      createBrc39NodeFileQuarantine(parent, async () => {}, {
        ...policy,
        maximumChunkBytes
      })
    ).rejects.toThrow('integer from 1 to 65536')
    expect(await readdir(parent)).toEqual([])
  }
)

test('validator early completion refuses authentication and its reader is released', async () => {
  const stage = await createBrc39NodeFileQuarantine(
    parent,
    async chunks => {
      for await (const chunk of chunks) {
        expect(chunk).toHaveLength(64)
        break
      }
    },
    policy
  )
  await append(stage, new Uint8Array(200).fill(17))
  await expect(stage.validateAuthenticated()).rejects.toThrow('did not consume the complete file')
  await expect(stage.withAuthenticatedChunks(collect)).rejects.toThrow('has not been validated')
  await stage.discard()
  expect(await readdir(parent)).toEqual([])
})

test('semantic failure retains its exact cause, closes the reader and permits cleanup', async () => {
  const reason = new Error('independent semantic validation failed')
  const stage = await createBrc39NodeFileQuarantine(
    parent,
    async chunks => {
      await collect(chunks)
      throw reason
    },
    policy
  )
  await append(stage, Buffer.from('bounded invalid document'))
  await expect(stage.validateAuthenticated()).rejects.toBe(reason)
  await expect(stage.appendUntrusted(new Uint8Array([1]))).rejects.toThrow('not writable')
  await stage.discard()
  expect(await readdir(parent)).toEqual([])
})

test('authenticated early read completion closes its iterator and later reads remain independent', async () => {
  const bytes = new Uint8Array(151).map((_, index) => index)
  const stage = await createBrc39NodeFileQuarantine(
    parent,
    async chunks => {
      expect(await collect(chunks)).toEqual(Buffer.from(bytes))
    },
    policy
  )
  await append(stage, bytes)
  await stage.validateAuthenticated()
  const first = await stage.withAuthenticatedChunks(async chunks => {
    for await (const chunk of chunks) return chunk
    throw new Error('missing first chunk')
  })
  expect(first).toEqual(bytes.slice(0, 64))
  expect(await stage.withAuthenticatedChunks(collect)).toEqual(Buffer.from(bytes))
  await stage.discard()
})

test('external truncation is refused without validating an incomplete file', async () => {
  const validator = jest.fn(async (chunks: AsyncIterable<Uint8Array>) => {
    await collect(chunks)
  })
  const stage = await createBrc39NodeFileQuarantine(parent, validator, policy)
  await append(stage, Buffer.from('complete source'))
  await truncate((await stagedPath()).filename, 2)
  await expect(stage.validateAuthenticated()).rejects.toThrow('size changed')
  expect(validator).not.toHaveBeenCalled()
  await stage.discard()
})

test('same-size external changes refuse readback despite valid file length', async () => {
  const stage = await createBrc39NodeFileQuarantine(
    parent,
    async chunks => {
      await collect(chunks)
    },
    policy
  )
  await append(stage, Buffer.from('original'))
  await writeFile((await stagedPath()).filename, Buffer.from('modified'))
  await expect(stage.validateAuthenticated()).rejects.toThrow('bytes changed')
  await expect(stage.withAuthenticatedChunks(collect)).rejects.toThrow('has not been validated')
  await stage.discard()
})

test('cancellation prevents file creation or authenticated access with the exact reason', async () => {
  const controller = new AbortController()
  const reason = new Error('operator cancellation')
  controller.abort(reason)
  await expect(
    createBrc39NodeFileQuarantine(parent, async () => {}, {
      ...policy,
      signal: controller.signal
    })
  ).rejects.toBe(reason)
  expect(await readdir(parent)).toEqual([])
  const active = new AbortController()
  const stage = await createBrc39NodeFileQuarantine(
    parent,
    async chunks => {
      await collect(chunks)
    },
    {
      ...policy,
      signal: active.signal
    }
  )
  await append(stage, Buffer.from('private'))
  active.abort(reason)
  await expect(stage.validateAuthenticated()).rejects.toBe(reason)
  await stage.discard()
  expect(await readdir(parent)).toEqual([])
})

test('discard waits for an owned validator before deleting its file', async () => {
  let complete!: () => void
  let entered!: () => void
  const started = new Promise<void>(resolve => {
    entered = resolve
  })
  const waiting = new Promise<void>(resolve => {
    complete = resolve
  })
  const stage = await createBrc39NodeFileQuarantine(
    parent,
    async chunks => {
      await collect(chunks)
      entered()
      await waiting
    },
    policy
  )
  await append(stage, Buffer.from('private source'))
  const validation = stage.validateAuthenticated()
  const rejected = expect(validation).rejects.toThrow('discarded during validation')
  await started
  let discarded = false
  const closing = stage.discard().then(() => {
    discarded = true
  })
  await Promise.resolve()
  expect(discarded).toBe(false)
  expect(await readdir(parent)).toHaveLength(1)
  complete()
  await rejected
  await closing
  expect(await readdir(parent)).toEqual([])
})

function document(): BRC38WalletData {
  const iso = '2026-10-03T00:00:00.000Z'
  return {
    brc: 38,
    title: 'User Wallet Data Format',
    formatVersion: 1,
    exportedAt: iso,
    sourceStorage: {
      created_at: iso,
      updated_at: iso,
      storageIdentityKey: 'source',
      storageName: 'source',
      chain: 'test'
    },
    user: { created_at: iso, updated_at: iso, userId: 1, identityKey: 'identity', activeStorage: 'source' },
    tables: {
      provenTxs: [],
      provenTxReqs: [],
      outputBaskets: [],
      transactions: [],
      commissions: [],
      outputs: [],
      outputTags: [],
      outputTagMaps: [],
      txLabels: [],
      txLabelMaps: [],
      certificates: [],
      certificateFields: [],
      syncStates: []
    }
  }
}
test.each([false, true])(
  'legacy envelope file quarantine exposes semantics only after authentication; damaged=%s',
  async damaged => {
    const key = new Uint8Array(32).fill(17)
    backend = { preload: async () => {}, isReady: () => true, deriveKey: async () => key.slice() }
    registerArgon2idBackend(backend)
    const expected = document()
    const encrypted = await encryptBRC39(expected, 'e\u0301 password')
    if (damaged) encrypted[encrypted.length - 1] ^= 1
    const validator = jest.fn(async (chunks: AsyncIterable<Uint8Array>) => {
      const bytes = await collect(chunks)
      expect(parseBRC38Json(new TextDecoder('utf-8', { fatal: true }).decode(bytes))).toEqual(expected)
    })
    const stage = await createBrc39NodeFileQuarantine(parent, validator, policy)
    const result = decryptBrc39StreamToQuarantine(pieces(new Uint8Array(encrypted)), '\u00e9 password', stage, {
      policy: { ...policy, maximumIterations: 7, maximumMemoryKiB: 131072, maximumParallelism: 1 },
      maximumPasswordBytes: 1024
    })
    if (damaged) {
      await expect(result).rejects.toThrow()
      expect(validator).not.toHaveBeenCalled()
      expect(await readdir(parent)).toEqual([])
    } else {
      expect((await result).plaintextBytes).toBeGreaterThan(0)
      expect(validator).toHaveBeenCalledTimes(1)
      expect(parseBRC38Json((await stage.withAuthenticatedChunks(collect)).toString())).toEqual(expected)
      await stage.discard()
    }
  }
)

test('generated bounded file chunks retain exact independent bytes and cleanup', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uint8Array({ minLength: 1, maxLength: 512 }),
      fc.integer({ min: 1, max: 64 }),
      async (bytes, width) => {
        const stage = await createBrc39NodeFileQuarantine(
          parent,
          async chunks => {
            expect(await collect(chunks)).toEqual(Buffer.from(bytes))
          },
          policy
        )
        try {
          await append(stage, bytes, width)
          await stage.validateAuthenticated()
          expect(await stage.withAuthenticatedChunks(collect)).toEqual(Buffer.from(bytes))
        } finally {
          await stage.discard()
        }
        expect(await readdir(parent)).toEqual([])
      }
    ),
    {
      numRuns: Math.max(300, Number(process.env.FAST_CHECK_NUM_RUNS ?? 300)),
      seed: Number(process.env.FAST_CHECK_SEED ?? 3242026),
      path: process.env.FAST_CHECK_PATH ?? '',
      endOnFailure: true,
      interruptAfterTimeLimit: 150000,
      markInterruptAsFailure: true
    }
  )
}, 180000)
