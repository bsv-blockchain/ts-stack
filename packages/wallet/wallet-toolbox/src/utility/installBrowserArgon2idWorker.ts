import { argon2id } from './hashWasm'
import { browserArgon2idWorkerPolicy, type BrowserArgon2idWorkerPolicy } from './BrowserArgon2idWorker'

/** Called only by the host's fixed bundled dedicated-worker entry. Importing
 * this module in a client/mobile/main bundle installs nothing. The worker has
 * no identity, storage, network credentials or wallet records. */
export function installBrowserArgon2idWorker(selected: BrowserArgon2idWorkerPolicy): void {
  if (
    typeof document !== 'undefined' ||
    typeof globalThis.postMessage !== 'function' ||
    typeof globalThis.close !== 'function'
  )
    throw new Error('Argon2id installer requires a dedicated worker global')
  const policy = browserArgon2idWorkerPolicy(selected),
    post = globalThis.postMessage,
    close = globalThis.close
  let used = false,
    ready = false
  const finish = () => Reflect.apply(close, globalThis, [])
  const send = (value: unknown, transfer: ArrayBuffer[] = []) => Reflect.apply(post, globalThis, [value, transfer])
  const derive = async (data: unknown): Promise<void> => {
    let password: Uint8Array | undefined, salt: Uint8Array | undefined, key: Uint8Array | undefined
    try {
      if (!ready || used || typeof data !== 'object' || data === null) throw new TypeError('Invalid worker KDF phase')
      used = true
      const input = data as Record<string, unknown>
      if (input.type !== 'derive' || !(input.password instanceof ArrayBuffer) || !(input.salt instanceof ArrayBuffer))
        throw new TypeError('Invalid worker KDF buffer request')
      password = new Uint8Array(input.password)
      salt = new Uint8Array(input.salt)
      if (password.byteLength > policy.maximumPasswordBytes || salt.byteLength < 1 || salt.byteLength > 255)
        throw new RangeError('Worker KDF input bound reached')
      const integer = (value: unknown, maximum: number): number => {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum)
          throw new RangeError('Worker KDF parameter bound reached')
        return value
      }
      const hashLength = integer(input.hashLength, 1024)
      const result = await argon2id({
        password,
        salt,
        iterations: integer(input.iterations, policy.maximumIterations),
        memorySize: integer(input.memorySize, policy.maximumMemoryKiB),
        parallelism: integer(input.parallelism, policy.maximumParallelism),
        hashLength,
        outputType: 'binary'
      })
      if (!(result instanceof Uint8Array)) throw new TypeError('Invalid worker KDF output')
      key = result
      if (
        key.byteLength !== hashLength ||
        !(key.buffer instanceof ArrayBuffer) ||
        key.byteOffset !== 0 ||
        key.buffer.byteLength !== hashLength
      )
        throw new TypeError('Worker KDF must transfer an exclusive key buffer')
      password.fill(0)
      salt.fill(0)
      send({ type: 'key', key: key.buffer }, [key.buffer])
      key = undefined
    } catch {
      send({ type: 'failed' })
    } finally {
      password?.fill(0)
      salt?.fill(0)
      key?.fill(0)
      finish()
    }
  }
  globalThis.addEventListener(
    'message',
    (event: MessageEvent<unknown>) => {
      // Dedicated workers receive native MessagePort events with an empty
      // origin and null source. A Window hostname allowlist is not this channel.
      if (event.origin !== '' || event.source !== null || !event.isTrusted) {
        try {
          send({ type: 'failed' })
        } finally {
          finish()
        }
        return
      }
      void derive(event.data)
    },
    { once: true }
  )
  // A small non-wallet derivation initializes the actual portable implementation
  // before readiness. No canonical export uses these weaker primer parameters.
  void (async () => {
    const password = new Uint8Array(1),
      salt = new Uint8Array(8)
    let key: Uint8Array | undefined
    try {
      const result = await argon2id({
        password,
        salt,
        iterations: 1,
        memorySize: 8,
        parallelism: 1,
        hashLength: 32,
        outputType: 'binary'
      })
      if (!(result instanceof Uint8Array) || result.byteLength !== 32)
        throw new TypeError('Worker KDF initialization failed')
      key = result
      key.fill(0)
      ready = true
      send({ type: 'ready', version: 1 })
    } catch {
      send({ type: 'failed' })
      finish()
    } finally {
      password.fill(0)
      salt.fill(0)
      key?.fill(0)
    }
  })()
}
