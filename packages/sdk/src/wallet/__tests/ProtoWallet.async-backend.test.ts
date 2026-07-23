import {
  type AsyncCryptoBackend,
  type AsyncCryptoOperation,
  KeyDeriver,
  PrivateKey,
  ProtoWallet,
  registerAsyncCryptoBackend,
  unregisterAsyncCryptoBackend
} from '../../../mod'

function backendFor (
  operations: readonly AsyncCryptoOperation[],
  overrides: Partial<AsyncCryptoBackend> = {}
): AsyncCryptoBackend {
  return {
    preload: async () => {},
    isReady: () => true,
    supportsCrypto: operation => operations.includes(operation),
    signDigest: async () => new Uint8Array(),
    verifyDigest: async () => false,
    verifyDigestBatch: async () => [],
    publicKeyFromPrivate: async () => new Uint8Array(),
    multiplyPublicKey: async () => new Uint8Array(),
    tweakPublicKeyAdd: async () => new Uint8Array(),
    tweakPrivateKeyAdd: async () => new Uint8Array(),
    ...overrides
  }
}

function withoutRequiredSignPadding (der: number[]): number[] | undefined {
  const rLength = der[3]
  const rStart = 4
  const sLengthIndex = rStart + rLength + 1
  const sStart = sLengthIndex + 1
  if (der[rStart] === 0) {
    const nonCanonical = [...der]
    nonCanonical.splice(rStart, 1)
    nonCanonical[1]--
    nonCanonical[3]--
    return nonCanonical
  }
  if (der[sStart] === 0) {
    const nonCanonical = [...der]
    nonCanonical.splice(sStart, 1)
    nonCanonical[1]--
    nonCanonical[sLengthIndex]--
    return nonCanonical
  }
}

describe('ProtoWallet optional async backend boundaries', () => {
  const protocolID: [0, string] = [0, 'async backend boundary']
  const keyID = 'test'

  it('canonicalizes lenient DER before accelerated verification', async () => {
    const wallet = new ProtoWallet(new PrivateKey(42))
    let fixture: { digest: number[], canonical: number[], nonCanonical: number[] } | undefined
    for (let suffix = 0; suffix < 256 && fixture === undefined; suffix++) {
      const digest = [...new Array(31).fill(0), suffix]
      const { signature } = await wallet.createSignature({
        hashToDirectlySign: digest,
        protocolID,
        keyID,
        counterparty: 'self'
      })
      const nonCanonical = withoutRequiredSignPadding(signature)
      if (nonCanonical !== undefined) {
        fixture = { digest, canonical: signature, nonCanonical }
      }
    }
    if (fixture === undefined) throw new Error('could not construct a padded DER fixture')

    const verifyDigest = jest.fn(async () => true)
    const backend = backendFor(['verifyDigest'], { verifyDigest })
    registerAsyncCryptoBackend(backend)
    try {
      await expect(wallet.verifySignature({
        hashToDirectlyVerify: fixture.digest,
        signature: fixture.nonCanonical,
        protocolID,
        keyID,
        counterparty: 'self'
      })).resolves.toEqual({ valid: true })
      expect(Array.from(verifyDigest.mock.calls[0][2])).toEqual(fixture.canonical)
    } finally {
      unregisterAsyncCryptoBackend(backend)
    }
  })

  it('keeps non-32-byte direct digests on the JavaScript path', async () => {
    const wallet = new ProtoWallet(new PrivateKey(42))
    const signDigest = jest.fn(async () => new Uint8Array())
    const verifyDigest = jest.fn(async () => true)
    const backend = backendFor(
      ['signDigest', 'verifyDigest'],
      { signDigest, verifyDigest }
    )
    registerAsyncCryptoBackend(backend)
    try {
      const oversizedDigest = [1, ...new Array(32).fill(0)]
      await expect(wallet.createSignature({
        hashToDirectlySign: oversizedDigest,
        protocolID,
        keyID,
        counterparty: 'self'
      })).rejects.toThrow()
      expect(signDigest).not.toHaveBeenCalled()
      expect(verifyDigest).not.toHaveBeenCalled()
    } finally {
      unregisterAsyncCryptoBackend(backend)
    }
  })

  it('rejects malformed public keys returned by a backend', async () => {
    const wallet = new ProtoWallet(new PrivateKey(42))
    const backend = backendFor(['publicKeyFromPrivate'], {
      publicKeyFromPrivate: async () => new Uint8Array(32)
    })
    registerAsyncCryptoBackend(backend)
    try {
      await expect(wallet.getPublicKey({ identityKey: true }))
        .rejects.toThrow('expected 33')
    } finally {
      unregisterAsyncCryptoBackend(backend)
    }
  })

  it('rejects malformed signatures returned by a backend', async () => {
    const wallet = new ProtoWallet(new PrivateKey(42))
    const backend = backendFor(['signDigest'], {
      signDigest: async () => Uint8Array.of(1)
    })
    registerAsyncCryptoBackend(backend)
    try {
      await expect(wallet.createSignature({
        hashToDirectlySign: new Array(32).fill(0),
        protocolID,
        keyID,
        counterparty: 'self'
      })).rejects.toThrow()
    } finally {
      unregisterAsyncCryptoBackend(backend)
    }
  })

  it('rejects malformed multiplied points before symmetric derivation', async () => {
    const keyDeriver = new KeyDeriver(new PrivateKey(42))
    const backend = backendFor([
      'multiplyPublicKey',
      'publicKeyFromPrivate',
      'tweakPrivateKeyAdd',
      'tweakPublicKeyAdd'
    ], {
      multiplyPublicKey: async () => new Uint8Array(32)
    })
    registerAsyncCryptoBackend(backend)
    try {
      await expect(keyDeriver.deriveSymmetricKeyAsync(
        protocolID,
        keyID,
        'anyone'
      )).rejects.toThrow('expected 33')
    } finally {
      unregisterAsyncCryptoBackend(backend)
    }
  })
})
