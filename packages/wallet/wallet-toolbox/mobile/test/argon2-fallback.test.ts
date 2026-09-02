import { afterEach, describe, expect, it } from 'vitest'
import { argon2id } from '../../src/utility/hashWasm'

const webAssemblyDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'WebAssembly')

afterEach(() => {
  if (webAssemblyDescriptor === undefined) {
    Reflect.deleteProperty(globalThis, 'WebAssembly')
  } else {
    Object.defineProperty(globalThis, 'WebAssembly', webAssemblyDescriptor)
  }
})

describe('Argon2id derivation', () => {
  it('uses the compatible JavaScript fallback when WebAssembly is unavailable', async () => {
    Object.defineProperty(globalThis, 'WebAssembly', {
      configurable: true,
      value: undefined
    })

    const derived = await argon2id({
      password: new TextEncoder().encode('mobile-wallet-password'),
      salt: Uint8Array.from({ length: 16 }, (_, index) => index),
      iterations: 2,
      memorySize: 1024,
      parallelism: 1,
      hashLength: 32,
      outputType: 'binary'
    })

    expect(Array.from(derived, byte => byte.toString(16).padStart(2, '0')).join('')).toBe(
      'fb199af9488d7935c4e60f2ff21c84628a30bde9dde66ff66f0bdd4035383c71'
    )
  })
})
