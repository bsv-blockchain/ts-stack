import { afterEach, describe, expect, it, vi } from 'vitest'
import { argon2id } from '../../src/utility/hashWasm'

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

afterEach(() => {
  wasmArgon2id.mockReset()
  if (webAssemblyDescriptor === undefined) {
    Reflect.deleteProperty(globalThis, 'WebAssembly')
  } else {
    Object.defineProperty(globalThis, 'WebAssembly', webAssemblyDescriptor)
  }
})

describe('Argon2id derivation', () => {
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

  it('does not hide unrelated Argon2 errors', async () => {
    const error = new Error('Invalid Argon2 options')
    wasmArgon2id.mockRejectedValue(error)

    await expect(argon2id(options)).rejects.toBe(error)
  })
})
