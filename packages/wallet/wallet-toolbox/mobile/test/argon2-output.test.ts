import { afterEach, expect, it, vi } from 'vitest'
import { argon2id } from '../../src/utility/hashWasm'

const javaScriptArgon2id = vi.hoisted(() => vi.fn())
vi.mock('hash-wasm/dist/argon2.umd.min.js', () => ({
  default: {
    argon2id: vi.fn(async () => {
      throw new Error('WebAssembly is unavailable')
    })
  }
}))
vi.mock('@noble/hashes/argon2.js', () => ({ argon2idAsync: javaScriptArgon2id }))

afterEach(() => javaScriptArgon2id.mockReset())

it.each([
  { result: Uint8Array.of(1, 2, 3), message: 'returned 3 bytes; expected 32' },
  { result: [1, 2, 3], message: 'returned a non-byte result' }
])('rejects malformed JavaScript fallback output: $message', async ({ result, message }) => {
  javaScriptArgon2id.mockResolvedValue(result)
  await expect(
    argon2id({
      password: new Uint8Array(16),
      salt: new Uint8Array(16),
      iterations: 2,
      memorySize: 1024,
      parallelism: 1,
      hashLength: 32,
      outputType: 'binary'
    })
  ).rejects.toThrow(message)
  expect(javaScriptArgon2id).toHaveBeenCalledOnce()
})
