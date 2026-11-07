import { afterEach, expect, jest, test } from '@jest/globals'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  CompletedProtoWallet,
  PrivateKey,
  canonicalOutputJSON,
  type OutputJSONObject
} from '@bsv/sdk'
import { SQLiteOperationStateStore } from '../src/operations/SQLiteOperationStateStore.js'
import type { OperationStateStore } from '../src/operations/OperationStateStore.js'
import type { ProtectedOperationPayload } from '../src/operations/ProtectedOperationPayload.js'
import { WalletProtectedOperationPayload } from '../src/operations/WalletProtectedOperationPayload.js'
import {
  ProtectedOperationStateStore,
  protectedOperationBinding,
  PROTECTED_OPERATION_INITIAL
} from '../src/operations/ProtectedOperationStateStore.js'
const directories: string[] = [],
  stores: OperationStateStore[] = []
const options = { binding: { installation: 'boundary-custody' }, maximumValueBytes: 1024 },
  initial = { phase: 'selected' }
function codec() {
  const key = new PrivateKey(84),
    wallet = new WalletProtectedOperationPayload(
      new CompletedProtoWallet(key),
      key.toPublicKey().toString(),
      2048
    )
  return {
    id: wallet.id,
    maximumPlaintextBytes: wallet.maximumPlaintextBytes,
    maximumSealedBytes: wallet.maximumSealedBytes,
    seal: jest.fn<ProtectedOperationPayload['seal']>().mockImplementation(wallet.seal.bind(wallet)),
    open: jest.fn<ProtectedOperationPayload['open']>().mockImplementation(wallet.open.bind(wallet))
  }
}
function base(
  payload = codec(),
  binding = protectedOperationBinding(options, payload),
  state = PROTECTED_OPERATION_INITIAL
) {
  const directory = mkdtempSync(join(tmpdir(), 'protected-state-boundary-'))
  directories.push(directory)
  const native = SQLiteOperationStateStore.create(
    join(directory, 'state.sqlite'),
    'boundary',
    binding,
    state
  )
  stores.push(native)
  return { payload, native }
}
async function fixture() {
  const f = base(),
    owner = await ProtectedOperationStateStore.initialize(f.native, f.payload, options, initial)
  return { ...f, owner }
}
afterEach(async () => {
  jest.restoreAllMocks()
  await Promise.all(stores.splice(0).map(store => store.close()))
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true })
})

