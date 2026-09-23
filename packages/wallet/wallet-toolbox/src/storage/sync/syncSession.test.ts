import 'fake-indexeddb/auto'
import { randomUUID } from 'node:crypto'
import { PrivateKey } from '@bsv/sdk'
import { StorageIdb } from '../StorageIdb'
import { StorageProvider } from '../StorageProvider'
import { WalletStorageManager } from '../WalletStorageManager'
import type { SyncSessionProgress } from './syncSession'

const stores: StorageIdb[] = []
const identityKey = PrivateKey.fromRandom().toPublicKey().toString()

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

async function makeStorage(dbName?: string): Promise<StorageIdb> {
  const storage = new StorageIdb(StorageProvider.createStorageBaseOptions('test'))
  storage.dbName = dbName ?? `sync-session-${randomUUID()}`
  stores.push(storage)
  await storage.migrate('sync session fixture', PrivateKey.fromRandom().toPublicKey().toString())
  await storage.makeAvailable()
  return storage
}

async function fixture(rows = 25) {
  const reader = await makeStorage()
  const writer = await makeStorage()
  const { user } = await reader.findOrInsertUser(identityKey)
  for (let i = 0; i < rows; i++) await reader.findOrInsertTxLabel(user.userId, `source label ${i}`)
  const manager = new WalletStorageManager(identityKey, writer)
  await manager.makeAvailable()
  return { reader, writer, manager }
}

afterEach(async () => {
  jest.restoreAllMocks()
  for (const storage of stores) await storage.destroy()
  for (const storage of stores.splice(0)) await storage.dropAllData()
})

test('foreground reads and writes complete while source I/O waits, with bounded pages and durable progress', async () => {
  const { reader, writer, manager } = await fixture()
  const entered = deferred()
  const release = deferred()
  const read = reader.getSyncChunk.bind(reader)
  const reads = jest.spyOn(reader, 'getSyncChunk').mockImplementationOnce(async args => {
    const chunk = await read(args)
    entered.resolve()
    await release.promise
    return chunk
  })
  const events: SyncSessionProgress[] = []
  const sync = manager.syncFromReaderResumable(identityKey, reader, {
    maxItems: 3,
    maxRoughSize: 4096,
    onProgress: event => events.push(event)
  })
  await entered.promise
  try {
    const userId = await manager.getUserId()
    await manager.runAsWriter(async () => {
      await writer.findOrInsertTxLabel(userId, 'foreground write')
    })
    expect(await manager.runAsReader(async () => await writer.countTxLabels({ partial: { userId } }))).toBe(1)
  } finally {
    release.resolve()
  }
  const result = await sync
  expect(result).toMatchObject({ status: 'completed', mode: 'paged' })
  expect(result.pages).toBeGreaterThan(8)
  expect(reads.mock.calls.every(([args]) => args.maxItems <= 3 && args.maxRoughSize <= 4096)).toBe(true)
  expect(events.filter(event => event.state === 'committed')).toHaveLength(result.pages)
  expect(events.every(event => event.mode === 'paged')).toBe(true)
  expect(await writer.countTxLabels({ partial: {} })).toBe(26)
  expect((await manager.syncFromReaderResumable(identityKey, reader)).inserts).toBe(0)
})

test('cancellation during a read discards the late page without starting a write', async () => {
  const { reader, writer, manager } = await fixture()
  const entered = deferred()
  const release = deferred()
  const read = reader.getSyncChunk.bind(reader)
  jest.spyOn(reader, 'getSyncChunk').mockImplementationOnce(async args => {
    const chunk = await read(args)
    entered.resolve()
    await release.promise
    return chunk
  })
  const process = jest.spyOn(writer, 'prepareSyncChunk')
  const controller = new AbortController()
  const sync = manager.syncFromReaderResumable(identityKey, reader, { signal: controller.signal })
  await entered.promise
  controller.abort()
  release.resolve()
  expect(await sync).toMatchObject({ status: 'cancelled', pages: 0, inserts: 0 })
  expect(process).not.toHaveBeenCalled()
  expect(await writer.countTxLabels({ partial: {} })).toBe(0)
})

