/**
 * Generic operations that an optional asynchronous cryptography backend can
 * accelerate without changing the SDK's synchronous primitive APIs.
 */
export type AsyncCryptoOperation =
  | 'signDigest'
  | 'verifyDigest'
  | 'verifyDigestBatch'
  | 'publicKeyFromPrivate'
  | 'multiplyPublicKey'
  | 'tweakPublicKeyAdd'
  | 'tweakPrivateKeyAdd'

export interface DigestVerification {
  publicKey: Uint8Array
  digest: Uint8Array
  signature: Uint8Array
}

/**
 * Optional high-performance implementation of generic secp256k1 primitives.
 *
 * Implementations must treat a returned result as authoritative. The SDK only
 * falls back before selecting a backend: when it is absent, cold, or does not
 * advertise the requested operation.
 */
export interface AsyncCryptoBackend {
  preload: () => Promise<void>
  isReady: () => boolean
  supportsCrypto: (operation: AsyncCryptoOperation) => boolean
  signDigest: (privateKey: Uint8Array, digest: Uint8Array) => Promise<Uint8Array>
  verifyDigest: (
    publicKey: Uint8Array,
    digest: Uint8Array,
    signature: Uint8Array
  ) => Promise<boolean>
  verifyDigestBatch: (items: readonly DigestVerification[]) => Promise<boolean[]>
  publicKeyFromPrivate: (privateKey: Uint8Array) => Promise<Uint8Array>
  multiplyPublicKey: (publicKey: Uint8Array, scalar: Uint8Array) => Promise<Uint8Array>
  tweakPublicKeyAdd: (publicKey: Uint8Array, tweak: Uint8Array) => Promise<Uint8Array>
  tweakPrivateKeyAdd: (privateKey: Uint8Array, tweak: Uint8Array) => Promise<Uint8Array>
}

interface OptionalBackendGlobal {
  __bsvSdkAsyncCryptoBackendV1?: AsyncCryptoBackend
}

function backendGlobal (): typeof globalThis & OptionalBackendGlobal {
  return globalThis as typeof globalThis & OptionalBackendGlobal
}

/** Installs an optional process/page-wide backend for opportunistic SDK use. */
export function registerAsyncCryptoBackend (backend: AsyncCryptoBackend): void {
  backendGlobal().__bsvSdkAsyncCryptoBackendV1 = backend
}

/** Removes `backend` if it is still the active optional implementation. */
export function unregisterAsyncCryptoBackend (backend: AsyncCryptoBackend): void {
  const registry = backendGlobal()
  if (registry.__bsvSdkAsyncCryptoBackendV1 === backend) {
    delete registry.__bsvSdkAsyncCryptoBackendV1
  }
}

/**
 * Returns a warm backend supporting `operation`. A cold backend is prepared in
 * the background while the current call retains the existing JavaScript path.
 */
export function readyAsyncCryptoBackend (
  operation: AsyncCryptoOperation
): AsyncCryptoBackend | undefined {
  const backend = backendGlobal().__bsvSdkAsyncCryptoBackendV1
  if (backend === undefined) return undefined
  if (!backend.isReady()) {
    void backend.preload().catch(() => {})
    return undefined
  }
  return backend.supportsCrypto(operation) ? backend : undefined
}