test.each([
  { id: '' },
  { id: 'a'.repeat(129) },
  { id: 7 },
  { maximumPlaintextBytes: 255 },
  { maximumPlaintextBytes: 2048.5 },
  { maximumPlaintextBytes: 2097153 },
  { maximumSealedBytes: 0 },
  { maximumSealedBytes: 1.5 },
  { maximumSealedBytes: 4194049 }
])('rejects invalid installed protection capacities before state initialization: %j', change => {
  expect(() =>
    protectedOperationBinding(options, { ...codec(), ...change } as ProtectedOperationPayload)
  ).toThrow('Invalid protected operation codec capacity')
})
test('preserves exact accepted configuration bounds and authenticates the complete public binding', () => {
  const original = {
    ...codec(),
    id: 'a'.repeat(128),
    maximumPlaintextBytes: 2097152,
    maximumSealedBytes: 4194048
  }
  const result = protectedOperationBinding(
    { binding: { public: 'original' }, maximumValueBytes: 2096896 },
    original
  )
  expect(result).toEqual({
    format: 'output-protected-operation/1',
    binding: { public: 'original' },
    codec: 'a'.repeat(128),
    maximumValueBytes: 2096896,
    maximumPlaintextBytes: 2097152,
    maximumSealedBytes: 4194048
  })
  expect(() =>
    protectedOperationBinding(
      { binding: {}, maximumValueBytes: 0 },
      { ...codec(), maximumPlaintextBytes: 256 }
    )
  ).toThrow('Protected operation value exceeds plaintext reservation')
  expect(
    protectedOperationBinding(
      { binding: {}, maximumValueBytes: 1 },
      { ...codec(), maximumPlaintextBytes: 257 }
    ).maximumValueBytes
  ).toBe(1)
})
test.each([0, -1, 1.5, 1793, Number.NaN])(
  'reserves complete private framing before accepting value limit %s',
  maximumValueBytes => {
    expect(() => protectedOperationBinding({ ...options, maximumValueBytes }, codec())).toThrow(
      'Protected operation value exceeds plaintext reservation'
    )
  }
)
test.each([null, [], 1, 'binding'])('rejects non-object public bindings %j', binding => {
  expect(() =>
    protectedOperationBinding(
      { ...options, binding: binding as unknown as OutputJSONObject },
      codec()
    )
  ).toThrow('Expected protected operation object')
})
test('refuses changed original storage binding before consulting custody', async () => {
  const f = base(codec(), { original: 'different' })
  await expect(
    ProtectedOperationStateStore.initialize(f.native, f.payload, options, initial)
  ).rejects.toMatchObject({
    code: 'context-changed',
    message: 'Protected operation requires its original durable store binding'
  })
  expect(f.payload.seal).not.toHaveBeenCalled()
})
test.each(['read', 'compareAndSwap', 'close'] as const)(
  'requires a callable installed %s capability',
  async method => {
    const f = base(),
      original = f.native[method]
    Object.defineProperty(f.native, method, { configurable: true, value: 0 })
    try {
      await expect(ProtectedOperationStateStore.open(f.native, f.payload, options)).rejects.toThrow(
        'Protected operation capability must be callable'
      )
    } finally {
      Object.defineProperty(f.native, method, { configurable: true, value: original })
    }
  }
)
test.each(['seal', 'open'] as const)(
  'requires a callable installed protection %s capability',
  async method => {
    const f = base()
    Object.defineProperty(f.payload, method, { value: 0 })
    await expect(ProtectedOperationStateStore.open(f.native, f.payload, options)).rejects.toThrow(
      'Protected operation capability must be callable'
    )
  }
)
test.each(['namespace', 'durability', 'configuration'] as const)(
  'refuses changed storage %s before exposing protected state',
  async field => {
    const f = await fixture(),
      original = Object.getOwnPropertyDescriptor(f.native, field)
    Object.defineProperty(f.native, field, {
      configurable: true,
      value: field === 'configuration' ? { binding: {}, limits: {} } : 'changed'
    })
    try {
      await expect(f.owner.read()).rejects.toMatchObject({
        code: 'context-changed',
        message: 'Protected operation installed capabilities changed'
      })
    } finally {
      if (original) Object.defineProperty(f.native, field, original)
      else Reflect.deleteProperty(f.native, field)
    }
  }
)
test.each(['id', 'maximumPlaintextBytes', 'maximumSealedBytes', 'seal', 'open'] as const)(
  'refuses changed custody %s after installation',
  async field => {
    const f = await fixture()
    Object.defineProperty(f.payload, field, {
      value: typeof f.payload[field] === 'number' ? 1 : 'changed'
    })
    await expect(f.owner.read()).rejects.toMatchObject({
      code: 'context-changed',
      message: 'Protected operation installed capabilities changed'
    })
  }
)
test('does not treat a later empty sentinel as a new installation', async () => {
  const f = base()
  await f.native.compareAndSwap('0', PROTECTED_OPERATION_INITIAL)
  await expect(
    ProtectedOperationStateStore.initialize(f.native, f.payload, options, initial)
  ).rejects.toMatchObject({
    code: 'unavailable',
    message: 'Protected operation empty state has another revision'
  })
  expect(f.payload.seal).not.toHaveBeenCalled()
})
test('refuses a well-formed but uninitialized protection envelope without repairing it', async () => {
  const f = base(codec(), undefined, { format: 'uninitialized', payload: {} })
  await expect(
    ProtectedOperationStateStore.open(f.native, f.payload, options)
  ).rejects.toMatchObject({
    code: 'unavailable',
    message: 'Protected operation has not been initialized'
  })
  expect(f.payload.open).not.toHaveBeenCalled()
})
test.each([null, [], 1, 'private-value'])(
  'accepts only complete object values before consulting storage: %j',
  value => {
    const f = base()
    return expect(
      ProtectedOperationStateStore.initialize(
        f.native,
        f.payload,
        options,
        value as unknown as OutputJSONObject
      )
    ).rejects.toThrow('Expected protected operation object')
  }
)
test('does not expose malformed or oversized plaintext returned by an installed custody port', async () => {
  const f = await fixture()
  for (const bytes of [[], new Uint8Array(2049)]) {
    f.payload.open.mockResolvedValueOnce(bytes as Uint8Array)
    await expect(f.owner.read()).rejects.toMatchObject({
      code: 'limited',
      message: 'Protected operation plaintext capacity exceeded'
    })
  }
  const bytes = new TextEncoder().encode(
    canonicalOutputJSON({ format: 'wrong-format', initialDigest: '00'.repeat(32), value: initial })
  )
  f.payload.open.mockResolvedValueOnce(bytes)
  await expect(f.owner.read()).rejects.toMatchObject({
    code: 'unavailable',
    message: 'Protected operation value format changed'
  })
  expect(bytes.every(byte => byte === 0)).toBe(true)
  expect(await f.owner.read()).toEqual({ revision: '1', value: initial })
})
test('validates the complete custody response envelope before committing a new revision', async () => {
  const f = base()
  f.payload.seal.mockResolvedValueOnce({ overflow: 'a'.repeat(f.payload.maximumSealedBytes) })
  await expect(
    ProtectedOperationStateStore.initialize(f.native, f.payload, options, initial)
  ).rejects.toMatchObject({ code: 'limited' })
  expect(await f.native.read()).toEqual({ revision: '0', value: PROTECTED_OPERATION_INITIAL })
  expect(f.payload.seal.mock.calls[0][1].every(byte => byte === 0)).toBe(true)
})
test('refuses a changed CAS receipt and never fabricates a successful revision', async () => {
  const f = base(),
    original = f.native.compareAndSwap.bind(f.native)
  let altered = false
  f.native.compareAndSwap = async (...args) => {
    const result = await original(...args)
    return altered ? { ...result, revision: '99' } : result
  }
  const owner = await ProtectedOperationStateStore.initialize(f.native, f.payload, options, initial)
  altered = true
  await expect(owner.compareAndSwap('1', { phase: 'paid' })).rejects.toMatchObject({
    code: 'unavailable',
    message: 'Protected operation CAS returned another revision'
  })
  expect(await owner.read()).toEqual({ revision: '2', value: { phase: 'paid' } })
})
test('checks installed identity again after asynchronous sealing before requesting a durable commit', async () => {
  const f = await fixture(),
    nativeCAS = jest.spyOn(f.native, 'compareAndSwap')
  // Install the spy before reopening so the new owner pins this exact method.
  const owner = await ProtectedOperationStateStore.open(f.native, f.payload, options)
  const original = f.payload.seal.getMockImplementation()!
  f.payload.seal.mockImplementationOnce(async (...args) => {
    const result = await original(...args)
    f.payload.id = 'changed'
    return result
  })
  await expect(owner.compareAndSwap('1', { phase: 'paid' })).rejects.toMatchObject({
    code: 'context-changed'
  })
  expect(nativeCAS).not.toHaveBeenCalled()
  expect((await f.native.read()).revision).toBe('1')
})

