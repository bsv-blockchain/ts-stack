import { afterEach, expect, jest, test } from '@jest/globals'
import { runInNewContext } from 'node:vm'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { PrivateKey, type OutputJSONObject } from '@bsv/sdk'
import { IndexedDBProtectedOperationObjectStore } from '../src/operations/IndexedDBProtectedOperationObjectStore.js'
import { custody } from './protected-operation-object.fixture.js'
const stores: IndexedDBProtectedOperationObjectStore[] = []
const configuration = {
  storeId: '95'.repeat(32),
  recipient: new PrivateKey(85).toPublicKey().toString(),
  binding: { purpose: 'synthetic-browser-custody' },
  maximumObjects: 2,
  maximumObjectBytes: 4194304
}
const id = '96'.repeat(32),
  binding = { acquisition: 'original', role: 'private-delivery' },
  tableName = 'protected-operation-objects'

async function fixture(maximumObjectBytes = 100, maximumObjects = 2) {
  const factory = new IDBFactory(),
    codec = custody(),
    config = { ...configuration, maximumObjectBytes, maximumObjects }
  const name = 'protected-browser-test'
  const store = await IndexedDBProtectedOperationObjectStore.create(name, config, codec, {
    factory
  })
  stores.push(store)
  async function open(next = config, nextCodec = custody()) {
    const result = await IndexedDBProtectedOperationObjectStore.open(name, next, nextCodec, {
      factory
    })
    stores.push(result)
    return result
  }
  return { store, factory, config, name, codec, open }
}
afterEach(async () => {
  jest.restoreAllMocks()
  await Promise.all(stores.splice(0).map(store => store.close()))
})
async function edit(
  factory: IDBFactory,
  name: string,
  change?: (table: IDBObjectStore, rows: Record<string, unknown>[]) => void
): Promise<Record<string, unknown>[]> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(
          tableName,
          change === undefined ? 'readonly' : 'readwrite'
        ),
        table = transaction.objectStore(tableName)
      const request: IDBRequest<Record<string, unknown>[]> = table.getAll()
      transaction.onabort = () => reject(transaction.error)
      transaction.oncomplete = () => resolve(request.result)
      request.onsuccess = () => change?.(table, request.result)
    })
  } finally {
    database.close()
  }
}
test.each([0, 1, 786432, 786433, 4194304])(
  'retains exactly %i bytes through encrypted browser chunks and reopen',
  async length => {
    const f = await fixture(4194304),
      bytes = new Uint8Array(length).fill(65)
    await f.store.reserve(id, binding, 4194304)
    const receipt = await f.store.put(id, binding, bytes)
    await f.store.close()
    const reopened = await f.open()
    const saved = await reopened.read(id, binding)
    expect(saved.state).toBe('stored')
    if (saved.state !== 'stored') throw new Error('Expected retained original bytes')
    const { bytes: retained, ...metadata } = saved
    expect(metadata).toEqual({ state: 'stored', receipt })
    expect(retained.constructor).toBe(Uint8Array)
    expect(Buffer.from(retained).equals(Buffer.from(bytes))).toBe(true)
    expect(await reopened.put(id, binding, bytes)).toEqual(receipt)
    const rows = await edit(f.factory, f.name)
    expect(JSON.stringify(rows)).not.toContain('private-delivery')
    expect(JSON.stringify(rows)).not.toContain('acquisition')
    expect(receipt.bytes).toBe(length)
  },
  30000
)
test('keeps original requests, contracts and deliveries distinct and never reassigns first retained bytes', async () => {
  const f = await fixture(),
    bytes = new Uint8Array([1, 2, 3])
  expect(await f.store.read(id, binding)).toEqual({ state: 'absent' })
  await expect(f.store.put(id, binding, bytes)).rejects.toMatchObject({ code: 'unavailable' })
  const reservation = await f.store.reserve(id, binding, 10)
  expect(await f.store.read(id, binding)).toEqual({ state: 'reserved', reservation })
  await expect(f.store.reserve(id, binding, 11)).rejects.toMatchObject({ code: 'conflict' })
  await expect(f.store.read(id, { ...binding, role: 'original-request' })).rejects.toMatchObject({
    code: 'context-changed'
  })
  const receipt = await f.store.put(id, binding, bytes)
  await expect(f.store.put(id, binding, new Uint8Array([4]))).rejects.toMatchObject({
    code: 'conflict'
  })
  expect(await f.store.read(id, binding)).toEqual({ state: 'stored', receipt, bytes })
  expect(await f.store.reserve(id, binding, 10)).toEqual(reservation)
})
test('reserves complete installed capacity even for smaller selections and never consumes capacity on absent reads', async () => {
  const f = await fixture(100, 1)
  for (let n = 0; n < 3; n++) expect(await f.store.read(id, binding)).toEqual({ state: 'absent' })
  await f.store.reserve(id, binding, 1)
  await expect(f.store.reserve('97'.repeat(32), binding, 1)).rejects.toMatchObject({
    code: 'limited'
  })
  await expect(f.store.put(id, binding, new Uint8Array(2))).rejects.toMatchObject({
    code: 'limited'
  })
  const receipt = await f.store.put(id, binding, new Uint8Array([7]))
  expect(receipt.bytes).toBe(1)
})
test('atomically arbitrates two connections and recovers only the original winning reservation and bytes', async () => {
  const f = await fixture(),
    second = await f.open()
  const reserved = await Promise.allSettled([
    f.store.reserve(id, binding, 100),
    second.reserve(id, binding, 100)
  ])
  expect(reserved.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(reserved.filter(result => result.status === 'rejected')).toEqual([
    expect.objectContaining({ reason: expect.objectContaining({ code: 'conflict' }) })
  ])
  expect(await second.reserve(id, binding, 100)).toMatchObject({ id, maximumBytes: 100 })
  const values = [new Uint8Array([1]), new Uint8Array([2])]
  const written = await Promise.allSettled([
    f.store.put(id, binding, values[0]),
    second.put(id, binding, values[1])
  ])
  expect(written.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  const winner = written.findIndex(result => result.status === 'fulfilled'),
    saved = await second.read(id, binding)
  expect(saved).toMatchObject({ state: 'stored', bytes: values[winner] })
  await expect(second.put(id, binding, values[1 - winner])).rejects.toMatchObject({
    code: 'conflict'
  })
  expect(await second.put(id, binding, values[winner])).toMatchObject({ bytes: 1 })
})
test('owns mutable callers before asynchronous custody and returns independent results and configuration', async () => {
  const f = await fixture(),
    bytes = new Uint8Array([7, 8]),
    original: OutputJSONObject = { role: 'owned-input' }
  await f.store.reserve(id, original, 100)
  const pending = f.store.put(id, original, bytes)
  bytes.fill(0)
  original.role = 'changed'
  const receipt = await pending,
    expected = { role: 'owned-input' }
  const first = await f.store.read(id, expected)
  if (first.state !== 'stored') throw new Error('Expected stored original')
  expect(first.bytes).toEqual(new Uint8Array([7, 8]))
  first.bytes.fill(0)
  first.receipt.digest = '00'.repeat(32)
  const config = f.store.configuration
  config.maximumObjects = 99
  config.binding.purpose = 'changed'
  expect(f.store.configuration).toEqual(f.config)
  expect(await f.store.read(id, expected)).toEqual({
    state: 'stored',
    receipt,
    bytes: new Uint8Array([7, 8])
  })
})
test('never creates on open or repairs lost custody or inventory during explicit create', async () => {
  const f = await fixture()
  await expect(
    IndexedDBProtectedOperationObjectStore.open('missing', f.config, custody(), {
      factory: f.factory
    })
  ).rejects.toMatchObject({ code: 'unavailable' })
  await f.store.reserve(id, binding, 100)
  await expect(
    f.open({ ...f.config, recipient: new PrivateKey(86).toPublicKey().toString() })
  ).rejects.toThrow()
  await expect(f.open(f.config, custody(Buffer.alloc(32, 86)))).rejects.toThrow()
  expect((await f.store.read(id, binding)).state).toBe('reserved')
  await edit(f.factory, f.name, table => table.delete('head'))
  await expect(f.open()).rejects.toThrow()
  await expect(
    IndexedDBProtectedOperationObjectStore.create(f.name, f.config, custody(), {
      factory: f.factory
    })
  ).rejects.toThrow()
})
test.each(['missing', 'extra', 'swapped', 'modified'] as const)(
  'detects %s rows against authenticated inventory',
  async kind => {
    const f = await fixture()
    await f.store.reserve(id, binding, 100)
    await f.store.put(id, binding, new Uint8Array([9]))
    await edit(f.factory, f.name, (table, rows) => {
      const records = rows.filter(row => row.key !== 'head')
      if (kind === 'missing') table.delete(String(records[0].key))
      if (kind === 'extra') table.add({ ...records[0], key: '98'.repeat(32) })
      if (kind === 'swapped') {
        table.put({ ...records[0], payload: records[1].payload })
        table.put({ ...records[1], payload: records[0].payload })
      }
      if (kind === 'modified') table.put({ ...records[0], revision: '1' })
    })
    await expect(f.store.read(id, binding)).rejects.toMatchObject({ code: 'unavailable' })
  }
)
test('browser quota failure aborts the whole reservation and never manufactures a retained object', async () => {
  const f = await fixture()
  jest.spyOn(IDBObjectStore.prototype, 'add').mockImplementationOnce(() => {
    throw new DOMException('synthetic quota', 'QuotaExceededError')
  })
  await expect(f.store.reserve(id, binding, 100)).rejects.toMatchObject({ code: 'limited' })
  expect(await f.store.read(id, binding)).toEqual({ state: 'absent' })
  await f.store.reserve(id, binding, 100)
  jest.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => {
    throw new DOMException('synthetic quota', 'QuotaExceededError')
  })
  await expect(f.store.put(id, binding, new Uint8Array([1]))).rejects.toMatchObject({
    code: 'limited'
  })
  expect((await f.store.read(id, binding)).state).toBe('reserved')
  expect(await f.store.put(id, binding, new Uint8Array([1]))).toMatchObject({ bytes: 1 })
})
test.each(['native', 'foreign-realm'] as const)(
  'retains the %s abort reason while refusing a phantom object after a request error',
  async kind => {
    const f = await fixture(),
      reason: Error =
        kind === 'native'
          ? new Error('Synthetic request failure')
          : runInNewContext('new Error("Synthetic foreign-realm request failure")')
    // A storage provider can throw an Error from another execution realm.
    // The local rejection remains an Error and retains that original as cause.
    jest.spyOn(IDBObjectStore.prototype, 'add').mockImplementationOnce(() => {
      throw reason
    })
    const failed = f.store.reserve(id, binding, 100)
    if (kind === 'native') await expect(failed).rejects.toBe(reason)
    else
      await expect(failed).rejects.toMatchObject({
        message: 'Protected object transaction failed',
        cause: reason
      })
    expect(await f.store.read(id, binding)).toEqual({ state: 'absent' })
    await f.store.reserve(id, binding, 100)
    expect((await f.store.read(id, binding)).state).toBe('reserved')
  }
)
test('close prevents further writes while allowing recovery using another connection', async () => {
  const f = await fixture()
  await f.store.reserve(id, binding, 100)
  await f.store.close()
  await f.store.close()
  await expect(f.store.put(id, binding, new Uint8Array([1]))).rejects.toMatchObject({
    code: 'unavailable'
  })
  expect((await (await f.open()).read(id, binding)).state).toBe('reserved')
})

test('owns the selected browser database before awaiting initial wallet custody', async () => {
  const factory = new IDBFactory(),
    changed = new IDBFactory(),
    options = { factory },
    codec = custody(),
    original = codec.seal.bind(codec)
  codec.seal = async (...args) => {
    options.factory = changed
    return await original(...args)
  }
  const store = await IndexedDBProtectedOperationObjectStore.create(
    'original-factory',
    configuration,
    codec,
    options
  )
  stores.push(store)
  expect(await store.read(id, binding)).toEqual({ state: 'absent' })
  const reopened = await IndexedDBProtectedOperationObjectStore.open(
    'original-factory',
    configuration,
    custody(),
    { factory }
  )
  stores.push(reopened)
  await expect(
    IndexedDBProtectedOperationObjectStore.open('original-factory', configuration, custody(), {
      factory: changed
    })
  ).rejects.toMatchObject({ code: 'unavailable' })
})

test('rejects a changed database opener after awaited encryption rather than redirecting initialization', async () => {
  const factory = new IDBFactory(),
    codec = custody(),
    original = codec.seal.bind(codec)
  const replacement = jest.fn<IDBFactory['open']>()
  codec.seal = async (...args) => {
    factory.open = replacement
    return await original(...args)
  }
  await expect(
    IndexedDBProtectedOperationObjectStore.create('changed-opener', configuration, codec, {
      factory
    })
  ).rejects.toMatchObject({ code: 'context-changed' })
  expect(replacement).not.toHaveBeenCalled()
})
