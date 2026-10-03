import { afterEach, expect, jest, test } from '@jest/globals'
import { IDBDatabase, IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { PrivateKey } from '@bsv/sdk'
import { IndexedDBProtectedOperationObjectStore } from '../src/operations/IndexedDBProtectedOperationObjectStore.js'
import { ProtectedOperationObjectCipher } from '../src/operations/ProtectedOperationObjectCipher.js'
import {
  ProtectedOperationObjectPlan,
  OPERATION_OBJECT_HEADER_BYTES
} from '../src/operations/ProtectedOperationObjectPlan.js'
import { custody } from './protected-operation-object.fixture.js'

const tableName = 'protected-operation-objects',
  id = '96'.repeat(32),
  binding = { acquisition: 'original', role: 'private-delivery' }
const configuration = {
  storeId: '95'.repeat(32),
  recipient: new PrivateKey(85).toPublicKey().toString(),
  binding: { purpose: 'synthetic-browser-custody' },
  maximumObjects: 2,
  maximumObjectBytes: 100
}
const owners: IndexedDBProtectedOperationObjectStore[] = [],
  connections: IDBDatabase[] = []
afterEach(async () => {
  jest.restoreAllMocks()
  for (const database of connections.splice(0)) database.close()
  await Promise.all(owners.splice(0).map(owner => owner.close()))
})
function opened(request: IDBOpenDBRequest): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      connections.push(request.result)
      resolve(request.result)
    }
  })
}
async function fixture(maximumObjects = 2) {
  const factory = new IDBFactory(),
    name = 'browser-boundary',
    config = { ...configuration, maximumObjects },
    codec = custody()
  const seal = codec.seal
  let beforeSeal: (() => Promise<void>) | undefined
  codec.seal = async (...args) => {
    await beforeSeal?.()
    return await seal.apply(codec, args)
  }
  const plan = new ProtectedOperationObjectPlan(config),
    cipher = new ProtectedOperationObjectCipher(plan, codec),
    store = await IndexedDBProtectedOperationObjectStore.create(name, config, codec, { factory })
  owners.push(store)
  return {
    factory,
    name,
    config,
    store,
    plan,
    cipher,
    beforeSeal: (work?: () => Promise<void>) => {
      beforeSeal = work
    }
  }
}
async function rows(f: Awaited<ReturnType<typeof fixture>>) {
  const database = await opened(f.factory.open(f.name))
  try {
    return await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const transaction = database.transaction(tableName),
        request: IDBRequest<Record<string, unknown>[]> = transaction.objectStore(tableName).getAll()
      transaction.onabort = () => reject(transaction.error)
      transaction.oncomplete = () => resolve(request.result)
    })
  } finally {
    database.close()
  }
}
async function changeRows(
  f: Awaited<ReturnType<typeof fixture>>,
  change: (table: IDBObjectStore) => void
) {
  const database = await opened(f.factory.open(f.name))
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(tableName, 'readwrite')
      transaction.onabort = () => reject(transaction.error)
      transaction.oncomplete = () => resolve()
      change(transaction.objectStore(tableName))
    })
  } finally {
    database.close()
  }
}

test.each(['absent', 'missing-open', 'non-callable-open'] as const)(
  'refuses the %s database capability before custody or database effects',
  async kind => {
    const factory =
        kind === 'absent'
          ? undefined
          : ({ open: kind === 'missing-open' ? undefined : 1 } as unknown as IDBFactory),
      codec = custody(),
      seal = jest.spyOn(codec, 'seal')
    await expect(
      IndexedDBProtectedOperationObjectStore.create('unsupported', configuration, codec, {
        factory
      })
    ).rejects.toMatchObject({ code: 'unsupported', message: 'IndexedDB is unavailable' })
    expect(seal).not.toHaveBeenCalled()
  }
)
test.each([0, -1, 0.5, 60001, Number.NaN, Number.POSITIVE_INFINITY])(
  'refuses an invalid open deadline %s before opening or sealing',
  async openTimeoutMs => {
    const factory = new IDBFactory(),
      open = jest.spyOn(factory, 'open'),
      codec = custody(),
      seal = jest.spyOn(codec, 'seal')
    await expect(
      IndexedDBProtectedOperationObjectStore.create('deadline', configuration, codec, {
        factory,
        openTimeoutMs
      })
    ).rejects.toMatchObject({ code: 'invalid', message: 'Invalid protected object open deadline' })
    expect(open).not.toHaveBeenCalled()
    expect(seal).not.toHaveBeenCalled()
  }
)
test.each([1, 60000])(
  'accepts the exact open deadline %s and retains a synchronous provider failure',
  async openTimeoutMs => {
    const factory = new IDBFactory(),
      reason = new Error('Synthetic database opener failure'),
      open = jest.spyOn(factory, 'open').mockImplementation(() => {
        throw reason
      })
    await expect(
      IndexedDBProtectedOperationObjectStore.create('original', configuration, custody(), {
        factory,
        openTimeoutMs
      })
    ).rejects.toBe(reason)
    expect(open).toHaveBeenCalledWith('original', 1)
  }
)