test('cancellation waits for a committed page acknowledgement and a reopened manager resumes it', async () => {
  const { reader, writer, manager } = await fixture()
  const entered = deferred()
  const release = deferred()
  const prepare = writer.prepareSyncChunk.bind(writer)
  const spy = jest.spyOn(writer, 'prepareSyncChunk').mockImplementationOnce(async (args, chunk) => {
    const commit = await prepare(args, chunk)
    return async () => {
      const result = await commit()
      entered.resolve()
      await release.promise
      return result
    }
  })
  const controller = new AbortController()
  const states: string[] = []
  let settled = false
  const sync = manager
    .syncFromReaderResumable(identityKey, reader, {
      maxItems: 3,
      signal: controller.signal,
      onProgress: event => states.push(event.state)
    })
    .then(result => {
      settled = true
      return result
    })
  await entered.promise
  controller.abort()
  await Promise.resolve()
  expect(settled).toBe(false)
  release.resolve()
  const stopped = await sync
  expect(stopped).toMatchObject({ status: 'cancelled', pages: 1 })
  expect(stopped.checkpoint?.offsets.some(entry => entry.offset > 0)).toBe(true)
  expect(states.slice(-3)).toEqual(['committed', 'cancelling', 'cancelled'])
  spy.mockRestore()
  await writer.destroy()
  const reopened = await makeStorage(writer.dbName)
  const resumed = new WalletStorageManager(identityKey, reopened)
  expect(await resumed.syncFromReaderResumable(identityKey, reader, { maxItems: 3 })).toMatchObject({
    status: 'completed'
  })
  expect(await reopened.countTxLabels({ partial: {} })).toBe(25)
  expect(await resumed.syncFromReaderResumable(identityKey, reader)).toMatchObject({ inserts: 0, updates: 0 })
})

test('a lost acknowledgement is not retried; restart loads the committed destination checkpoint', async () => {
  const { reader, writer, manager } = await fixture()
  const prepare = writer.prepareSyncChunk.bind(writer)
  const lost = new Error('lost acknowledgement after commit')
  const spy = jest.spyOn(writer, 'prepareSyncChunk').mockImplementationOnce(async (args, chunk) => {
    const commit = await prepare(args, chunk)
    return async () => {
      await commit()
      throw lost
    }
  })
  await expect(manager.syncFromReaderResumable(identityKey, reader, { maxItems: 3 })).rejects.toBe(lost)
  expect(spy).toHaveBeenCalledTimes(1)
  spy.mockRestore()
  const resumed = new WalletStorageManager(identityKey, writer)
  await resumed.syncFromReaderResumable(identityKey, reader, { maxItems: 3 })
  expect(await writer.countTxLabels({ partial: {} })).toBe(25)
})

test('primary replacement fences a late source reply before it mutates the old writer', async () => {
  const { reader, writer } = await fixture()
  const replacement = await makeStorage()
  const manager = new WalletStorageManager(identityKey, writer, [replacement])
  await manager.makeAvailable()
  await manager.setActive(writer.getSettings().storageIdentityKey)
  const entered = deferred()
  const release = deferred()
  const read = reader.getSyncChunk.bind(reader)
  jest.spyOn(reader, 'getSyncChunk').mockImplementationOnce(async args => {
    const chunk = await read(args)
    entered.resolve()
    await release.promise
    return chunk
  })
  const prepare = writer.prepareSyncChunk.bind(writer)
  const process = jest.fn()
  jest.spyOn(writer, 'prepareSyncChunk').mockImplementation(async (args, chunk) => {
    const commit = await prepare(args, chunk)
    return async () => {
      process()
      return await commit()
    }
  })
  const sync = manager.syncFromReaderResumable(identityKey, reader)
  const rejected = expect(sync).rejects.toThrow('destination generation changed')
  await entered.promise
  try {
    await manager.setActive(replacement.getSettings().storageIdentityKey)
  } finally {
    release.resolve()
  }
  await rejected
  expect(process).not.toHaveBeenCalled()
  expect(await writer.countTxLabels({ partial: {} })).toBe(0)
  expect(await replacement.countTxLabels({ partial: {} })).toBe(0)
})

