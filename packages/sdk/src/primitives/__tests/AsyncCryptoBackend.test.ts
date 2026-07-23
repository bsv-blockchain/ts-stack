import {
  readyAsyncCryptoBackend,
  registerAsyncCryptoBackend,
  unregisterAsyncCryptoBackend,
  type AsyncCryptoBackend,
  type AsyncCryptoOperation
} from '../AsyncCryptoBackend'

function mockBackend (): AsyncCryptoBackend & { ready: boolean, preloads: number } {
  return {
    ready: false,
    preloads: 0,
    preload: async function () {
      this.preloads++
      this.ready = true
    },
    isReady: function () { return this.ready },
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
})
