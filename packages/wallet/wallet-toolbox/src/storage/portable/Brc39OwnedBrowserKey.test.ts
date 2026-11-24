import { deriveBrc39OwnedBrowserKey } from './Brc39OwnedBrowserKey'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import {
  registerArgon2idBackend,
  unregisterArgon2idBackend,
  type AsyncArgon2idBackend,
  type Argon2idOptions
} from '../../utility/Argon2idBackend'

// Authored UNRUN. Actual promise/owned input erasure; not native/mobile KDF
// memory-pressure, performance or backend constant-time qualification.
let backend: AsyncArgon2idBackend | undefined
afterEach(() => {
  if (backend !== undefined) unregisterArgon2idBackend(backend)
  backend = undefined
})
const header = () => ({
  iterations: 1,
  memoryKiB: 8,
  parallelism: 1,
  salt: new Uint8Array(32).fill(17),
  nonce: new Uint8Array(32).fill(19)
})
const options = () => ({
  policy: {
    maximumFileBytes: 1048576,
    maximumChunkBytes: 4096,
    maximumIterations: 7,
    maximumMemoryKiB: 131072,
    maximumParallelism: 1
  },
  expiresAt: Date.now() + 10000,
  maximumPasswordBytes: 1024,
  maximumOperationMilliseconds: 1000,
  cleanupMilliseconds: 1000
})
function install(deriveKey: AsyncArgon2idBackend['deriveKey']) {
  backend = { preload: async () => {}, isReady: () => true, deriveKey }
  registerArgon2idBackend(backend)
}
test('owned derivation preserves original NFC/parameters and erases inputs after actual settlement', async () => {
  let captured: Readonly<Argon2idOptions> | undefined
  const raw = new Uint8Array(32).fill(23),
    original = header()
  install(async selected => {
    captured = selected
    expect(new TextDecoder().decode(selected.password)).toBe('Caf\u00e9')
    expect(selected.memorySize).toBe(8)
    expect(selected.iterations).toBe(1)
    return raw
  })
  const key = await deriveBrc39OwnedBrowserKey(original, 'Cafe\u0301', options())
  expect(key).toBe(raw)
  expect(captured!.password.every(byte => byte === 0)).toBe(true)
  expect(captured!.salt.every(byte => byte === 0)).toBe(true)
  expect(original.salt.every(byte => byte === 17)).toBe(true)
  key.fill(0)
})
test('timeout retains actual backend and later erases its key with retry before declaring drain', async () => {
  let resolve!: (key: Uint8Array) => void, captured: Readonly<Argon2idOptions> | undefined
  const pending = new Promise<Uint8Array>(yes => {
    resolve = yes
  })
  install(async selected => {
    captured = selected
    return await pending
  })
  let caught: unknown
  try {
    await deriveBrc39OwnedBrowserKey(header(), 'private', {
      ...options(),
      maximumOperationMilliseconds: 10,
      cleanupMilliseconds: 10
    })
  } catch (cause) {
    caught = cause
  }
  expect(caught).toBeInstanceOf(Brc38StagingCleanupError)
  expect(new TextDecoder().decode(captured!.password)).toBe('private')
  const late = new Uint8Array(32).fill(29)
  resolve(late)
  await (caught as Brc38StagingCleanupError).retryCleanup()
  expect(late.every(byte => byte === 0)).toBe(true)
  expect(captured!.password.every(byte => byte === 0)).toBe(true)
  expect(captured!.salt.every(byte => byte === 0)).toBe(true)
})
test('cancellation revokes delivery but waits for actual derivation settlement and erasure', async () => {
  const controller = new AbortController(),
    raw = new Uint8Array(32).fill(31),
    cause = new Error('cancel KDF')
  install(async () => {
    controller.abort(cause)
    return raw
  })
  await expect(
    deriveBrc39OwnedBrowserKey(header(), 'private', { ...options(), signal: controller.signal })
  ).rejects.toBe(cause)
  expect(raw.every(byte => byte === 0)).toBe(true)
})
test('KDF policy refusal precedes backend work', async () => {
  const derive = jest.fn(async () => new Uint8Array(32))
  install(derive)
  await expect(deriveBrc39OwnedBrowserKey({ ...header(), memoryKiB: 131073 }, 'private', options())).rejects.toThrow()
  expect(derive).not.toHaveBeenCalled()
})

test('required async mode refuses missing backend before deriving and captures the ready backend across registry replacement', async () => {
  await expect(
    deriveBrc39OwnedBrowserKey(header(), 'private', { ...options(), requireReadyAsyncBackend: true })
  ).rejects.toThrow('preloaded')
  const key = new Uint8Array(32).fill(41),
    derive = jest.fn(async () => key)
  install(derive)
  const original = backend!
  const pending = deriveBrc39OwnedBrowserKey(header(), 'private', { ...options(), requireReadyAsyncBackend: true })
  unregisterArgon2idBackend(original)
  const replacement = {
    preload: async () => {},
    isReady: () => true,
    deriveKey: jest.fn(async () => new Uint8Array(32).fill(43))
  }
  registerArgon2idBackend(replacement)
  try {
    expect(await pending).toBe(key)
    expect(derive).toHaveBeenCalledTimes(1)
    expect(replacement.deriveKey).not.toHaveBeenCalled()
  } finally {
    key.fill(0)
    unregisterArgon2idBackend(replacement)
  }
})