test('concurrent sessions cannot commit the same checkpoint twice', async () => {
  const { reader, writer, manager } = await fixture()
  const entered = deferred()
  const release = deferred()
  const read = reader.getSyncChunk.bind(reader)
  let reads = 0
  jest.spyOn(reader, 'getSyncChunk').mockImplementation(async args => {
    const chunk = await read(args)
    if (++reads <= 2) {
      if (reads === 2) entered.resolve()
      await release.promise
    }
    return chunk
  })
  const copies = Promise.allSettled([
    manager.syncFromReaderResumable(identityKey, reader, { maxItems: 3 }),
    manager.syncFromReaderResumable(identityKey, reader, { maxItems: 3 })
  ])
  await entered.promise
  release.resolve()
  const outcomes = await copies
  expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  const failure = outcomes.find(result => result.status === 'rejected') as PromiseRejectedResult
  expect(failure.reason.message).toContain('checkpoint changed')
  expect(await writer.countTxLabels({ partial: {} })).toBe(25)
})

test('legacy destination capabilities retain exclusive execution and checkpoint fallback', async () => {
  const { reader, writer } = await fixture()
  jest.spyOn(writer, 'getCapabilities').mockResolvedValue({})
  jest.spyOn(writer, 'getSyncCheckpoint').mockResolvedValue(undefined as never)
  const process = writer.processSyncChunk.bind(writer)
  jest.spyOn(writer, 'processSyncChunk').mockImplementation(async (args, chunk) => {
    const { nextCheckpoint: _, ...result } = await process({ ...args, includeNextCheckpoint: false }, chunk)
    return result
  })
  const manager = new WalletStorageManager(identityKey, writer)
  const entered = deferred()
  const release = deferred()
  const read = reader.getSyncChunk.bind(reader)
  jest.spyOn(reader, 'getSyncChunk').mockImplementationOnce(async args => {
    entered.resolve()
    await release.promise
    return await read(args)
  })
  const sync = manager.syncFromReaderResumable(identityKey, reader, { maxItems: 4 })
  await entered.promise
  let foreground = false
  const queued = manager.runAsReader(async () => {
    foreground = true
  })
  await Promise.resolve()
  expect(foreground).toBe(false)
  release.resolve()
  expect(await sync).toMatchObject({ status: 'completed', mode: 'exclusive' })
  await queued
  expect(foreground).toBe(true)
  expect(await writer.countTxLabels({ partial: {} })).toBe(25)
})

test('progress observers cannot corrupt checkpoint state and unfinished zero-progress pages terminate', async () => {
  const { reader, writer, manager } = await fixture()
  await manager.syncFromReaderResumable(identityKey, reader, {
    maxItems: 3,
    onProgress: event => {
      if (event.checkpoint != null) event.checkpoint.offsets[0].offset = 999999
    }
  })
  expect(await writer.countTxLabels({ partial: {} })).toBe(25)
  const process = jest
    .spyOn(writer, 'prepareSyncChunk')
    .mockResolvedValue(async () => ({ done: false, inserts: 0, updates: 0 }))
  await expect(manager.syncFromReaderResumable(identityKey, reader)).rejects.toThrow('without advancing')
  expect(process).toHaveBeenCalledTimes(1)
})

test.each([true, false])('manager concurrent reads follow the provider promise (%s)', async concurrent => {
  const { writer } = await fixture(0)
  const capabilities = writer.getCapabilities.bind(writer)
  jest.spyOn(writer, 'getCapabilities').mockImplementation(async () => ({
    ...(await capabilities()),
    storageAccess: { version: 1, concurrentReads: concurrent, atomicSyncPages: true }
  }))
  const manager = new WalletStorageManager(identityKey, writer)
  await manager.makeAvailable()
  const entered = deferred()
  const release = deferred()
  const first = manager.runAsReader(async () => {
    entered.resolve()
    await release.promise
  })
  await entered.promise
  let secondEntered = false
  const second = manager.runAsReader(async () => {
    secondEntered = true
  })
  await new Promise(resolve => setImmediate(resolve))
  expect(secondEntered).toBe(concurrent)
  release.resolve()
  await Promise.all([first, second])
})