test('releases its connection on version change and refuses every later operation', async () => {
  const f = await fixture()
  await f.store.reserve(id, binding, 100)
  const database = await opened(f.factory.open(f.name, 2))
  database.close()
  const failure = { code: 'unavailable', message: 'Protected operation object store is closed' }
  await expect(f.store.read(id, binding)).rejects.toMatchObject(failure)
  await expect(f.store.reserve(id, binding, 100)).rejects.toMatchObject(failure)
  await expect(f.store.put(id, binding, Uint8Array.of(1))).rejects.toMatchObject(failure)
  await expect(
    IndexedDBProtectedOperationObjectStore.open(f.name, f.config, custody(), { factory: f.factory })
  ).rejects.toMatchObject({
    code: 'unavailable',
    message: 'Cannot open original protected object database',
    retryable: true
  })
})
test('aborts late initialization after a native blocked open exceeds its deadline', async () => {
  const factory = new IDBFactory(),
    held = await opened(factory.open('blocked', 1)),
    deletion = factory.deleteDatabase('blocked')
  const deleted = new Promise<void>((resolve, reject) => {
    deletion.onsuccess = () => resolve()
    deletion.onerror = () => reject(deletion.error)
  })
  await new Promise<void>(resolve => {
    deletion.onblocked = () => resolve()
  })
  try {
    await expect(
      IndexedDBProtectedOperationObjectStore.create('blocked', configuration, custody(), {
        factory,
        openTimeoutMs: 20
      })
    ).rejects.toMatchObject({
      code: 'unavailable',
      message: 'Protected object open deadline',
      retryable: true
    })
  } finally {
    held.close()
  }
  await deleted
  const request = factory.open('blocked', 1)
  let oldVersion: number | undefined
  request.onupgradeneeded = event => {
    oldVersion = event.oldVersion
  }
  const database = await opened(request)
  expect(oldVersion).toBe(0)
  expect(database.objectStoreNames).toHaveLength(0)
  database.close()
})

test.each(['extra-table', 'missing-table', 'key-path', 'auto-increment', 'index'] as const)(
  'refuses the %s native schema instead of treating it as original custody',
  async kind => {
    const factory = new IDBFactory(),
      codec = custody(),
      cipher = new ProtectedOperationObjectCipher(
        new ProtectedOperationObjectPlan(configuration),
        codec
      ),
      head = await cipher.sealInventory({ revision: '0', entries: [] }),
      request = factory.open('schema', 1)
    request.onupgradeneeded = () => {
      const database = request.result
      if (kind === 'missing-table') {
        database.createObjectStore('other')
        return
      }
      const table = database.createObjectStore(tableName, {
        keyPath: kind === 'key-path' ? 'alternate' : 'key',
        autoIncrement: kind === 'auto-increment'
      })
      if (kind === 'extra-table') database.createObjectStore('other')
      if (kind === 'index') table.createIndex('unexpected', 'revision')
      table.add(kind === 'key-path' ? { ...head, alternate: 'head' } : head)
    }
    const database = await opened(request)
    database.close()
    await expect(
      IndexedDBProtectedOperationObjectStore.open('schema', configuration, codec, { factory })
    ).rejects.toMatchObject({
      code: 'unavailable',
      message: ['extra-table', 'missing-table'].includes(kind)
        ? 'Protected object schema differs'
        : 'Protected object table schema differs'
    })
  }
)

