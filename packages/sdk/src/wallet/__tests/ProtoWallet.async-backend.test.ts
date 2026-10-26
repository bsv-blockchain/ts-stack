import {
  type AsyncCryptoBackend,
  type AsyncCryptoOperation,
  KeyDeriver,
  PrivateKey,
  ProtoWallet,
  PublicKey,
  registerAsyncCryptoBackend,
  unregisterAsyncCryptoBackend
} from '../../../mod'

function backendFor(
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

function withoutRequiredSignPadding(der: number[]): number[] | undefined {
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

  it('rejects non-canonical DER before accelerated verification', async () => {
    const wallet = new ProtoWallet(new PrivateKey(42))
    let fixture: { digest: number[]; canonical: number[]; nonCanonical: number[] } | undefined
    for (let suffix = 0; suffix < 256 && fixture === undefined; suffix++) {
      const digest = [...Array.from({ length: 31 }).fill(0), suffix]
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
      await expect(
        wallet.verifySignature({
          hashToDirectlyVerify: fixture.digest,
          signature: fixture.nonCanonical,
          protocolID,
          keyID,
          counterparty: 'self'
        })
      ).rejects.toThrow('canonical DER-encoded ECDSA signature')
      expect(verifyDigest).not.toHaveBeenCalled()
    } finally {
      unregisterAsyncCryptoBackend(backend)
    }
  })

  it('keeps non-32-byte direct digests on the JavaScript path', async () => {
    const wallet = new ProtoWallet(new PrivateKey(42))
    const signDigest = jest.fn(async () => new Uint8Array())
    const verifyDigest = jest.fn(async () => true)
    const backend = backendFor(['signDigest', 'verifyDigest'], { signDigest, verifyDigest })
    registerAsyncCryptoBackend(backend)
    try {
      const oversizedDigest = [1, ...Array.from({ length: 32 }).fill(0)]
      await expect(
        wallet.createSignature({
          hashToDirectlySign: oversizedDigest,
          protocolID,
          keyID,
          counterparty: 'self'
        })
      ).rejects.toThrow()
      expect(signDigest).not.toHaveBeenCalled()
      expect(verifyDigest).not.toHaveBeenCalled()
    } finally {
      unregisterAsyncCryptoBackend(backend)
    }
  })

  it('rejects a truthy non-boolean backend verification verdict', async () => {
    const wallet = new ProtoWallet(new PrivateKey(42))
    const backend = backendFor(['verifyDigest'], {
      verifyDigest: async () => 'false' as unknown as boolean
    })
    registerAsyncCryptoBackend(backend)
    try {
      const { signature } = await wallet.createSignature({
        hashToDirectlySign: Array.from({ length: 32 }).fill(1),
        protocolID,
        keyID,
        counterparty: 'self'
      })
      await expect(
        wallet.verifySignature({
          hashToDirectlyVerify: Array.from({ length: 32 }).fill(1),
          signature,
          protocolID,
          keyID,
          counterparty: 'self'
        })
      ).rejects.toThrow('Signature is not valid')
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
      await expect(wallet.getPublicKey({ identityKey: true })).rejects.toThrow('expected 33')
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
      await expect(
        wallet.createSignature({
          hashToDirectlySign: Array.from({ length: 32 }).fill(0),
          protocolID,
          keyID,
          counterparty: 'self'
        })
      ).rejects.toThrow()
    } finally {
      unregisterAsyncCryptoBackend(backend)
    }
  })

  it('rejects malformed multiplied points before symmetric derivation', async () => {
    const keyDeriver = new KeyDeriver(new PrivateKey(42))
    const backend = backendFor(
      ['multiplyPublicKey', 'publicKeyFromPrivate', 'tweakPrivateKeyAdd', 'tweakPublicKeyAdd'],
      {
        multiplyPublicKey: async () => new Uint8Array(32)
      }
    )
    registerAsyncCryptoBackend(backend)
    try {
      await expect(keyDeriver.deriveSymmetricKeyAsync(protocolID, keyID, 'anyone')).rejects.toThrow(
        'expected 33'
      )
    } finally {
      unregisterAsyncCryptoBackend(backend)
    }
  })

  it('snapshots direct async derivation domains and root authority before yielding', async () => {
    const originalRoot = new PrivateKey(42)
    const keyDeriver = new KeyDeriver(originalRoot)
    const counterparty = new PrivateKey(69).toPublicKey()
    const mutableProtocol: [0, string] = [0, 'original async derivation']
    const expected = new KeyDeriver(originalRoot).derivePublicKey(
      mutableProtocol,
      keyID,
      counterparty
    )
    let resume!: () => void
    const gate = new Promise<void>(resolve => {
      resume = resolve
    })
    const backend = backendFor(
      ['multiplyPublicKey', 'publicKeyFromPrivate', 'tweakPrivateKeyAdd', 'tweakPublicKeyAdd'],
      {
        multiplyPublicKey: async (publicKey, privateKey) => {
          await gate
          return Uint8Array.from(
            PublicKey.fromDER(Array.from(publicKey))
              .deriveSharedSecret(new PrivateKey(Array.from(privateKey)))
              .encode(true) as number[]
          )
        },
        tweakPublicKeyAdd: async (publicKey, tweak) =>
          Uint8Array.from(
            PublicKey.fromDER(Array.from(publicKey))
              .add(new PrivateKey(Array.from(tweak)).toPublicKey())
              .encode(true) as number[]
          ),
        tweakPrivateKeyAdd: async (privateKey, tweak) =>
          Uint8Array.from(
            new PrivateKey(
              new PrivateKey(Array.from(privateKey)).add(new PrivateKey(Array.from(tweak)))
            ).toArray('be', 32)
          ),
        publicKeyFromPrivate: async privateKey =>
          Uint8Array.from(
            new PrivateKey(Array.from(privateKey)).toPublicKey().encode(true) as number[]
          )
      }
    )
    registerAsyncCryptoBackend(backend)
    try {
      const pending = keyDeriver.derivePublicKeyAsync(mutableProtocol, keyID, counterparty, false)
      mutableProtocol[1] = 'substituted async derivation'
      keyDeriver.rootKey = new PrivateKey(99)
      resume()
      await expect(pending).resolves.toEqual(expected)
    } finally {
      unregisterAsyncCryptoBackend(backend)
    }
  })
})
