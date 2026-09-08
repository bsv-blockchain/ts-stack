import {
  readyArgon2idBackend,
  registerArgon2idBackend,
  unregisterArgon2idBackend,
  validateArgon2idResult,
  type AsyncArgon2idBackend
} from '../Argon2idBackend'

function backend(overrides: Partial<AsyncArgon2idBackend> = {}): AsyncArgon2idBackend {
  return {
    preload: jest.fn(async () => {}),
    isReady: jest.fn(() => true),
    deriveKey: jest.fn(async () => new Uint8Array(32)),
    ...overrides
  }
}

describe('Argon2idBackend', () => {
  const cleanupBackend = backend()

  beforeEach(() => {
    registerArgon2idBackend(cleanupBackend)
    unregisterArgon2idBackend(cleanupBackend)
  })

  afterEach(() => {
    unregisterArgon2idBackend(cleanupBackend)
  })

  test('registers and returns only a ready backend', () => {
    const selected = backend()

    expect(readyArgon2idBackend()).toBeUndefined()
    registerArgon2idBackend(selected)
    expect(readyArgon2idBackend()).toBe(selected)
    expect(selected.preload).not.toHaveBeenCalled()

    unregisterArgon2idBackend(selected)
    expect(readyArgon2idBackend()).toBeUndefined()
  })

  test('does not let a stale owner unregister the active backend', () => {
    const stale = backend()
    const active = backend()

    registerArgon2idBackend(active)
    unregisterArgon2idBackend(stale)

    expect(readyArgon2idBackend()).toBe(active)
  })

  test('starts preload but retains the portable path while the backend is cold', async () => {
    const preload = jest.fn(async () => {})
    const cold = backend({ preload, isReady: () => false })
    registerArgon2idBackend(cold)

    expect(readyArgon2idBackend()).toBeUndefined()
    expect(preload).toHaveBeenCalledTimes(1)
    await preload.mock.results[0].value
  })

  test('contains background preload rejection', async () => {
    const cold = backend({
      preload: async () => {
        throw new Error('native backend unavailable')
      },
      isReady: () => false
    })
    registerArgon2idBackend(cold)

    expect(readyArgon2idBackend()).toBeUndefined()
    await new Promise(resolve => setImmediate(resolve))
  })

  test('coalesces concurrent cold callers and retries after settlement', async () => {
    let finish!: () => void
    const preload = jest.fn(
      () =>
        new Promise<void>(resolve => {
          finish = resolve
        })
    )
    const cold = backend({ preload, isReady: () => false })
    registerArgon2idBackend(cold)

    expect(readyArgon2idBackend()).toBeUndefined()
    expect(readyArgon2idBackend()).toBeUndefined()
    expect(preload).toHaveBeenCalledTimes(1)
    finish()
    await new Promise(resolve => setImmediate(resolve))
    expect(readyArgon2idBackend()).toBeUndefined()
    expect(preload).toHaveBeenCalledTimes(2)
    finish()
    await new Promise(resolve => setImmediate(resolve))
  })

  test('does not let an old preload settlement clear a replacement backend attempt', async () => {
    let finishOld!: () => void
    let finishNew!: () => void
    const old = backend({
      isReady: () => false,
      preload: jest.fn(
        () =>
          new Promise<void>(resolve => {
            finishOld = resolve
          })
      )
    })
    const next = backend({
      isReady: () => false,
      preload: jest.fn(
        () =>
          new Promise<void>(resolve => {
            finishNew = resolve
          })
      )
    })
    registerArgon2idBackend(old)
    readyArgon2idBackend()
    registerArgon2idBackend(next)
    readyArgon2idBackend()
    finishOld()
    await new Promise(resolve => setImmediate(resolve))
    expect(readyArgon2idBackend()).toBeUndefined()
    expect(next.preload).toHaveBeenCalledTimes(1)
    finishNew()
    await new Promise(resolve => setImmediate(resolve))
  })

  test('allows a cold backend to retry after a failed preload', async () => {
    const cold = backend({
      isReady: () => false,
      preload: jest.fn(async () => {
        throw new Error('temporarily unavailable')
      })
    })
    registerArgon2idBackend(cold)
    readyArgon2idBackend()
    readyArgon2idBackend()
    expect(cold.preload).toHaveBeenCalledTimes(1)
    await new Promise(resolve => setImmediate(resolve))
    readyArgon2idBackend()
    expect(cold.preload).toHaveBeenCalledTimes(2)
    await new Promise(resolve => setImmediate(resolve))
  })

  test('accepts only byte output of the requested length', () => {
    const valid = new Uint8Array([1, 2, 3, 4])

    expect(validateArgon2idResult(valid, 4)).toBe(valid)
    expect(() => validateArgon2idResult(valid, 3)).toThrow('Argon2id backend returned 4 bytes; expected 3')
    expect(() => validateArgon2idResult('not bytes' as unknown as Uint8Array, 4)).toThrow(
      'Argon2id backend returned a non-byte result'
    )
  })
})
