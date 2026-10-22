import { deriveBrc39OwnedNodeKey } from './Brc39OwnedNodeKey'
import {
  registerArgon2idBackend,
  unregisterArgon2idBackend,
  type AsyncArgon2idBackend
} from '../../utility/Argon2idBackend'
import { BRC39_STREAM_DEFAULT_KDF } from './Brc39Frame'
import { argon2id } from '../../utility/hashWasm'

// Production worker execution requires the ordinary compiled sibling, not a
// transpiler hook in a fresh thread. The package test command builds first.
const compiled =
  require('../../../out/src/storage/portable/Brc39OwnedNodeKey.js') as typeof import('./Brc39OwnedNodeKey')
const header = { ...BRC39_STREAM_DEFAULT_KDF, salt: new Uint8Array(32).fill(5), nonce: new Uint8Array(32).fill(7) }
let backend: AsyncArgon2idBackend | undefined
afterEach(() => {
  if (backend !== undefined) unregisterArgon2idBackend(backend)
  backend = undefined
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
test('real canonical worker allows foreground ticks and matches independent NFC derivation', async () => {
  let ticks = 0
  const timer = setInterval(() => {
    ticks++
  }, 1)
  let result: Uint8Array | undefined
  try {
    result = await compiled.deriveBrc39OwnedNodeKey(header, 'Cafe\u0301', 1024)
    expect(ticks).toBeGreaterThan(0)
    const expected = await argon2id({
      password: new TextEncoder().encode('Caf\u00e9'),
      salt: header.salt,
      iterations: 7,
      memorySize: 131072,
      parallelism: 1,
      hashLength: 32,
      outputType: 'binary'
    })
    try {
      expect(result).toEqual(expected)
    } finally {
      if (expected instanceof Uint8Array) expected.fill(0)
    }
  } finally {
    clearInterval(timer)
    result?.fill(0)
  }
}, 30000)
test('real worker abort waits for exit and a subsequent owned derivation can start', async () => {
  const signal = new AbortController(),
    reason = new Error('synthetic worker abort')
  const pending = compiled.deriveBrc39OwnedNodeKey(header, 'password', 1024, signal.signal)
  signal.abort(reason)
  await expect(pending).rejects.toBe(reason)
  backend = { preload: async () => {}, isReady: () => true, deriveKey: async () => new Uint8Array(32).fill(3) }
  registerArgon2idBackend(backend)
  const result = await compiled.deriveBrc39OwnedNodeKey(header, 'password', 1024)
  expect(result).toEqual(new Uint8Array(32).fill(3))
  result.fill(0)
}, 30000)
test('selected native backend receives captured NFC parameters and original inputs are erased', async () => {
  const result = new Uint8Array(32).fill(13),
    original = { ...header }
  let password: Uint8Array | undefined, salt: Uint8Array | undefined
  backend = {
    preload: async () => {},
    isReady: () => true,
    deriveKey: async options => {
      expect(options.iterations).toBe(7)
      expect(options.memorySize).toBe(131072)
      expect(new TextDecoder().decode(options.password)).toBe('Caf\u00e9')
      password = options.password
      salt = options.salt
      return result
    }
  }
  registerArgon2idBackend(backend)
  const pending = deriveBrc39OwnedNodeKey(original, 'Cafe\u0301', 1024)
  original.iterations = 1
  original.memoryKiB = 8
  expect(await pending).toBe(result)
  expect(password!.every(value => value === 0)).toBe(true)
  expect(salt!.every(value => value === 0)).toBe(true)
  expect(header.salt.some(value => value !== 0)).toBe(true)
  result.fill(0)
})
test('native abort retains admission until actual settlement and erases late key delivery', async () => {
  const started = deferred<void>(),
    key = deferred<Uint8Array>(),
    controller = new AbortController()
  backend = {
    preload: async () => {},
    isReady: () => true,
    deriveKey: async () => {
      started.resolve()
      return key.promise
    }
  }
  registerArgon2idBackend(backend)
  const pending = deriveBrc39OwnedNodeKey(header, 'password', 1024, controller.signal)
  await started.promise
  const reason = new Error('synthetic native cancellation')
  controller.abort(reason)
  let settled = false
  void pending
    .finally(() => {
      settled = true
    })
    .catch(() => {})
  await Promise.resolve()
  expect(settled).toBe(false)
  await expect(deriveBrc39OwnedNodeKey(header, 'password', 1024)).rejects.toThrow('retains admission')
  const late = new Uint8Array(32).fill(23)
  key.resolve(late)
  await expect(pending).rejects.toBe(reason)
  expect(late.every(value => value === 0)).toBe(true)
})
test('selected native failure remains exact and does not fall back to a worker', async () => {
  const failure = new Error('synthetic native derivation failure')
  backend = {
    preload: async () => {},
    isReady: () => true,
    deriveKey: async () => {
      throw failure
    }
  }
  registerArgon2idBackend(backend)
  await expect(deriveBrc39OwnedNodeKey(header, 'password', 1024)).rejects.toBe(failure)
})
