import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { knex } from 'knex'
import { StorageKnex } from '../../StorageKnex'
import { StorageProvider } from '../../StorageProvider'
import { seedArchiveClosure } from '../../../../test/utils/snapshotArchiveFixtures'
import { KnexSnapshotArchiveService } from './KnexSnapshotArchiveService'
import { KnexSnapshotArchiveRequestStore } from './KnexSnapshotArchiveRequestStore'
import { snapshotArchiveRequestId } from './SnapshotArchiveRequest'
import { verifySnapshotArchiveDirectory, verifySnapshotArchivePage } from './SnapshotArchiveDirectory'
import * as ArchiveSql from './SnapshotArchiveSql'

const identity = '02' + '11'.repeat(32)
const other = '03' + '22'.repeat(32)
const stores: StorageKnex[] = []
const services: KnexSnapshotArchiveService[] = []
const directories: string[] = []
function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}
function service(storage: StorageKnex) {
  const controller = new KnexSnapshotArchiveService(storage)
  services.push(controller)
  return controller
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'snapshot-service-'))
  directories.push(directory)
  const open = () => {
    const storage = new StorageKnex({
      ...StorageProvider.createStorageBaseOptions('test'),
      knex: knex({
        client: 'better-sqlite3',
        connection: { filename: join(directory, 'wallet.sqlite') },
        useNullAsDefault: true,
        pool: { min: 1, max: 1 }
      })
    })
    stores.push(storage)
    return storage
  }
  const storage = open()
  await storage.knex.raw('PRAGMA journal_mode = WAL')
  await storage.migrate('service source', 'service-source')
  await storage.makeAvailable()
  const { user } = await storage.findOrInsertUser(identity)
  const { user: peer } = await storage.findOrInsertUser(other)
  await seedArchiveClosure(storage, user.userId, peer.userId)
  return { storage, controller: service(storage), open }
}
function request(nonce = 'b'.repeat(64)) {
  const fields = { version: 1 as const, nonce, notAfter: Date.now() + 300000, maxBytes: 32768 }
  return { ...fields, requestId: snapshotArchiveRequestId(fields) }
}
afterEach(async () => {
  jest.restoreAllMocks()
  await Promise.all(services.splice(0).map(controller => controller.close().catch(() => undefined)))
  await Promise.all(stores.splice(0).map(storage => storage.destroy()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

test('capture reserves before reader acquisition and a replacement server recovers the exact immutable archive', async () => {
  const { storage, controller, open } = await fixture()
  const input = request()
  const original = storage.openSnapshotArchiveSource.bind(storage)
  const opening = jest.spyOn(storage, 'openSnapshotArchiveSource').mockImplementation(async (key, options) => {
    expect(await storage.knex('snapshot_archive_capacity').first()).toMatchObject({ archives: 1, reservedBytes: 32768 })
    expect((await controller.status(identity, input.requestId)).state).toBe('building')
    expect(options?.signal).toBeInstanceOf(AbortSignal)
    expect(options?.lifetimeMs).toBeGreaterThan(0)
    expect(options?.lifetimeMs).toBeLessThanOrEqual(300000)
    return await original(key, options)
  })
  const pending = controller.create(identity, input)
  expect(controller.create(identity, { ...input })).toBe(pending)
  expect(() => controller.create(other, input)).toThrow('opening or active')
  expect(() => controller.create(identity, request('c'.repeat(64)))).toThrow('opening or active')
  const ready = await pending
  expect(ready).toMatchObject({ state: 'ready', requestId: input.requestId, expiresAt: input.notAfter })
  expect(opening).toHaveBeenCalledTimes(1)
  expect(Reflect.get(storage, 'snapshotSyncSource')).toBeUndefined()
  const directory = await controller.directory(identity, ready.archiveId!)
  const verified = verifySnapshotArchiveDirectory(directory, {
    identityKey: identity,
    chain: 'test',
    sourceStorageIdentityKey: 'service-source',
    digest: ready.digest
  })
  expect(verified.manifest.pages).toBe(13)
  const page = await controller.read(identity, ready.archiveId!, 8)
  expect(verifySnapshotArchivePage(page, verified.receipts[8])).toEqual(page.bytes)
  await expect(controller.directory(other, ready.archiveId!)).rejects.toThrow('unavailable')
  await expect(controller.read(other, ready.archiveId!, 8)).rejects.toThrow('unavailable')
  await expect(controller.status(other, input.requestId)).rejects.toThrow('unavailable')
  await controller.cancel(other, input.requestId)
  expect(await controller.status(identity, input.requestId)).toEqual(ready)
  await controller.close()
  const replacementStorage = open()
  await replacementStorage.makeAvailable()
  const replacement = service(replacementStorage)
  const replacementOpen = jest.spyOn(replacementStorage, 'openSnapshotArchiveSource')
  expect(await replacement.create(identity, input)).toEqual(ready)
  expect(replacementOpen).not.toHaveBeenCalled()
  expect(await replacement.directory(identity, ready.archiveId!)).toEqual(directory)
  expect(await replacement.read(identity, ready.archiveId!, 8)).toEqual(page)
  await replacement.cancel(identity, input.requestId)
  expect((await replacement.create(identity, input)).state).toBe('closed')
  expect(replacementOpen).not.toHaveBeenCalled()
  expect(await storage.knex('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
})

test.each(['cancel', 'shutdown'] as const)(
  '%s during reader opening waits for physical destruction before releasing quota',
  async action => {
    const { storage, controller } = await fixture()
    const input = request()
    const entered = gate()
    const allowOpen = gate()
    const destroying = gate()
    const allowDestroy = gate()
    const original = storage.openSnapshotArchiveSource.bind(storage)
    jest.spyOn(storage, 'openSnapshotArchiveSource').mockImplementation(async (key, options) => {
      // Acquire the actual view, but withhold it from the controller until cancellation.
      const source = (await original(key, { ...options, signal: undefined }))!
      const reader = Reflect.get(storage, 'snapshotSyncSource') as StorageKnex
      const destroy = reader.destroy.bind(reader)
      jest.spyOn(reader, 'destroy').mockImplementation(async () => {
        destroying.resolve()
        await allowDestroy.promise
        await destroy()
      })
      entered.resolve()
      await allowOpen.promise
      return source
    })
    const capture = controller.create(identity, input)
    void capture.catch(() => undefined)
    let stopping: Promise<void> | undefined
    try {
      await entered.promise
      let finished = false
      stopping = (action === 'cancel' ? controller.cancel(identity, input.requestId) : controller.close()).then(() => {
        finished = true
      })
      void stopping.catch(() => undefined)
      await Promise.resolve()
      expect(finished).toBe(false)
      expect((await storage.knex('snapshot_archive_capacity').first()).archives).toBe(1)
      allowOpen.resolve()
      await destroying.promise
      expect(finished).toBe(false)
      expect((await storage.knex('snapshot_archive_capacity').first()).archives).toBe(1)
      await storage.knex('tx_labels').where({ txLabelId: 1 }).update({ label: 'foreground during cancellation' })
      allowDestroy.resolve()
      await stopping
      await expect(capture).rejects.toThrow('cancelled')
      expect(Reflect.get(storage, 'snapshotSyncSource')).toBeUndefined()
      expect((await new KnexSnapshotArchiveRequestStore(storage.knex).status(identity, input.requestId)).state).toBe(
        'closed'
      )
      expect(await storage.knex('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
      expect(await storage.knex('snapshot_archive_pages')).toHaveLength(0)
      if (action === 'cancel') {
        expect((await controller.create(identity, input)).state).toBe('closed')
        jest.restoreAllMocks()
        expect((await controller.create(identity, request('c'.repeat(64)))).state).toBe('ready')
      } else {
        expect(() => controller.create(identity, request('c'.repeat(64)))).toThrow('closed')
      }
    } finally {
      allowOpen.resolve()
      allowDestroy.resolve()
      await capture.catch(() => undefined)
      await stopping?.catch(() => undefined)
    }
  }
)

test('shutdown before the admission microtask prevents a claim and remains idempotent', async () => {
  const { storage, controller } = await fixture()
  const input = request()
  const capture = controller.create(identity, input)
  const closing = controller.close()
  expect(controller.close()).toBe(closing)
  await closing
  await expect(capture).rejects.toThrow('cancelled')
  expect(await storage.knex('snapshot_archive_requests')).toHaveLength(0)
  expect((await storage.knex('snapshot_archive_capacity').first()).archives).toBe(0)
  expect(() => controller.create(identity, input)).toThrow('closed')
  await expect(controller.status(identity, input.requestId)).rejects.toThrow('closed')
  await expect(controller.directory(identity, 'a'.repeat(64))).rejects.toThrow('closed')
  await expect(controller.read(identity, 'a'.repeat(64), 0)).rejects.toThrow('closed')
  await expect(controller.cancel(identity, input.requestId)).rejects.toThrow('closed')
})

test('idle shutdown preserves ready archives and closing never destroys the foreground provider', async () => {
  const { storage, controller } = await fixture()
  const input = request()
  const ready = await controller.create(identity, input)
  const closing = controller.close()
  expect(controller.close()).toBe(closing)
  await closing
  const replacement = service(storage)
  expect(await replacement.status(identity, input.requestId)).toEqual(ready)
  expect((await replacement.directory(identity, ready.archiveId!)).archiveId).toBe(ready.archiveId)
  expect(await storage.knex('users')).toHaveLength(2)
})

test('capture failure closes the reader, records a terminal failure and allows a different request', async () => {
  const { storage, controller } = await fixture()
  const input = request()
  const original = storage.openSnapshotArchiveSource.bind(storage)
  const opening = jest.spyOn(storage, 'openSnapshotArchiveSource').mockImplementationOnce(async (key, options) => {
    const source = (await original(key, options))!
    return {
      ...source,
      validateClosure: async () => {
        throw new Error('fixture closure failure')
      }
    }
  })
  await expect(controller.create(identity, input)).rejects.toThrow('fixture closure failure')
  expect(Reflect.get(storage, 'snapshotSyncSource')).toBeUndefined()
  expect((await controller.create(identity, input)).state).toBe('failed')
  expect(opening).toHaveBeenCalledTimes(1)
  expect((await storage.knex('snapshot_archive_capacity').first()).archives).toBe(0)
  expect((await controller.create(identity, request('c'.repeat(64)))).state).toBe('ready')
})

test('failed physical cleanup retains the reservation and fences the controller including later shutdown', async () => {
  const { storage, controller } = await fixture()
  const input = request()
  const original = storage.openSnapshotArchiveSource.bind(storage)
  const failure = new Error('physical close failed')
  let source: Awaited<ReturnType<typeof original>>
  jest.spyOn(storage, 'openSnapshotArchiveSource').mockImplementationOnce(async (key, options) => {
    source = (await original(key, options))!
    return {
      ...source,
      close: async () => {
        throw failure
      }
    }
  })
  await expect(controller.create(identity, input)).rejects.toBe(failure)
  expect((await storage.knex('snapshot_archive_capacity').first()).archives).toBe(1)
  expect((await storage.knex('snapshot_archives').first()).state).toBe('building')
  expect(() => controller.create(identity, request('c'.repeat(64)))).toThrow('closed')
  await expect(controller.close()).rejects.toBe(failure)
  await source!.close()
  await new KnexSnapshotArchiveRequestStore(storage.knex).close(identity, input.requestId, 'failed')
})

test('unsupported and busy sources fail without disturbing an existing local source', async () => {
  const { storage, controller } = await fixture()
  const local = (await storage.getSnapshotSync()!.openSource(identity))!
  const input = request()
  await expect(controller.create(identity, input)).rejects.toThrow('opening or active')
  expect(local.isOpen).toBe(true)
  expect((await controller.status(identity, input.requestId)).state).toBe('failed')
  expect((await storage.knex('snapshot_archive_capacity').first()).archives).toBe(0)
  await local.close()
  jest.spyOn(storage, 'openSnapshotArchiveSource').mockResolvedValueOnce(undefined)
  const unsupported = request('c'.repeat(64))
  await expect(controller.create(identity, unsupported)).rejects.toThrow('requires SQLite WAL or MySQL')
  expect((await controller.status(identity, unsupported.requestId)).state).toBe('failed')
  expect((await storage.knex('snapshot_archive_capacity').first()).archives).toBe(0)
})

test('an already claimed request is not resumed under a replacement source', async () => {
  const { storage, controller } = await fixture()
  const input = request()
  const claimed = await new KnexSnapshotArchiveRequestStore(storage.knex).claim(identity, input)
  const open = jest.spyOn(storage, 'openSnapshotArchiveSource')
  expect(await controller.create(identity, input)).toEqual(claimed.receipt)
  expect(open).not.toHaveBeenCalled()
  await controller.cancel(identity, input.requestId)
  expect((await controller.create(identity, input)).state).toBe('closed')
})

test('expiry between durable admission and source acquisition refuses without opening a pool', async () => {
  const { storage, controller } = await fixture()
  const input = request()
  const now = jest.spyOn(ArchiveSql, 'snapshotArchiveDatabaseNow')
  now
    .mockResolvedValueOnce(input.notAfter - 100)
    .mockResolvedValueOnce(input.notAfter - 100)
    .mockResolvedValueOnce(input.notAfter)
  const open = jest.spyOn(storage, 'openSnapshotArchiveSource')
  await expect(controller.create(identity, input)).rejects.toThrow('expired before capture')
  expect(open).not.toHaveBeenCalled()
  expect((await storage.knex('snapshot_archive_capacity').first()).archives).toBe(0)
})

test('invalid requests cannot occupy the local slot or shared quota', async () => {
  const { storage, controller } = await fixture()
  expect(() => controller.create(identity, { ...request(), writerToken: 'untrusted' })).toThrow('Invalid')
  await expect(controller.create('not-a-profile', request())).rejects.toThrow('identityKey')
  expect(await storage.knex('snapshot_archive_requests')).toHaveLength(0)
  expect((await controller.create(identity, request())).state).toBe('ready')
})

test('failed cleanup while opening retains admission even though no source was returned', async () => {
  const { storage, controller } = await fixture()
  const input = request()
  const failure = new Error('owned pool destruction failed')
  const destroy = StorageKnex.prototype.destroy
  jest.spyOn(StorageKnex.prototype, 'openReadSnapshot').mockRejectedValueOnce(new Error('reader initialization failed'))
  jest.spyOn(StorageKnex.prototype, 'destroy').mockImplementation(async function (this: StorageKnex) {
    if (this !== storage) throw failure
    await destroy.call(this)
  })
  let received: unknown
  try {
    await controller.create(identity, input)
  } catch (error) {
    received = error
  }
  expect(received).toMatchObject({ name: 'SnapshotArchiveSourceCleanupError', cause: failure })
  expect((received as Error).message).toBe('Snapshot archive source cleanup failed')
  expect((await storage.knex('snapshot_archive_capacity').first()).archives).toBe(1)
  expect(await storage.knex('snapshot_archives')).toHaveLength(0)
  expect((await storage.knex('snapshot_archive_requests').first()).state).toBe('claimed')
  expect(await storage.supportsSnapshotArchiveSource()).toBe(false)
  expect(() => controller.create(identity, request('c'.repeat(64)))).toThrow('closed')
  await expect(controller.close()).rejects.toBe(received)
  jest.restoreAllMocks()
  const reader = Reflect.get(storage, 'snapshotSyncSource') as StorageKnex
  await reader.destroy()
  await new KnexSnapshotArchiveRequestStore(storage.knex).close(identity, input.requestId, 'failed')
})