test('a queued page cancelled behind foreground work never starts its commit', async () => {
  const { reader, writer, manager } = await fixture()
  const locked = deferred()
  const release = deferred()
  const controller = new AbortController()
  const prepare = writer.prepareSyncChunk.bind(writer)
  const applied = jest.fn()
  jest.spyOn(writer, 'prepareSyncChunk').mockImplementation(async (args, chunk) => {
    const apply = await prepare(args, chunk)
    return async () => {
      applied()
      return await apply()
    }
  })
  let foreground: Promise<void> | undefined
  const sync = manager.syncFromReaderResumable(identityKey, reader, {
    signal: controller.signal,
    onProgress: event => {
      if (event.state === 'committing')
        foreground = manager.runAsWriter(async () => {
          locked.resolve()
          await release.promise
        })
    }
  })
  await locked.promise
  controller.abort()
  release.resolve()
  await foreground
  expect(await sync).toMatchObject({ status: 'cancelled', pages: 0 })
  expect(applied).not.toHaveBeenCalled()
  expect(await writer.countTxLabels({ partial: {} })).toBe(0)
})

test.each(['fromStorageIdentityKey', 'toStorageIdentityKey', 'userIdentityKey'] as const)(
  'rejects a page with the wrong %s before preparation',
  async key => {
    const { reader, writer, manager } = await fixture()
    const get = reader.getSyncChunk.bind(reader)
    jest
      .spyOn(reader, 'getSyncChunk')
      .mockImplementation(async args => ({ ...(await get(args)), [key]: 'wrong identity' }))
    const prepare = jest.spyOn(writer, 'prepareSyncChunk')
    await expect(manager.syncFromReaderResumable(identityKey, reader)).rejects.toThrow('bound to this sync')
    expect(prepare).not.toHaveBeenCalled()
    expect(await writer.countTxLabels({ partial: {} })).toBe(0)
  }
)

test.each([{ maxItems: 0 }, { maxItems: 1001 }, { maxRoughSize: Infinity }, { maxRoughSize: 1.5 }])(
  'rejects invalid bounds before fetching a page: %o',
  async options => {
    const { reader, writer, manager } = await fixture()
    const read = jest.spyOn(reader, 'getSyncChunk')
    await expect(manager.syncFromReaderResumable(identityKey, reader, options)).rejects.toThrow('an integer from')
    expect(read).not.toHaveBeenCalled()
    expect(await writer.countSyncStates({ partial: {} })).toBe(0)
  }
)

test('IndexedDB indexed paging retains filtered offset and timestamp semantics', async () => {
  const { reader } = await fixture(100)
  const { user } = await reader.findOrInsertUser(identityKey)
  const all = await reader.findTxLabels({ partial: { userId: user.userId } })
  const page = await reader.findTxLabels({ partial: { userId: user.userId }, paged: { offset: 80, limit: 5 } })
  expect(page).toEqual(all.slice(80, 85))
  await reader.updateTxLabel(all[85].txLabelId, { isDeleted: true, updated_at: new Date('2099-01-01') })
  expect(
    await reader.findTxLabels({ partial: { userId: user.userId, isDeleted: true }, paged: { offset: 1, limit: 5 } })
  ).toEqual([])
  expect(
    await reader.findTxLabels({
      partial: { userId: user.userId },
      since: new Date('2098-01-01'),
      paged: { offset: 1, limit: 5 }
    })
  ).toEqual([])
  expect(
    await reader.findTxLabels({
      partial: { userId: user.userId },
      since: new Date('2098-01-01'),
      paged: { offset: 0, limit: 5 }
    })
  ).toMatchObject([{ txLabelId: all[85].txLabelId }])
})

test.each([undefined, 10000000])(
  'uses a bounded new default without narrowing the explicit legacy ceiling (%s)',
  async maximum => {
    const { reader, manager } = await fixture(3)
    const calls = jest.spyOn(reader, 'getSyncChunk')
    await manager.syncFromReaderResumable(identityKey, reader, { maxRoughSize: maximum })
    expect(calls.mock.calls.length).toBeGreaterThan(0)
    expect(calls.mock.calls.every(([args]) => args.maxRoughSize === (maximum ?? 262144))).toBe(true)
  }
)