test('retains independently bound objects in sorted authenticated inventory across replacements and reopen', async () => {
  const f = await fixture(3),
    ids = ['ff'.repeat(32), id, '11'.repeat(32)]
  for (const selected of ids) await f.store.reserve(selected, { ...binding, selected }, 100)
  const receipt = await f.store.put(id, { ...binding, selected: id }, Uint8Array.of(2, 3))
  const raw = await rows(f),
    inventory = await f.cipher.inventory(
      raw.find(row => row.key === 'head'),
      raw.map(row => String(row.key))
    )
  expect(inventory.revision).toBe('4')
  expect(inventory.entries.map(entry => entry.id)).toEqual([...ids].sort())
  expect(inventory.entries.map(entry => entry.complete)).toEqual([false, true, false])
  const reopened = await IndexedDBProtectedOperationObjectStore.open(f.name, f.config, custody(), {
    factory: f.factory
  })
  owners.push(reopened)
  expect(await reopened.read(id, { ...binding, selected: id })).toEqual({
    state: 'stored',
    receipt,
    bytes: Uint8Array.of(2, 3)
  })
  for (const selected of [ids[0], ids[2]])
    expect(await reopened.read(selected, { ...binding, selected })).toMatchObject({
      state: 'reserved'
    })
})
test('refuses excess native rows before parsing or decrypting them', async () => {
  const f = await fixture(1),
    raw = await rows(f)
  await changeRows(f, table => {
    for (const key of ['10', '20', '30']) table.add({ ...raw[0], key: key.repeat(32) })
  })
  await expect(f.store.read(id, binding)).rejects.toMatchObject({
    code: 'limited',
    message: 'Protected object row capacity exceeded'
  })
})
test('rejects malformed returned framing through a native transaction without claiming a result', async () => {
  const f = await fixture(),
    raw = await rows(f)
  await changeRows(f, table => table.put({ ...raw[0], payload: [] }))
  await expect(f.store.read(id, binding)).rejects.toMatchObject({
    code: 'invalid',
    message: 'Expected protected object record'
  })
})
test('checks retained ciphertext independently of the valid inventory before decoding a payload', async () => {
  const f = await fixture()
  await f.store.reserve(id, binding, 100)
  const raw = await rows(f),
    row = raw.find(row => row.key !== 'head')!
  await changeRows(f, table => table.put({ ...row, revision: '2' }))
  await expect(f.store.read(id, binding)).rejects.toMatchObject({
    code: 'unavailable',
    message: 'Protected object ciphertext differs from inventory'
  })
})
test('checks completion against authenticated inventory even when the substituted header is valid', async () => {
  const f = await fixture()
  await f.store.reserve(id, binding, 100)
  const raw = await rows(f),
    inventory = await f.cipher.inventory(
      raw.find(row => row.key === 'head'),
      raw.map(row => String(row.key))
    ),
    address = f.cipher.addresses(id)[0],
    header = await f.cipher.seal(
      address,
      '1',
      f.plan.frame(f.plan.complete(f.plan.reservation(id, binding, 100), Uint8Array.of(1))),
      OPERATION_OBJECT_HEADER_BYTES
    )
  inventory.entries[0].digests[0] = f.cipher.envelopeDigest(header)
  const head = await f.cipher.sealInventory(inventory)
  await changeRows(f, table => {
    table.put(header)
    table.put(head)
  })
  await expect(f.store.read(id, binding)).rejects.toMatchObject({
    code: 'unavailable',
    message: 'Protected object completion differs from inventory'
  })
})

