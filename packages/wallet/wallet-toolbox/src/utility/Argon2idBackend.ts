/** Parameters shared by every interoperable Argon2id implementation. */
export interface Argon2idOptions {
  password: Uint8Array
  salt: Uint8Array
  iterations: number
  parallelism: number
  memorySize: number
  hashLength: number
}

/**
 * Optional asynchronous Argon2id implementation supplied by a host runtime.
 *
 * A selected backend is authoritative: derivation failures are propagated and
 * never retried with another implementation. Hosts should report readiness only
 * after proving that their native implementation is available and interoperable.
 */
export interface AsyncArgon2idBackend {
  preload: () => Promise<void>
  isReady: () => boolean
  deriveKey: (options: Readonly<Argon2idOptions>) => Promise<Uint8Array>
}

interface OptionalBackendGlobal {
  __bsvWalletToolboxArgon2idBackendV1?: AsyncArgon2idBackend
}

function backendGlobal(): typeof globalThis & OptionalBackendGlobal {
  return globalThis as typeof globalThis & OptionalBackendGlobal
}

/** Installs a process/page-wide optional Argon2id backend. */
export function registerArgon2idBackend(backend: AsyncArgon2idBackend): void {
  backendGlobal().__bsvWalletToolboxArgon2idBackendV1 = backend
}

/** Removes `backend` if it is still the active optional implementation. */
export function unregisterArgon2idBackend(backend: AsyncArgon2idBackend): void {
  const registry = backendGlobal()
  if (registry.__bsvWalletToolboxArgon2idBackendV1 === backend) {
    delete registry.__bsvWalletToolboxArgon2idBackendV1
  }
}

/**
 * Returns a proven-ready backend. A cold backend is prepared in the background
 * while the current derivation retains the portable implementation path.
 */
export function readyArgon2idBackend(): AsyncArgon2idBackend | undefined {
  const backend = backendGlobal().__bsvWalletToolboxArgon2idBackendV1
  if (backend === undefined) return undefined
  if (!backend.isReady()) {
    void backend.preload().catch(() => {})
    return undefined
  }
  return backend
}

/** Rejects malformed native output before it can become wallet key material. */
export function validateArgon2idResult(value: Uint8Array, expectedLength: number): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError('Argon2id backend returned a non-byte result')
  }
  if (value.length !== expectedLength) {
    throw new Error(`Argon2id backend returned ${value.length} bytes; expected ${expectedLength}`)
  }
  return value
}
