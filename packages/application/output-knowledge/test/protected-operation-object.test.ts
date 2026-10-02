import { afterEach, expect, jest, test } from '@jest/globals'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSecretKey } from 'node:crypto'
import { PrivateKey } from '@bsv/sdk'
import { SQLiteProtectedOperationObjectStore } from '../src/operations/SQLiteProtectedOperationObjectStore.js'
import { NodeProtectedPayloadCodec } from '../src/private/NodeProtectedPayloadCodec.js'
import { SQLiteProtectedLedger } from '../src/private/SQLiteProtectedLedger.js'
const directories: string[] = [],
  stores: SQLiteProtectedOperationObjectStore[] = []
const configuration = {
  storeId: '85'.repeat(32),
  recipient: new PrivateKey(85).toPublicKey().toString(),
  binding: { purpose: 'synthetic-recipient-custody' },
  maximumObjects: 1,
  maximumObjectBytes: 4194304
}
const id = '86'.repeat(32),
  binding = { acquisition: 'original', requestDigest: '87'.repeat(32) }
const codec = (byte = 85) =>
  new NodeProtectedPayloadCodec(
    { resolve: () => createSecretKey(Buffer.alloc(32, byte)) },
    'fixture-key'
  )
function fixture(maximumObjectBytes = 4194304) {
  const directory = mkdtempSync(join(tmpdir(), 'result-draft-'))
  directories.push(directory)
  const file = join(directory, 'recipient.sqlite'),
    config = { ...configuration, maximumObjectBytes }
  const store = SQLiteProtectedOperationObjectStore.create(file, config, codec())
  stores.push(store)
  return { store, file, config }
}
afterEach(async () => {
  jest.restoreAllMocks()
  for (const store of stores.splice(0)) await store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test('retains and reopens the complete four-MiB original result outside the small control cell', async () => {
  const { store, file, config } = fixture()
  const secret = new TextEncoder().encode('synthetic protected delivered result'),
    bytes = new Uint8Array(4194304).fill(65)
  bytes.set(secret)
  expect(await store.read(id, binding)).toEqual({ state: 'absent' })
  const reservation = await store.reserve(id, binding, bytes.length)
  expect(await store.read(id, binding)).toEqual({ state: 'reserved', reservation })
  const receipt = await store.put(id, binding, bytes)
  expect(receipt.bytes).toBe(4194304)
  expect(await store.put(id, binding, bytes)).toEqual(receipt)
  await store.close()
  expect(readFileSync(file).includes(secret)).toBe(false)
  const reopened = SQLiteProtectedOperationObjectStore.open(file, config, codec())
  stores.push(reopened)
  const saved = await reopened.read(id, binding)
  expect(saved.state).toBe('stored')
  if (saved.state !== 'stored') throw new Error('Expected retained original bytes')
  const { bytes: retained, ...metadata } = saved
  expect(metadata).toEqual({ state: 'stored', receipt })
  expect(retained.constructor).toBe(Uint8Array)
  expect(Buffer.from(retained).equals(Buffer.from(bytes))).toBe(true)
  bytes[0] ^= 1
  await expect(reopened.put(id, binding, bytes)).rejects.toMatchObject({ code: 'conflict' })
}, 30000)

test('reserves all future slots before payment, even for a smaller chosen response', async () => {
  const { store } = fixture()
  const reservation = await store.reserve(id, binding, 100)
  await expect(store.reserve('88'.repeat(32), binding, 1)).rejects.toMatchObject({
    code: 'limited'
  })
  expect(await store.read('88'.repeat(32), binding)).toEqual({ state: 'absent' })
  await expect(store.reserve(id, binding, 101)).rejects.toMatchObject({ code: 'conflict' })
  await expect(store.put(id, binding, new Uint8Array(101))).rejects.toMatchObject({
    code: 'limited'
  })
  expect(await store.read(id, binding)).toEqual({ state: 'reserved', reservation })
  const receipt = await store.put(id, binding, new Uint8Array())
  expect(receipt.bytes).toBe(0)
  expect(await store.read(id, binding)).toEqual({
    state: 'stored',
    receipt,
    bytes: new Uint8Array()
  })
})

test('does not install or reserve on read, put, missing custody or changed original identity', async () => {
  const { store, file, config } = fixture(100)
  await expect(store.put(id, binding, new Uint8Array())).rejects.toMatchObject({
    code: 'unavailable'
  })
  await store.reserve(id, binding, 100)
  await expect(store.read(id, { ...binding, acquisition: 'changed' })).rejects.toMatchObject({
    code: 'context-changed'
  })
  const receipt = await store.put(id, binding, new Uint8Array([1, 2, 3]))
  await store.close()
  expect(() =>
    SQLiteProtectedOperationObjectStore.open(file + '-missing', config, codec())
  ).toThrow()
  expect(() => SQLiteProtectedOperationObjectStore.open(file, config, codec(86))).toThrow()
  expect(() =>
    SQLiteProtectedOperationObjectStore.open(
      file,
      { ...config, recipient: new PrivateKey(86).toPublicKey().toString() },
      codec()
    )
  ).toThrow()
  const reopened = SQLiteProtectedOperationObjectStore.open(file, config, codec())
  stores.push(reopened)
  expect(await reopened.read(id, binding)).toEqual({
    state: 'stored',
    receipt,
    bytes: new Uint8Array([1, 2, 3])
  })
})

test.each(['reservation', 'delivery'] as const)(
  'reconciles a lost %s commit response without replacement',
  async phase => {
    const { store } = fixture(100)
    if (phase === 'delivery') await store.reserve(id, binding, 100)
    const commit = SQLiteProtectedLedger.prototype.commit
    jest.spyOn(SQLiteProtectedLedger.prototype, 'commit').mockImplementationOnce(function (
      this: SQLiteProtectedLedger,
      ...args
    ) {
      commit.apply(this, args)
      throw new Error('Original committed response lost')
    })
    if (phase === 'reservation') {
      await expect(store.reserve(id, binding, 100)).rejects.toThrow(
        'Original committed response lost'
      )
      const reservation = await store.reserve(id, binding, 100)
      expect(await store.read(id, binding)).toEqual({ state: 'reserved', reservation })
    } else {
      await expect(store.put(id, binding, new Uint8Array([7, 8]))).rejects.toThrow(
        'Original committed response lost'
      )
      const receipt = await store.put(id, binding, new Uint8Array([7, 8]))
      expect(await store.read(id, binding)).toEqual({
        state: 'stored',
        receipt,
        bytes: new Uint8Array([7, 8])
      })
    }
  }
)

test('owns caller bytes and configuration before consulting custody, and returns independent copies', async () => {
  const { store } = fixture(10)
  await store.reserve(id, binding, 10)
  const config = store.configuration
  config.maximumObjectBytes = 100
  config.binding.purpose = 'changed'
  const bytes = new Uint8Array([9, 10]),
    pending = store.put(id, binding, bytes)
  bytes.fill(0)
  const receipt = await pending
  const first = await store.read(id, binding)
  if (first.state !== 'stored') throw new Error('Expected original custody')
  expect(first.bytes).toEqual(new Uint8Array([9, 10]))
  first.bytes.fill(2)
  first.receipt.digest = '00'.repeat(32)
  expect(await store.read(id, binding)).toEqual({
    state: 'stored',
    receipt,
    bytes: new Uint8Array([9, 10])
  })
  expect(store.configuration.maximumObjectBytes).toBe(10)
  expect(store.configuration.binding.purpose).toBe('synthetic-recipient-custody')
})

test.each(['before-reservation', 'after-reservation', 'before-delivery', 'after-delivery'])(
  'original result custody survives process termination at %s',
  async point => {
    const { fork } = await import('node:child_process'),
      { once } = await import('node:events')
    const { store, file, config } = fixture(100)
    await store.close()
    const worker = fork(
      new URL('./fixtures/protected-operation-object-worker.mjs', import.meta.url),
      [file, JSON.stringify(config), point],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
    )
    const exit = once(worker, 'exit')
    let output = ''
    worker.stderr!.on('data', bytes => {
      output += String(bytes)
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        once(worker, 'message').then(([message]) => message as { point: string }),
        exit.then(() => {
          throw new Error('Custody worker exited before boundary: ' + output)
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Custody worker deadline')), 10000)
        })
      ])
      expect(result.point).toBe(point)
      worker.kill('SIGKILL')
      await exit
      const reopened = SQLiteProtectedOperationObjectStore.open(file, config, codec())
      stores.push(reopened)
      const saved = await reopened.read(id, binding)
      expect(saved.state).toBe(
        point === 'before-reservation'
          ? 'absent'
          : point === 'after-delivery'
            ? 'stored'
            : 'reserved'
      )
      if (saved.state === 'stored') {
        expect(saved.bytes).toEqual(new Uint8Array([42, 43]))
        expect(await reopened.put(id, binding, saved.bytes)).toEqual(saved.receipt)
      }
    } finally {
      clearTimeout(timer)
      if (worker.exitCode === null && worker.signalCode === null) {
        worker.kill('SIGKILL')
        await exit
      }
    }
  }
)
