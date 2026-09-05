import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { argon2id } from '../../src/utility/hashWasm'
import {
  registerArgon2idBackend,
  unregisterArgon2idBackend,
  type AsyncArgon2idBackend
} from '../../src/utility/Argon2idBackend'

const webAssemblyDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'WebAssembly')
const wasmArgon2id = vi.hoisted(() => vi.fn())

vi.mock('hash-wasm/dist/argon2.umd.min.js', () => ({
  default: { argon2id: wasmArgon2id }
}))

const options = {
  password: new TextEncoder().encode('mobile-wallet-password'),
  salt: Uint8Array.from({ length: 16 }, (_, index) => index),
  iterations: 2,
  memorySize: 1024,
  parallelism: 1,
  hashLength: 32,
  outputType: 'binary' as const
}

const expectedHex = 'fb199af9488d7935c4e60f2ff21c84628a30bde9dde66ff66f0bdd4035383c71'
const toHex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
let registeredBackend: AsyncArgon2idBackend | undefined

function registerBackend(overrides: Partial<AsyncArgon2idBackend> = {}): AsyncArgon2idBackend {
  const backend: AsyncArgon2idBackend = {
    preload: vi.fn(async () => {}),
    isReady: vi.fn(() => true),
    deriveKey: vi.fn(async () => new Uint8Array(options.hashLength).fill(7)),
    ...overrides
  }
  registerArgon2idBackend(backend)
  registeredBackend = backend
  return backend
}

afterEach(() => {
  if (registeredBackend !== undefined) {
    unregisterArgon2idBackend(registeredBackend)
    registeredBackend = undefined
  }
  wasmArgon2id.mockReset()
  if (webAssemblyDescriptor === undefined) {
    Reflect.deleteProperty(globalThis, 'WebAssembly')
  } else {
    Object.defineProperty(globalThis, 'WebAssembly', webAssemblyDescriptor)
  }
})

