import {
  readyAsyncCryptoBackend,
  registerAsyncCryptoBackend,
  unregisterAsyncCryptoBackend,
  isAsyncCryptoDigest,
  validateAsyncCryptoBytes,
  type AsyncCryptoBackend,
  type AsyncCryptoOperation
} from '../AsyncCryptoBackend'

function mockBackend(): AsyncCryptoBackend & { ready: boolean; preloads: number } {
  return {
    ready: false,
    preloads: 0,
    preload: async function () {
      this.preloads++
      this.ready = true
    },
    isReady: function () {
      return this.ready
    },
    supportsCrypto: (operation: AsyncCryptoOperation) => operation === 'signDigest',
    signDigest: async () => new Uint8Array(),
    verifyDigest: async () => false,
    verifyDigestBatch: async () => [],
    publicKeyFromPrivate: async () => new Uint8Array(),
    multiplyPublicKey: async () => new Uint8Array(),
    tweakPublicKeyAdd: async () => new Uint8Array(),
    tweakPrivateKeyAdd: async () => new Uint8Array()
  }
}

describe('optional async cryptography backend', () => {
  it('never waits for a cold backend and uses it only after it is warm', async () => {
    const backend = mockBackend()
    registerAsyncCryptoBackend(backend)
    try {
      expect(readyAsyncCryptoBackend('signDigest')).toBeUndefined()
      expect(backend.preloads).toBe(1)
      await Promise.resolve()
      expect(readyAsyncCryptoBackend('signDigest')).toBe(backend)
      expect(readyAsyncCryptoBackend('verifyDigest')).toBeUndefined()
    } finally {
      unregisterAsyncCryptoBackend(backend)
    }
  })

  it('recognizes only canonical 32-byte digests', () => {
    expect(isAsyncCryptoDigest(Array.from({ length: 32 }).fill(0))).toBe(true)
    expect(isAsyncCryptoDigest(Array.from({ length: 31 }).fill(0))).toBe(false)
    expect(isAsyncCryptoDigest([...Array.from({ length: 31 }).fill(0), 256])).toBe(false)
  })

  it('rejects malformed backend byte results', () => {
    expect(validateAsyncCryptoBytes('publicKeyFromPrivate', new Uint8Array(33), 33)).toHaveLength(
      33
    )
    expect(() => validateAsyncCryptoBytes('publicKeyFromPrivate', new Uint8Array(32), 33)).toThrow(
      'expected 33'
    )
  })
})
