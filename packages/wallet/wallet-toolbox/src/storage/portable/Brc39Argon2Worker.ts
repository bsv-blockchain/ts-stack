import { parentPort } from 'node:worker_threads'
import { argon2id } from '../../utility/hashWasm'

/** Private one-shot package worker. Password/key buffers are transferred, never
 * serialized as text. Closing the port follows erasure of worker-owned input;
 * the parent requires the actual worker exit before accepting the key. */
const port = parentPort
if (port === null) throw new Error('BRC-39 KDF requires its owned worker port')
port.once('message', (input: unknown) => {
  void derive(input).catch(() => {
    process.exitCode = 1
    port.close()
  })
})
async function derive(input: unknown): Promise<void> {
  let password: Uint8Array | undefined, salt: Uint8Array | undefined, key: Uint8Array | undefined
  try {
    if (typeof input !== 'object' || input === null) throw new TypeError('Invalid BRC-39 worker request')
    const request = input as Record<string, unknown>
    if (!(request.password instanceof ArrayBuffer) || !(request.salt instanceof ArrayBuffer))
      throw new TypeError('Invalid BRC-39 worker input buffers')
    password = new Uint8Array(request.password)
    salt = new Uint8Array(request.salt)
    if (password.length > 65536 || salt.length < 1 || salt.length > 255)
      throw new RangeError('Invalid BRC-39 worker input length')
    const integer = (value: unknown, maximum: number): number => {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum)
        throw new RangeError('Invalid BRC-39 worker parameter')
      return value
    }
    const result = await argon2id({
      password,
      salt,
      iterations: integer(request.iterations, 0xffffffff),
      memorySize: integer(request.memoryKiB, 0xffffffff),
      parallelism: integer(request.parallelism, 255),
      hashLength: 32,
      outputType: 'binary'
    })
    if (!(result instanceof Uint8Array)) throw new TypeError('Invalid BRC-39 worker key')
    key = result
    if (
      key.length !== 32 ||
      !(key.buffer instanceof ArrayBuffer) ||
      key.byteOffset !== 0 ||
      key.buffer.byteLength !== 32
    )
      throw new TypeError('BRC-39 worker requires an exclusive key buffer')
    password.fill(0)
    salt.fill(0)
    port!.postMessage(key.buffer, [key.buffer])
    key = undefined
  } finally {
    password?.fill(0)
    salt?.fill(0)
    key?.fill(0)
    port!.close()
  }
}