describe('Argon2id derivation', () => {
  it('preserves the published hash-wasm type contract', () => {
    expectTypeOf(argon2id).toEqualTypeOf<typeof import('hash-wasm').argon2id>()
  })

  it('uses a proven-ready host backend before WebAssembly', async () => {
    const expected = new Uint8Array(options.hashLength).fill(9)
    const backend = registerBackend({ deriveKey: vi.fn(async () => expected) })

    await expect(argon2id(options)).resolves.toBe(expected)
    expect(backend.deriveKey).toHaveBeenCalledWith({
      password: options.password,
      salt: options.salt,
      iterations: options.iterations,
      parallelism: options.parallelism,
      memorySize: options.memorySize,
      hashLength: options.hashLength
    })
    expect(wasmArgon2id).not.toHaveBeenCalled()
  })

  it('retains hash-wasm for secret-bearing binary requests', async () => {
    const backend = registerBackend()
    const expected = new Uint8Array(options.hashLength).fill(5)
    const secretOptions = { ...options, secret: Uint8Array.of(11, 12, 13) }
    wasmArgon2id.mockResolvedValue(expected)

    await expect(argon2id(secretOptions)).resolves.toBe(expected)
    expect(wasmArgon2id).toHaveBeenCalledWith(secretOptions)
    expect(backend.deriveKey).not.toHaveBeenCalled()
  })

  it.each([
    { outputType: undefined, expected: 'default-hex' },
    { outputType: 'hex' as const, expected: 'explicit-hex' },
    { outputType: 'encoded' as const, expected: '$argon2id$v=19$m=1024,t=2,p=1$encoded' }
  ])('retains hash-wasm for string inputs and $outputType output', async ({ outputType, expected }) => {
    const backend = registerBackend()
    const stringOptions = {
      ...options,
      password: 'password',
      salt: 'sixteen-byte-slt',
      outputType
    }
    wasmArgon2id.mockResolvedValue(expected)

    await expect(argon2id(stringOptions)).resolves.toBe(expected)
    expect(wasmArgon2id).toHaveBeenCalledWith(stringOptions)
    expect(backend.deriveKey).not.toHaveBeenCalled()
  })

  it('retains hash-wasm for non-byte typed-array inputs', async () => {
    const backend = registerBackend()
    const typedArrayOptions = {
      ...options,
      password: new Uint16Array([1, 2]),
      salt: new Uint32Array([3, 4, 5, 6])
    }
    const expected = new Uint8Array(options.hashLength).fill(6)
    wasmArgon2id.mockResolvedValue(expected)

    await expect(argon2id(typedArrayOptions)).resolves.toBe(expected)
    expect(wasmArgon2id).toHaveBeenCalledWith(typedArrayOptions)
    expect(backend.deriveKey).not.toHaveBeenCalled()
  })

  it('does not reinterpret a secret-bearing request when WebAssembly is unavailable', async () => {
    const backend = registerBackend()
    const error = new Error('WebAssembly is not supported in this environment!')
    const secretOptions = { ...options, secret: Uint8Array.of(21, 22, 23) }
    wasmArgon2id.mockRejectedValue(error)
    Object.defineProperty(globalThis, 'WebAssembly', {
      configurable: true,
      value: undefined
    })

    await expect(argon2id(secretOptions)).rejects.toBe(error)
    expect(wasmArgon2id).toHaveBeenCalledWith(secretOptions)
    expect(backend.deriveKey).not.toHaveBeenCalled()
  })

  it('preloads a cold host backend while retaining the portable path', async () => {
    const backend = registerBackend({ isReady: vi.fn(() => false) })
    const expected = Uint8Array.of(1, 2, 3)
    wasmArgon2id.mockResolvedValue(expected)

    await expect(argon2id(options)).resolves.toBe(expected)
    expect(backend.preload).toHaveBeenCalledTimes(1)
    expect(backend.deriveKey).not.toHaveBeenCalled()
  })

  it('does not hide a selected host backend derivation failure', async () => {
    const error = new Error('Native Argon2id failed')
    registerBackend({ deriveKey: vi.fn(async () => await Promise.reject(error)) })

    await expect(argon2id(options)).rejects.toBe(error)
    expect(wasmArgon2id).not.toHaveBeenCalled()
  })

  it.each([
    { result: Uint8Array.of(1, 2, 3), message: 'returned 3 bytes; expected 32' },
    { result: [1, 2, 3] as unknown as Uint8Array, message: 'returned a non-byte result' }
  ])('rejects malformed host backend output: $message', async ({ result, message }) => {
    registerBackend({ deriveKey: vi.fn(async () => result) })

    await expect(argon2id(options)).rejects.toThrow(message)
    expect(wasmArgon2id).not.toHaveBeenCalled()
  })

  it('uses the compatible JavaScript fallback when WebAssembly is unavailable', async () => {
    wasmArgon2id.mockRejectedValue(new Error('WebAssembly is not supported in this environment!'))
    Object.defineProperty(globalThis, 'WebAssembly', {
      configurable: true,
      value: undefined
    })

    expect(toHex(await argon2id(options))).toBe(expectedHex)
  })

  it('retains the WebAssembly fast path when it succeeds', async () => {
    const expected = Uint8Array.of(1, 2, 3)
    wasmArgon2id.mockResolvedValue(expected)

    await expect(argon2id(options)).resolves.toBe(expected)
  })

  it.each([new Error('WebAssembly.Module could not compile'), 'WebAssembly is unavailable'])(
    'falls back when WebAssembly initialization rejects with %s',
    async error => {
      wasmArgon2id.mockRejectedValue(error)

      expect(toHex(await argon2id(options))).toBe(expectedHex)
    }
  )

  it.each([true, false])('does not hide unrelated Argon2 errors with WebAssembly present: %s', async present => {
    if (!present) {
      Object.defineProperty(globalThis, 'WebAssembly', { configurable: true, value: undefined })
    }
    const error = new Error('Invalid Argon2 options')
    wasmArgon2id.mockRejectedValue(error)

    await expect(argon2id(options)).rejects.toBe(error)
  })
})