test.each(['abort', 'quota'] as const)(
  'retains the %s transaction refusal with no fabricated success',
  async kind => {
    const f = await fixture(),
      original = IDBDatabase.prototype.transaction
    const fault = jest.spyOn(IDBDatabase.prototype, 'transaction').mockImplementationOnce(function (
      this: IDBDatabase,
      ...args
    ) {
      const transaction = original.apply(this, args)
      queueMicrotask(() => {
        Object.defineProperty(transaction, 'error', {
          value:
            kind === 'quota' ? new DOMException('Synthetic quota', 'QuotaExceededError') : null,
          writable: true
        })
        transaction.abort()
      })
      return transaction
    })
    await expect(f.store.reserve(id, binding, 100)).rejects.toMatchObject({
      code: kind === 'quota' ? 'limited' : 'unavailable',
      message: 'Protected object transaction aborted',
      retryable: true
    })
    fault.mockRestore()
    expect(await f.store.read(id, binding)).toEqual({ state: 'absent' })
  }
)
test('refuses a transaction that completes after its storage provider drops a required result callback', async () => {
  const f = await fixture(),
    original = IDBObjectStore.prototype.get,
    dropped: unknown[] = []
  const fault = jest.spyOn(IDBObjectStore.prototype, 'get').mockImplementationOnce(function (
    this: IDBObjectStore,
    ...args
  ) {
    const request = original.apply(this, args)
    Object.defineProperty(request, 'onsuccess', {
      get: () => null,
      set: (callback: unknown) => {
        dropped.push(callback)
      }
    })
    return request
  })
  await expect(f.store.read(id, binding)).rejects.toMatchObject({
    code: 'unavailable',
    message: 'Protected object transaction has no result'
  })
  expect(dropped).toHaveLength(1)
  fault.mockRestore()
  expect(await f.store.read(id, binding)).toEqual({ state: 'absent' })
})
test.each(['success', 'failure'] as const)(
  'clears owned outgoing bytes after %s without changing callers or the retained first result',
  async kind => {
    const f = await fixture()
    await f.store.reserve(id, binding, 100)
    const first = Uint8Array.of(1, 2),
      receipt = await f.store.put(id, binding, first),
      original = ProtectedOperationObjectPlan.prototype.complete,
      input = kind === 'success' ? first : Uint8Array.of(3, 4)
    let copied: Uint8Array | undefined
    jest.spyOn(ProtectedOperationObjectPlan.prototype, 'complete').mockImplementation(function (
      this: ProtectedOperationObjectPlan,
      header,
      bytes
    ) {
      copied = bytes
      return original.call(this, header, bytes)
    })
    if (kind === 'success') expect(await f.store.put(id, binding, input)).toEqual(receipt)
    else await expect(f.store.put(id, binding, input)).rejects.toMatchObject({ code: 'conflict' })
    expect(copied).toEqual(new Uint8Array(2))
    expect(input).toEqual(kind === 'success' ? Uint8Array.of(1, 2) : Uint8Array.of(3, 4))
    expect(await f.store.read(id, binding)).toEqual({ state: 'stored', receipt, bytes: first })
  }
)

