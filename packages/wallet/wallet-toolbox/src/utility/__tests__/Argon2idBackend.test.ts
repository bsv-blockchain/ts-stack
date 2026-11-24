import { installBrowserArgon2idWorker } from '../installBrowserArgon2idWorker'
import * as hashWasm from '../hashWasm'
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

// Only rejection is simulated here. Successful KDF/NFC/cancellation and native
// channel metadata are verified by BrowserArgon2idWorker.native.test.cjs.
describe('dedicated worker channel rejection', () => {
  const names = ['postMessage', 'close', 'addEventListener'] as const
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const post = jest.fn(),
    close = jest.fn(),
    listen = jest.fn()
  const invalid = [
    { label: 'nonempty origin', origin: 'https://example.invalid', source: null, isTrusted: true },
    { label: 'nonnull source', origin: '', source: {}, isTrusted: true },
    { label: 'synthetic event', origin: '', source: null, isTrusted: false }
  ]
  beforeEach(() => {
    for (const [name, value] of [
      ['postMessage', post],
      ['close', close],
      ['addEventListener', listen]
    ] as const) {
      originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
    }
    post.mockClear()
    close.mockClear()
    listen.mockClear()
  })
  afterEach(() => {
    jest.restoreAllMocks()
    for (const name of names) {
      const descriptor = originals.get(name)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  })
  test.each(invalid)('installer rejects $label before a request derivation', async metadata => {
    const derive = jest.spyOn(hashWasm, 'argon2id').mockResolvedValue(new Uint8Array(32))
    installBrowserArgon2idWorker({
      maximumPasswordBytes: 1024,
      maximumIterations: 7,
      maximumMemoryKiB: 131072,
      maximumParallelism: 1,
      maximumMilliseconds: 30000
    })
    await new Promise(resolve => setImmediate(resolve))
    expect(post).toHaveBeenCalledWith({ type: 'ready', version: 1 }, [])
    expect(derive).toHaveBeenCalledTimes(1)
    expect(listen).toHaveBeenCalledWith('message', expect.any(Function), { once: true })
    const request = {
      type: 'derive',
      password: new ArrayBuffer(1),
      salt: new ArrayBuffer(8),
      iterations: 1,
      memorySize: 8,
      parallelism: 1,
      hashLength: 32
    }
    listen.mock.calls[0][1]({ ...metadata, data: request })
    await new Promise(resolve => setImmediate(resolve))
    expect(derive).toHaveBeenCalledTimes(1)
    expect(post.mock.calls.map(call => call[0])).toEqual([{ type: 'ready', version: 1 }, { type: 'failed' }])
    expect(close).toHaveBeenCalledTimes(1)
  })
  test.each(invalid)('coverage bootstrap rejects $label before installing the KDF', metadata => {
    jest.isolateModules(() => {
      const installer = require('../installBrowserArgon2idWorker') as typeof import('../installBrowserArgon2idWorker')
      const install = jest.spyOn(installer, 'installBrowserArgon2idWorker').mockImplementation(() => {})
      require('../../../client/test/argon2id-coverage-worker')
      expect(listen).toHaveBeenCalledWith('message', expect.any(Function), { once: true })
      listen.mock.calls[0][1]({ ...metadata, data: 'coverage-bootstrap-v1', ports: [{ postMessage: jest.fn() }] })
      expect(install).not.toHaveBeenCalled()
      expect(post).not.toHaveBeenCalled()
      expect(close).toHaveBeenCalledTimes(1)
    })
  })
})
