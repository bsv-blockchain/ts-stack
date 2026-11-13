import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { CompletedProtoWallet, PrivateKey, canonicalOutputJSON } from '@bsv/sdk'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IDBFactory } from 'fake-indexeddb'
import { SQLiteOperationStateStore } from '../src/operations/SQLiteOperationStateStore.js'
import { IndexedDBOperationStateStore } from '../src/operations/IndexedDBOperationStateStore.js'
import { MemoryOperationStateStore } from '../src/operations/MemoryOperationStateStore.js'
import type { OperationStateStore } from '../src/operations/OperationStateStore.js'
import { WalletProtectedOperationPayload } from '../src/operations/WalletProtectedOperationPayload.js'
import {
  ProtectedOperationStateStore,
  protectedOperationBinding,
  PROTECTED_OPERATION_INITIAL
} from '../src/operations/ProtectedOperationStateStore.js'
const directories: string[] = [],
  stores: OperationStateStore[] = []
const options = {
  binding: { scope: 'synthetic-private-buyer', generation: '1' },
  maximumValueBytes: 1024
}
const initial = { phase: 'selected', privateRequest: 'example-private-context-never-public' }
afterEach(async () => {
  jest.restoreAllMocks()
  await Promise.all(stores.splice(0).map(store => store.close()))
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function custody() {
  const wallet = new CompletedProtoWallet(new PrivateKey(84))
  return {
    wallet,
    codec: new WalletProtectedOperationPayload(
      wallet,
      new PrivateKey(84).toPublicKey().toString(),
      2048
    )
  }
}
async function fixture(kind: 'sqlite' | 'indexeddb') {
  const { wallet, codec } = custody(),
    binding = protectedOperationBinding(options, codec)
  const directory = mkdtempSync(join(tmpdir(), 'protected-operation-'))
  directories.push(directory)
  const path = join(directory, 'state.sqlite'),
    factory = new IDBFactory()
  async function base(create = false) {
    const store =
      kind === 'sqlite'
        ? create
          ? SQLiteOperationStateStore.create(
              path,
              'buyer-one',
              binding,
              PROTECTED_OPERATION_INITIAL
            )
          : SQLiteOperationStateStore.open(path, 'buyer-one', binding)
        : create
          ? await IndexedDBOperationStateStore.create(
              'protected-operation',
              'buyer-one',
              binding,
              PROTECTED_OPERATION_INITIAL,
              { factory }
            )
          : await IndexedDBOperationStateStore.open('protected-operation', 'buyer-one', binding, {
              factory
            })
    stores.push(store)
    return store
  }
  const first = await base(true),
    owner = await ProtectedOperationStateStore.initialize(first, codec, options, initial)
  return { wallet, codec, binding, path, base, first, owner }
}
describe.each(['sqlite', 'indexeddb'] as const)('%s protected buyer workflow storage', kind => {
  it('stores ciphertext, reopens with original custody and never recreates state implicitly', async () => {
    const f = await fixture(kind),
      encoded = canonicalOutputJSON((await f.first.read()).value)
    expect(encoded).not.toContain(initial.privateRequest)
    expect(encoded).not.toContain('privateRequest')
    expect(await f.owner.read()).toEqual({ revision: '1', value: initial })
    await f.owner.compareAndSwap('1', { phase: 'paid', context: 'received-secret' })
    const reopened = await ProtectedOperationStateStore.open(
      await f.base(),
      custody().codec,
      options
    )
    expect(await reopened.read()).toEqual({
      revision: '2',
      value: { phase: 'paid', context: 'received-secret' }
    })
    if (kind === 'sqlite')
      expect(readFileSync(f.path).includes(Buffer.from(initial.privateRequest))).toBe(false)
  })
  it('recognizes lost acknowledgements by decrypted original revision and never rolls back a later state', async () => {
    const f = await fixture(kind),
      value = { phase: 'paid', bytes: 'original-signed-payment' }
    expect(await f.owner.compareAndSwap('1', value)).toEqual({ status: 'updated', revision: '2' })
    expect(await f.owner.compareAndSwap('1', value)).toEqual({ status: 'replayed', revision: '2' })
    expect(await f.owner.compareAndSwap('1', { phase: 'other' })).toEqual({
      status: 'conflict',
      revision: '2'
    })
    await f.owner.compareAndSwap('2', { phase: 'received' })
    expect(await f.owner.compareAndSwap('1', value)).toEqual({ status: 'conflict', revision: '3' })
    expect((await f.owner.read()).value).toEqual({ phase: 'received' })
  })
  it('preserves competing writers and exact initialization even though encryption is randomized', async () => {
    const f = await fixture(kind),
      second = await ProtectedOperationStateStore.open(await f.base(), custody().codec, options)
    const results = await Promise.all([
      f.owner.compareAndSwap('1', { winner: 'left' }),
      second.compareAndSwap('1', { winner: 'right' })
    ])
    expect(results.map(result => result.status).sort()).toEqual(['conflict', 'updated'])
    const saved = await second.read()
    expect(saved.revision).toBe('2')
    expect(saved.value.winner).toBe(results[0].status === 'updated' ? 'left' : 'right')
    const retry = await ProtectedOperationStateStore.initialize(
      await f.base(true),
      custody().codec,
      options,
      initial
    )
    expect(await retry.read()).toEqual(saved)
    await expect(
      ProtectedOperationStateStore.initialize(await f.base(true), custody().codec, options, {
        replacement: true
      })
    ).rejects.toMatchObject({ code: 'conflict' })
  })
  it('owns private values before awaiting storage and checks whole UTF-8 value limits', async () => {
    const f = await fixture(kind),
      input = { context: 'original' }
    const saving = f.owner.compareAndSwap('1', input)
    input.context = 'caller-changed'
    await saving
    expect((await f.owner.read()).value.context).toBe('original')
    const config = f.owner.configuration
    config.binding.scope = 'changed'
    config.limits.stateBytes = 1
    expect(f.owner.configuration).toEqual({
      binding: options.binding,
      limits: { configurationBytes: 32768, stateBytes: 1024 }
    })
    await expect(f.owner.compareAndSwap('2', { x: 'é'.repeat(509) })).rejects.toMatchObject({
      code: 'limited'
    })
    expect((await f.owner.read()).revision).toBe('2')
    expect(await f.owner.compareAndSwap('2', { x: 'é'.repeat(508) })).toEqual({
      status: 'updated',
      revision: '3'
    })
  })
  it('authenticates ciphertext to its actual store revision and refuses altered bytes', async () => {
    const f = await fixture(kind),
      original = await f.first.read()
    await f.first.compareAndSwap(original.revision, original.value)
    await expect(f.owner.read()).rejects.toMatchObject({ code: 'context-changed' })
  })
  it('refuses another wallet identity rather than synthesizing fresh custody', async () => {
    const f = await fixture(kind),
      wallet = new CompletedProtoWallet(new PrivateKey(85))
    const wrong = new WalletProtectedOperationPayload(
      wallet,
      new PrivateKey(85).toPublicKey().toString(),
      2048
    )
    await expect(
      ProtectedOperationStateStore.open(await f.base(), wrong, options)
    ).rejects.toMatchObject({ code: 'context-changed' })
    expect((await f.owner.read()).value).toEqual(initial)
  })
})
it('rejects a volatile port and insufficient ciphertext reservation before private wallet work', async () => {
  const { codec, wallet } = custody(),
    encrypt = jest.spyOn(wallet, 'encrypt'),
    binding = protectedOperationBinding(options, codec)
  const memory = new MemoryOperationStateStore('private', binding, PROTECTED_OPERATION_INITIAL)
  await expect(
    ProtectedOperationStateStore.initialize(memory, codec, options, initial)
  ).rejects.toThrow('durable store')
  expect(encrypt).not.toHaveBeenCalled()
  const directory = mkdtempSync(join(tmpdir(), 'protected-operation-'))
  directories.push(directory)
  const base = SQLiteOperationStateStore.create(
    join(directory, 'small.sqlite'),
    'private',
    binding,
    PROTECTED_OPERATION_INITIAL,
    { stateBytes: codec.maximumSealedBytes }
  )
  stores.push(base)
  await expect(
    ProtectedOperationStateStore.initialize(base, codec, options, initial)
  ).rejects.toThrow('storage reservation')
})
it('does not initialize an opened empty installation and rejects oversized values before encryption', async () => {
  const { codec, wallet } = custody(),
    binding = protectedOperationBinding(options, codec)
  const directory = mkdtempSync(join(tmpdir(), 'protected-operation-'))
  directories.push(directory)
  const base = SQLiteOperationStateStore.create(
    join(directory, 'empty.sqlite'),
    'private',
    binding,
    PROTECTED_OPERATION_INITIAL
  )
  stores.push(base)
  await expect(ProtectedOperationStateStore.open(base, codec, options)).rejects.toThrow()
  const encrypt = jest.spyOn(wallet, 'encrypt')
  await expect(
    ProtectedOperationStateStore.initialize(base, codec, options, { value: 'x'.repeat(1024) })
  ).rejects.toMatchObject({ code: 'limited' })
  expect(encrypt).not.toHaveBeenCalled()
  expect(await base.read()).toEqual({ revision: '0', value: PROTECTED_OPERATION_INITIAL })
})
it('uses real wallet encryption with fresh salts and binds every ciphertext to its context', async () => {
  const { codec } = custody(),
    bytes = new TextEncoder().encode('recipient-only context'),
    binding = { revision: '1' }
  const first = await codec.seal(binding, bytes),
    second = await codec.seal(binding, bytes)
  expect(first).not.toEqual(second)
  expect(await codec.open(binding, first)).toEqual(bytes)
  expect(await codec.open(binding, second)).toEqual(bytes)
  await expect(codec.open({ revision: '2' }, first)).rejects.toMatchObject({
    code: 'context-changed'
  })
  const corrupted = { ...first, ciphertext: 'AA==' }
  await expect(codec.open(binding, corrupted)).rejects.toMatchObject({ code: 'unavailable' })
})
it('recovers a native committed write whose acknowledgement was lost without exposing plaintext', async () => {
  const { codec } = custody(),
    binding = protectedOperationBinding(options, codec)
  const directory = mkdtempSync(join(tmpdir(), 'protected-operation-'))
  directories.push(directory)
  const path = join(directory, 'lost.sqlite'),
    base = SQLiteOperationStateStore.create(path, 'buyer', binding, PROTECTED_OPERATION_INITIAL)
  stores.push(base)
  let lose = false
  const original = base.compareAndSwap.bind(base)
  base.compareAndSwap = async (...args) => {
    const result = await original(...args)
    if (lose) {
      lose = false
      throw new Error('Synthetic lost acknowledgement')
    }
    return result
  }
  const owner = await ProtectedOperationStateStore.initialize(base, codec, options, initial)
  lose = true
  await expect(
    owner.compareAndSwap('1', { phase: 'signed', payment: 'exact-original-bytes' })
  ).rejects.toThrow('lost acknowledgement')
  const reopenedBase = SQLiteOperationStateStore.open(path, 'buyer', binding)
  stores.push(reopenedBase)
  const reopened = await ProtectedOperationStateStore.open(reopenedBase, custody().codec, options)
  expect(await reopened.read()).toEqual({
    revision: '2',
    value: { phase: 'signed', payment: 'exact-original-bytes' }
  })
  expect(
    await reopened.compareAndSwap('1', { phase: 'signed', payment: 'exact-original-bytes' })
  ).toEqual({ status: 'replayed', revision: '2' })
  expect(canonicalOutputJSON((await reopenedBase.read()).value)).not.toContain(
    'exact-original-bytes'
  )
})
it('rejects changed storage and wallet capabilities across asynchronous custody work', async () => {
  const f = await fixture('sqlite')
  const original = f.wallet.getPublicKey.bind(f.wallet)
  f.wallet.getPublicKey = async (...args) => await original(...args)
  await expect(f.owner.read()).rejects.toMatchObject({ code: 'context-changed' })
  const other = await fixture('sqlite'),
    originalRead = other.first.read.bind(other.first)
  other.first.read = async () => await originalRead()
  await expect(other.owner.read()).rejects.toMatchObject({ code: 'context-changed' })
})
it('rejects changed ciphertext authentication and missing wallet custody without deleting the record', async () => {
  const wallet = new CompletedProtoWallet(new PrivateKey(84)),
    decrypt = wallet.decrypt.bind(wallet)
  let unavailable = false
  wallet.decrypt = async (...args) => {
    if (unavailable) throw new Error('Synthetic unavailable key')
    return await decrypt(...args)
  }
  const codec = new WalletProtectedOperationPayload(
    wallet,
    new PrivateKey(84).toPublicKey().toString(),
    2048
  )
  const directory = mkdtempSync(join(tmpdir(), 'protected-operation-'))
  directories.push(directory)
  const base = SQLiteOperationStateStore.create(
    join(directory, 'custody.sqlite'),
    'buyer',
    protectedOperationBinding(options, codec),
    PROTECTED_OPERATION_INITIAL
  )
  stores.push(base)
  const owner = await ProtectedOperationStateStore.initialize(base, codec, options, initial),
    before = await base.read()
  unavailable = true
  await expect(owner.read()).rejects.toMatchObject({ code: 'unavailable' })
  expect(await base.read()).toEqual(before)
  unavailable = false
  expect((await owner.read()).value).toEqual(initial)
})
it('preserves explicit close semantics without affecting the original underlying store defaults', async () => {
  const f = await fixture('sqlite')
  await f.owner.close()
  await f.owner.close()
  await expect(f.owner.read()).rejects.toThrow('closed')
  const native = await f.base(),
    restored = await ProtectedOperationStateStore.open(native, custody().codec, options)
  expect((await restored.read()).value).toEqual(initial)
})
it.each(['before-encryption', 'after-encryption', 'before-commit', 'after-commit'])(
  'recovers actual native process loss at %s without recreating the workflow',
  async stage => {
    const { spawn } = await import('node:child_process')
    const f = await fixture('sqlite')
    const worker = new URL('./fixtures/protected-operation-worker.mjs', import.meta.url)
    const child = spawn(process.execPath, [worker.pathname, f.path, stage], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    let stderr = ''
    child.stderr?.on('data', chunk => {
      stderr = (stderr + String(chunk)).slice(-4096)
    })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (code, signal) => resolve({ code, signal }))
      }
    )
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Protected worker boundary deadline: ' + stderr)),
          10000
        )
        child.once('message', value => {
          clearTimeout(timer)
          if (
            typeof value === 'object' &&
            value !== null &&
            'phase' in value &&
            value.phase === stage
          )
            resolve()
          else reject(new Error('Unexpected protected worker phase'))
        })
        void exited.then(() => {
          clearTimeout(timer)
          reject(new Error('Protected worker ended before boundary: ' + stderr))
        }, reject)
      })
      child.kill('SIGKILL')
      expect((await exited).signal).toBe('SIGKILL')
      const reopened = await ProtectedOperationStateStore.open(
        await f.base(),
        custody().codec,
        options
      )
      expect(await reopened.read()).toEqual(
        stage === 'after-commit'
          ? { revision: '2', value: { phase: 'signed', payment: 'original-retained-payment' } }
          : { revision: '1', value: initial }
      )
    } finally {
      child.kill('SIGKILL')
      await exited
    }
  },
  15000
)