test('retains explicit strict durability on every observed read and write transaction', async () => {
  const f = await fixture(),
    transactions = jest.spyOn(IDBDatabase.prototype, 'transaction')
  await f.store.reserve(id, binding, 100)
  await f.store.put(id, binding, Uint8Array.of(1))
  await f.store.read(id, binding)
  expect(transactions.mock.calls.some(call => call[1] === 'readonly')).toBe(true)
  expect(transactions.mock.calls.some(call => call[1] === 'readwrite')).toBe(true)
  for (const call of transactions.mock.calls)
    expect(call.slice(0, 3)).toEqual([tableName, call[1], { durability: 'strict' }])
})
test('refuses installed object exhaustion and changed reservation without acknowledging another obligation', async () => {
  const f = await fixture(1)
  const original = await f.store.reserve(id, binding, 100)
  await expect(f.store.reserve('97'.repeat(32), binding, 1)).rejects.toMatchObject({
    code: 'limited',
    message: 'Protected object installation capacity exhausted'
  })
  await expect(f.store.reserve(id, binding, 99)).rejects.toMatchObject({
    code: 'conflict',
    message: 'Protected operation object reservation changed'
  })
  expect(await f.store.read(id, binding)).toEqual({ state: 'reserved', reservation: original })
})
test.each([null, [1], new Uint8Array(101)])(
  'refuses invalid or over-capacity bytes before looking up the original reservation (%p)',
  async input => {
    const f = await fixture()
    await expect(f.store.put(id, binding, input as unknown as Uint8Array)).rejects.toMatchObject({
      code: 'limited',
      message: 'Protected object exceeds installed capacity'
    })
    expect(await f.store.read(id, binding)).toEqual({ state: 'absent' })
  }
)
test('requires the exact original reservation before storing otherwise valid bytes', async () => {
  const f = await fixture()
  await expect(f.store.put(id, binding, Uint8Array.of(1))).rejects.toMatchObject({
    code: 'unavailable',
    message: 'Protected object requires original reservation'
  })
  expect(await f.store.read(id, binding)).toEqual({ state: 'absent' })
})
test.each(['reserve', 'put'] as const)(
  'refuses a stale %s when an independent object commits during encryption',
  async operation => {
    const f = await fixture(),
      otherId = '97'.repeat(32),
      otherBinding = { acquisition: 'independent', role: 'private-delivery' },
      second = await IndexedDBProtectedOperationObjectStore.open(f.name, f.config, custody(), {
        factory: f.factory
      })
    owners.push(second)
    if (operation === 'put') await f.store.reserve(id, binding, 100)
    f.beforeSeal(async () => {
      f.beforeSeal()
      await second.reserve(otherId, otherBinding, 100)
    })
    const pending =
      operation === 'reserve'
        ? f.store.reserve(id, binding, 100)
        : f.store.put(id, binding, Uint8Array.of(1))
    await expect(pending).rejects.toMatchObject({
      code: 'conflict',
      message: 'Protected object changed during encryption; reconcile the original operation'
    })
    expect(await second.read(otherId, otherBinding)).toMatchObject({ state: 'reserved' })
    expect((await f.store.read(id, binding)).state).toBe(
      operation === 'reserve' ? 'absent' : 'reserved'
    )
    await f.store.reserve(id, binding, 100)
    expect(await f.store.put(id, binding, Uint8Array.of(1))).toMatchObject({ id, bytes: 1 })
    expect((await second.read(otherId, otherBinding)).state).toBe('reserved')
  }
)
test.each(['keys', 'one-row'] as const)(
  'independently checks %s at native commit while the authenticated head is unchanged',
  async changed => {
    const f = await fixture()
    await f.store.reserve(id, binding, 100)
    const original = await rows(f),
      row = f.cipher.envelope(original.find(value => value.key !== 'head')),
      extra = '98'.repeat(32)
    f.beforeSeal(async () => {
      f.beforeSeal()
      await changeRows(f, table => {
        if (changed === 'keys') table.add({ ...row, key: extra })
        else table.put({ ...row, payload: { ...row.payload, nonce: 'changed' } })
      })
    })
    await expect(f.store.put(id, binding, Uint8Array.of(1))).rejects.toMatchObject({
      code: 'conflict',
      message: 'Protected object changed during encryption; reconcile the original operation'
    })
    await changeRows(f, table => {
      table.delete(extra)
      table.put(row)
    })
    expect((await f.store.read(id, binding)).state).toBe('reserved')
    expect(await f.store.put(id, binding, Uint8Array.of(1))).toMatchObject({ id, bytes: 1 })
  }
)

test('retains the quota refusal and retry promise for a synchronous storage-provider failure', async () => {
  const f = await fixture(),
    fault = jest.spyOn(IDBObjectStore.prototype, 'get').mockImplementationOnce(() => {
      throw new DOMException('Synthetic read quota', 'QuotaExceededError')
    })
  await expect(f.store.read(id, binding)).rejects.toMatchObject({
    code: 'limited',
    message: 'Protected object browser quota exhausted',
    retryable: true
  })
  fault.mockRestore()
  expect(await f.store.read(id, binding)).toEqual({ state: 'absent' })
})
test('binds the exact database opener across asynchronous custody before any database call', async () => {
  const factory = new IDBFactory(),
    codec = custody(),
    original = codec.seal,
    replacement = jest.fn<IDBFactory['open']>()
  codec.seal = async (...args) => {
    factory.open = replacement
    return await original.apply(codec, args)
  }
  await expect(
    IndexedDBProtectedOperationObjectStore.create('changed-opener', configuration, codec, {
      factory
    })
  ).rejects.toMatchObject({
    code: 'context-changed',
    message: 'Protected object database capability changed'
  })
  expect(replacement).not.toHaveBeenCalled()
})