test('preserves the exact empty, sealed and plaintext format identities and independent binding digests', async () => {
  const f = base(),
    original = f.payload.seal.getMockImplementation()!,
    frames: { binding: OutputJSONObject; text: string }[] = []
  f.payload.seal.mockImplementation(async (binding, bytes) => {
    frames.push({ binding, text: new TextDecoder().decode(bytes) })
    return await original(binding, bytes)
  })
  const owner = await ProtectedOperationStateStore.initialize(f.native, f.payload, options, initial)
  const digest = (text: string) =>
    createHash('sha256')
      .update('output-protected-operation/1' + String.fromCharCode(0) + text)
      .digest('hex')
  expect(PROTECTED_OPERATION_INITIAL).toEqual({ format: 'output-protected-operation-empty/1' })
  expect((await f.native.read()).value.format).toBe('output-protected-operation-sealed/1')
  expect(frames).toEqual([
    {
      binding: {
        format: 'output-protected-operation/1',
        namespace: 'boundary',
        configuration: digest(canonicalOutputJSON(f.native.configuration)),
        revision: '1'
      },
      text: canonicalOutputJSON({
        format: 'output-protected-operation-value/1',
        initialDigest: digest(canonicalOutputJSON(initial)),
        value: initial
      })
    }
  ])
  expect(await owner.read()).toEqual({ revision: '1', value: initial })
})

