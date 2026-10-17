import fc from 'fast-check'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(MIN_PROPERTY_RUNS, Number(process.env.FAST_CHECK_NUM_RUNS ?? MIN_PROPERTY_RUNS)),
  seed: Number(process.env.FAST_CHECK_SEED ?? 3242026),
  ...(process.env.FAST_CHECK_PATH ? { path: process.env.FAST_CHECK_PATH } : {}),
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true
})

/** The actual worker MODULE runs in Jest's per-test instrumentation realm.
 * An explicit transport/KDF oracle isolates message validation, erasure and
 * transfer rules; this is never a physical Worker/exit/KDF performance proof.
 * The original compiled actual-worker conformance cases remain separately
 * required and keep their real process/exit/deadline obligations. */
async function workerModule(input: unknown, result: unknown) {
  let handler: ((value: unknown) => void) | undefined,
    posted: ArrayBuffer | undefined,
    closes = 0,
    erasureBeforeTransfer = false,
    done!: () => void
  let capturedPassword: Uint8Array | undefined, capturedSalt: Uint8Array | undefined
  const completion = new Promise<void>(resolve => {
      done = resolve
    }),
    derive = jest.fn(async (options: { password: Uint8Array; salt: Uint8Array }) => {
      capturedPassword = options.password.slice()
      capturedSalt = options.salt.slice()
      return result
    }),
    originalExitCode = process.exitCode,
    port = {
      once: (name: string, callback: (value: unknown) => void) => {
        expect(name).toBe('message')
        expect(handler).toBeUndefined()
        handler = callback
      },
      postMessage: (bytes: ArrayBuffer, transfers: ArrayBuffer[]) => {
        const request = input as { password: ArrayBuffer; salt: ArrayBuffer }
        erasureBeforeTransfer =
          new Uint8Array(request.password).every(byte => byte === 0) &&
          new Uint8Array(request.salt).every(byte => byte === 0)
        expect(transfers).toEqual([bytes])
        posted = structuredClone(bytes, { transfer: transfers })
      },
      close: () => {
        closes++
        queueMicrotask(done)
      }
    }
  try {
    jest.isolateModules(() => {
      jest.doMock('node:worker_threads', () => ({ parentPort: port }))
      jest.doMock('../../utility/hashWasm', () => ({ argon2id: derive }))
      require('./Brc39Argon2Worker')
    })
    expect(handler).toBeDefined()
    handler!(input)
    await completion
    // Both finally-close and the rejected promise's catch are allowed to settle
    // before restoring the real test-process exit state or mock registry.
    await Promise.resolve()
    await Promise.resolve()
    return {
      posted,
      closes,
      erasureBeforeTransfer,
      derive,
      capturedPassword,
      capturedSalt,
      exitCode: process.exitCode,
      detachedResult: result instanceof Uint8Array ? result.byteLength === 0 : false
    }
  } finally {
    process.exitCode = originalExitCode
    jest.dontMock('node:worker_threads')
    jest.dontMock('../../utility/hashWasm')
  }
}

test('generated actual module requests preserve scalar limits, erase originals and transfer exactly one exclusive key', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uint8Array({ minLength: 0, maxLength: 1024 }),
      fc.uint8Array({ minLength: 1, maxLength: 255 }),
      fc.integer({ min: 1, max: 0xffffffff }),
      fc.integer({ min: 1, max: 0xffffffff }),
      fc.integer({ min: 1, max: 255 }),
      fc.uint8Array({ minLength: 32, maxLength: 32 }),
      async (password, salt, iterations, memoryKiB, parallelism, oracleKey) => {
        const originalPassword = password.slice(),
          originalSalt = salt.slice(),
          // The independent mock result is not a password hash or a real KDF.
          expected = Buffer.from(oracleKey),
          key = new Uint8Array(expected),
          request = {
            password: new Uint8Array(password).buffer,
            salt: new Uint8Array(salt).buffer,
            iterations,
            memoryKiB,
            parallelism
          },
          outcome = await workerModule(request, key)
        expect(outcome.derive).toHaveBeenCalledTimes(1)
        expect(outcome.capturedPassword).toEqual(originalPassword)
        expect(outcome.capturedSalt).toEqual(originalSalt)
        expect(outcome.derive.mock.calls[0][0]).toMatchObject({
          iterations,
          memorySize: memoryKiB,
          parallelism,
          hashLength: 32,
          outputType: 'binary'
        })
        expect(outcome.erasureBeforeTransfer).toBe(true)
        expect(outcome.detachedResult).toBe(true)
        expect(Buffer.from(outcome.posted!)).toEqual(expected)
        expect(outcome.closes).toBe(1)
        expect(new Uint8Array(request.password).every(byte => byte === 0)).toBe(true)
        expect(new Uint8Array(request.salt).every(byte => byte === 0)).toBe(true)
      }
    )
  )
})

test('generated invalid input/parameter/key boundaries refuse before key delivery and close the actual module scope', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom('password', 'salt', 'iterations', 'memoryKiB', 'parallelism', 'key'),
      fc.constantFrom(0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', undefined),
      async (field, invalid) => {
        const request: Record<string, unknown> = {
            password: new Uint8Array([7, 8]).buffer,
            salt: new Uint8Array([9]).buffer,
            iterations: 1,
            memoryKiB: 8,
            parallelism: 1
          },
          key = new Uint8Array(32).fill(31)
        if (field !== 'key') request[field] = invalid
        const outcome = await workerModule(request, field === 'key' ? key.subarray(1) : key)
        expect(outcome.posted).toBeUndefined()
        expect(outcome.closes).toBeGreaterThanOrEqual(1)
        expect(outcome.exitCode).toBe(1)
        if (field === 'key') expect(key.subarray(1).every(byte => byte === 0)).toBe(true)
        else expect(outcome.derive).not.toHaveBeenCalled()
      }
    )
  )
})

test.each([0, 256])('salt extent %i refuses without derivation', async length => {
  const outcome = await workerModule(
    { password: new ArrayBuffer(0), salt: new ArrayBuffer(length), iterations: 1, memoryKiB: 8, parallelism: 1 },
    new Uint8Array(32)
  )
  expect(outcome.posted).toBeUndefined()
  expect(outcome.derive).not.toHaveBeenCalled()
})

test('missing original parent port refuses before enrollment', () => {
  try {
    jest.isolateModules(() => {
      jest.doMock('node:worker_threads', () => ({ parentPort: null }))
      expect(() => require('./Brc39Argon2Worker')).toThrow('owned worker port')
    })
  } finally {
    jest.dontMock('node:worker_threads')
  }
})

test('over-limit password extent and aliased full-length key refuse without output', async () => {
  const overLimit = await workerModule(
    { password: new ArrayBuffer(65537), salt: new ArrayBuffer(1), iterations: 1, memoryKiB: 8, parallelism: 1 },
    new Uint8Array(32)
  )
  expect(overLimit.posted).toBeUndefined()
  expect(overLimit.derive).not.toHaveBeenCalled()
  const aliased = await workerModule(
    { password: new ArrayBuffer(1), salt: new ArrayBuffer(1), iterations: 1, memoryKiB: 8, parallelism: 1 },
    new Uint8Array(33).subarray(1)
  )
  expect(aliased.posted).toBeUndefined()
  expect(aliased.exitCode).toBe(1)
})