test('accepts exactly reserved ciphertext framing without demanding an extra byte', async () => {
  const payload = codec(),
    directory = mkdtempSync(join(tmpdir(), 'protected-exact-capacity-'))
  directories.push(directory)
  const native = SQLiteOperationStateStore.create(
    join(directory, 'state.sqlite'),
    'boundary',
    protectedOperationBinding(options, payload),
    PROTECTED_OPERATION_INITIAL,
    { stateBytes: payload.maximumSealedBytes + 128 }
  )
  stores.push(native)
  const owner = await ProtectedOperationStateStore.initialize(native, payload, options, initial)
  expect(await owner.read()).toEqual({ revision: '1', value: initial })
})

test('replayed and conflicting CAS requests do not ask the wallet to encrypt another candidate', async () => {
  const f = await fixture()
  await f.owner.compareAndSwap('1', { phase: 'signed' })
  f.payload.seal.mockClear()
  expect(await f.owner.compareAndSwap('1', { phase: 'signed' })).toEqual({
    status: 'replayed',
    revision: '2'
  })
  expect(await f.owner.compareAndSwap('0', initial)).toEqual({ status: 'conflict', revision: '2' })
  expect(f.payload.seal).not.toHaveBeenCalled()
})

test('clears returned private buffers at the exact plaintext boundary and on failed capacity checks', async () => {
  const f = await fixture(),
    digest = createHash('sha256')
      .update(
        'output-protected-operation/1' + String.fromCharCode(0) + canonicalOutputJSON(initial)
      )
      .digest('hex')
  const bytes = new TextEncoder().encode(
    canonicalOutputJSON({
      format: 'output-protected-operation-value/1',
      initialDigest: digest,
      value: initial
    }).padEnd(2048, ' ')
  )
  f.payload.open.mockResolvedValueOnce(bytes)
  expect(await f.owner.read()).toEqual({ revision: '1', value: initial })
  expect(bytes.every(byte => byte === 0)).toBe(true)
  const invalid = new Uint8Array(2049).fill(7)
  f.payload.open.mockResolvedValueOnce(invalid)
  await expect(f.owner.read()).rejects.toMatchObject({ code: 'limited' })
  expect(invalid.every(byte => byte === 0)).toBe(true)
})

test('clears returned plaintext when installed custody changes during the awaited read', async () => {
  const f = await fixture(),
    original = f.payload.open.getMockImplementation()!
  let returned: Uint8Array | undefined
  f.payload.open.mockImplementationOnce(async (...args) => {
    returned = await original(...args)
    f.payload.id = 'changed'
    return returned
  })
  await expect(f.owner.read()).rejects.toMatchObject({ code: 'context-changed' })
  expect(returned).toBeDefined()
  expect(returned!.every(byte => byte === 0)).toBe(true)
})

test('closes backing custody once and refuses further reads before consulting the closed port', async () => {
  const f = base(),
    close = jest.spyOn(f.native, 'close'),
    read = jest.spyOn(f.native, 'read')
  const owner = await ProtectedOperationStateStore.initialize(f.native, f.payload, options, initial)
  read.mockClear()
  await owner.close()
  await owner.close()
  expect(close).toHaveBeenCalledTimes(1)
  await expect(owner.read()).rejects.toMatchObject({
    code: 'unavailable',
    message: 'Protected operation store is closed'
  })
  expect(read).not.toHaveBeenCalled()
})
