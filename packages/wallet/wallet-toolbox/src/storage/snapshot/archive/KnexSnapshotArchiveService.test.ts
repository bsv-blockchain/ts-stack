import { SnapshotArchiveCleanupPendingError } from './SnapshotArchiveOwner'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { knex } from 'knex'
import { StorageKnex } from '../../StorageKnex'
import { StorageProvider } from '../../StorageProvider'
import { seedArchiveClosure } from '../../../../test/utils/snapshotArchiveFixtures'
import { KnexSnapshotArchiveService } from './KnexSnapshotArchiveService'
import { KnexSnapshotArchiveRequestStore } from './KnexSnapshotArchiveRequestStore'
import { KnexSnapshotArchiveStore } from './KnexSnapshotArchiveStore'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'
import { snapshotArchiveRequestId } from './SnapshotArchiveRequest'
import { verifySnapshotArchiveDirectory, verifySnapshotArchivePage } from './SnapshotArchiveDirectory'
import * as ArchiveSql from './SnapshotArchiveSql'
import * as ArchiveGuard from './SnapshotArchiveGuard'

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
async function closeRepairedSource(storage: StorageKnex, requestId: string): Promise<void> {
  const requests = new KnexSnapshotArchiveRequestStore(storage.knex)
  await expect(requests.close(identity, requestId, 'failed')).rejects.toBeInstanceOf(SnapshotArchiveCleanupPendingError)
  const owner = await storage.knex('snapshot_archive_owners').where({ identityKey: identity, requestId }).first()
  expect(owner).toBeDefined()
  await requests.sourceClosed({ identityKey: identity, requestId, claimToken: owner.claimToken })
  await requests.close(identity, requestId, 'failed')
  expect(await storage.knex('snapshot_archive_owners')).toHaveLength(0)
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
  const opening = jest.spyOn(storage, 'openSnapshotArchiveSource').mockImplementation(async (key, options, owner) => {
    expect(await storage.knex('snapshot_archive_capacity').first()).toMatchObject({ archives: 1, reservedBytes: 32768 })
    expect((await controller.status(identity, input.requestId)).state).toBe('building')
    expect(options?.signal).toBeInstanceOf(AbortSignal)
    expect(options?.lifetimeMs).toBeGreaterThan(0)
    expect(options?.lifetimeMs).toBeLessThanOrEqual(300000)
    return await original(key, options, owner)
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
    jest.spyOn(storage, 'openSnapshotArchiveSource').mockImplementation(async (key, options, owner) => {
      // Acquire the actual view, but withhold it from the controller until cancellation.
      const source = (await original(key, { ...options, signal: undefined }, owner))!
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
  const opening = jest
    .spyOn(storage, 'openSnapshotArchiveSource')
    .mockImplementationOnce(async (key, options, owner) => {
      const source = (await original(key, options, owner))!
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
  jest.spyOn(storage, 'openSnapshotArchiveSource').mockImplementationOnce(async (key, options, owner) => {
    source = (await original(key, options, owner))!
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
  await closeRepairedSource(storage, input.requestId)
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
  const claim = KnexSnapshotArchiveRequestStore.prototype.claim
  jest.spyOn(KnexSnapshotArchiveRequestStore.prototype, 'claim').mockImplementationOnce(async function (
    this: KnexSnapshotArchiveRequestStore,
    key,
    value
  ) {
    const admitted = await claim.call(this, key, value)
    jest.spyOn(ArchiveSql, 'snapshotArchiveDatabaseNow').mockResolvedValue(input.notAfter)
    return admitted
  })
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
  jest
    .spyOn(ArchiveGuard, 'readGuardedSnapshotArchive')
    .mockRejectedValueOnce(new Error('reader initialization failed'))
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
  await closeRepairedSource(storage, input.requestId)
})

test('start returns a durable receipt before capture completes and repeats only that admission', async () => {
  const { storage, controller, open } = await fixture()
  const input = request()
  const entered = gate()
  const finish = gate()
  const original = storage.openSnapshotArchiveSource.bind(storage)
  jest.spyOn(storage, 'openSnapshotArchiveSource').mockImplementationOnce(async (key, options, owner) => {
    entered.resolve()
    await finish.promise
    return await original(key, options, owner)
  })
  const accepted = controller.start(identity, input)
  expect(controller.start(identity, { ...input })).toBe(accepted)
  const completion = controller.create(identity, input)
  void completion.catch(() => undefined)
  try {
    const receipt = await accepted
    expect(receipt).toEqual({ version: 1, state: 'building', requestId: input.requestId, expiresAt: input.notAfter })
    expect(Object.isFrozen(receipt)).toBe(true)
    await entered.promise
    const replacementStorage = open()
    await replacementStorage.makeAvailable()
    const replacement = service(replacementStorage)
    expect(await replacement.start(identity, input)).toEqual(receipt)
    expect(Reflect.get(replacementStorage, 'snapshotSyncSource')).toBeUndefined()
    finish.resolve()
    const ready = await completion
    expect(ready.state).toBe('ready')
    expect(await replacement.start(identity, input)).toEqual(ready)
    expect((await storage.knex('snapshot_archive_capacity').first()).archives).toBe(1)
    await replacement.cancel(identity, input.requestId)
  } finally {
    finish.resolve()
    await completion.catch(() => undefined)
  }
})

test('resource exhaustion has a durable distinct terminal status and never replaces its archive on retry', async () => {
  const { storage, controller, open } = await fixture()
  const fields = { ...request(), maxBytes: 4097 }
  const input = { ...fields, requestId: snapshotArchiveRequestId(fields) }
  await expect(controller.create(identity, input)).rejects.toBeInstanceOf(SnapshotResourceLimitError)
  expect(await controller.status(identity, input.requestId)).toEqual({
    version: 1,
    requestId: input.requestId,
    expiresAt: input.notAfter,
    state: 'resource-limited'
  })
  const replacementStorage = open()
  await replacementStorage.makeAvailable()
  const replacement = service(replacementStorage)
  const reader = jest.spyOn(replacementStorage, 'openSnapshotArchiveSource')
  expect((await replacement.start(identity, input)).state).toBe('resource-limited')
  expect(reader).not.toHaveBeenCalled()
  expect(await storage.knex('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
  await replacement.cancel(identity, input.requestId)
  expect((await replacement.status(identity, input.requestId)).state).toBe('resource-limited')
  expect((await replacement.create(identity, request('c'.repeat(64)))).state).toBe('ready')
})

test.each(['pending', 'capturing', 'ready', 'legacy'] as const)(
  'new admission reaps an abandoned expired %s capture',
  async state => {
    const { storage, controller } = await fixture()
    const input = request()
    const requests = new KnexSnapshotArchiveRequestStore(storage.knex)
    const archives = new KnexSnapshotArchiveStore(storage.knex)
    if (state === 'ready') await controller.create(identity, input)
    else {
      const admitted = state === 'legacy' ? undefined : await requests.claim(identity, input)
      if (state === 'capturing' || state === 'legacy') {
        const source = (await storage.openSnapshotArchiveSource(identity))!
        const binding = {
          version: 1 as const,
          snapshotId: source.snapshotId,
          sourceSchema: source.sourceSchema,
          sourceStorage: source.sourceStorage,
          user: source.user
        }
        await source.close()
        const writer =
          state === 'legacy'
            ? await archives.begin(binding, { maxBytes: 32768, lifetimeMs: 200000 })
            : await requests.begin(admitted!.owner!, binding)
        await archives.append(writer, { sequence: 0, table: 'provenTxs', rows: 0, done: true, bytes: Uint8Array.of(0) })
      }
    }
    const now = input.notAfter + 60000
    jest.spyOn(ArchiveSql, 'snapshotArchiveDatabaseNow').mockResolvedValue(now)
    const fields = { ...input, nonce: 'c'.repeat(64), notAfter: now + 300000 }
    const next = { ...fields, requestId: snapshotArchiveRequestId(fields) }
    const ready = await controller.create(identity, next)
    expect(ready.state).toBe('ready')
    expect(await storage.knex('snapshot_archive_requests')).toHaveLength(1)
    expect(await storage.knex('snapshot_archives')).toHaveLength(1)
    expect((await storage.knex('snapshot_archives').first()).archiveId).toBe(ready.archiveId)
    expect(await storage.knex('snapshot_archive_capacity').first()).toMatchObject({
      archives: 1,
      reservedBytes: next.maxBytes
    })
    await controller.cancel(identity, next.requestId)
    expect(await storage.knex('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
  }
)

test('a second controller fences a first start delayed before its durable claim', async () => {
  const { storage, controller, open } = await fixture()
  const replacementStorage = open()
  await replacementStorage.makeAvailable()
  const replacement = service(replacementStorage)
  const input = request()
  const entered = gate()
  const resume = gate()
  const original = KnexSnapshotArchiveRequestStore.prototype.claim
  jest.spyOn(KnexSnapshotArchiveRequestStore.prototype, 'claim').mockImplementation(async function (
    this: KnexSnapshotArchiveRequestStore,
    key,
    value
  ) {
    entered.resolve()
    await resume.promise
    return await original.call(this, key, value)
  })
  const opening = jest.spyOn(storage, 'openSnapshotArchiveSource')
  const pending = controller.create(identity, input)
  void pending.catch(() => undefined)
  try {
    await entered.promise
    // Client-side abort alone cannot drain this delayed server operation.
    await replacement.cancelRequest(identity, input)
    await replacement.cancelRequest(identity, input)
    expect(await storage.knex('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
    resume.resolve()
    expect((await pending).state).toBe('closed')
    expect(opening).not.toHaveBeenCalled()
    expect(await storage.knex('snapshot_archive_pages')).toHaveLength(0)
    expect((await replacement.create(identity, input)).state).toBe('closed')
  } finally {
    resume.resolve()
    await pending.catch(() => undefined)
  }
})

test('reader offers acquire no source and a replacement recovers only the admitted immutable archive', async () => {
  const { storage, controller, open } = await fixture()
  const opening = jest.spyOn(storage, 'openSnapshotArchiveSource')
  const offered = (await controller.offerReader(identity, { lifetimeMs: 300000, maxBytes: 32768 }))!
  expect(offered.request.version).toBe(2)
  expect(opening).not.toHaveBeenCalled()
  expect(await storage.knex('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
  await expect(controller.admitReader(other, offered.request)).rejects.toThrow('unavailable')
  const admitted = await controller.admitReader(identity, offered.request)
  expect(admitted).toMatchObject({ outcome: 'accepted', receipt: { state: 'building' } })
  let receipt = await controller.status(identity, offered.request.requestId)
  for (let attempt = 0; receipt.state === 'building' && attempt < 100; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10))
    receipt = await controller.status(identity, offered.request.requestId)
  }
  expect(receipt.state).toBe('ready')
  expect(opening).toHaveBeenCalledTimes(1)
  expect(Reflect.get(storage, 'snapshotSyncSource')).toBeUndefined()
  const directory = await controller.directory(identity, receipt.archiveId!)
  await controller.close()
  const replacementStorage = open()
  await replacementStorage.makeAvailable()
  const replacement = service(replacementStorage)
  const replacementOpening = jest.spyOn(replacementStorage, 'openSnapshotArchiveSource')
  expect(await replacement.admitReader(identity, offered.request)).toEqual({
    version: 1,
    outcome: 'accepted',
    receipt
  })
  expect(await replacement.directory(identity, receipt.archiveId!)).toEqual(directory)
  expect(replacementOpening).not.toHaveBeenCalled()
  await replacement.cancelReader(identity, offered.request)
  await replacement.cancelReader(identity, offered.request)
  expect(await storage.knex('snapshot_archive_requests')).toHaveLength(0)
  expect(await storage.knex('snapshot_archive_pages')).toHaveLength(0)
  expect(await storage.knex('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
  await expect(replacement.admitReader(identity, offered.request)).rejects.toThrow('unavailable')
  expect(replacementOpening).not.toHaveBeenCalled()
})

test('reader cancellation on a replacement removes an offer before a delayed admission can capture', async () => {
  const { storage, controller, open } = await fixture()
  const offered = (await controller.offerReader(identity, { lifetimeMs: 300000, maxBytes: 32768 }))!
  const replacementStorage = open()
  await replacementStorage.makeAvailable()
  const replacement = service(replacementStorage)
  const entered = gate()
  const resume = gate()
  const original = KnexSnapshotArchiveRequestStore.prototype.claimReader
  jest.spyOn(KnexSnapshotArchiveRequestStore.prototype, 'claimReader').mockImplementation(async function (
    this: KnexSnapshotArchiveRequestStore,
    key,
    value
  ) {
    entered.resolve()
    await resume.promise
    return await original.call(this, key, value)
  })
  const opening = jest.spyOn(storage, 'openSnapshotArchiveSource')
  const pending = controller.admitReader(identity, offered.request)
  void pending.catch(() => undefined)
  try {
    await entered.promise
    await replacement.cancelReader(identity, offered.request)
    await replacement.cancelReader(identity, offered.request)
    expect(await storage.knex('snapshot_archive_requests')).toHaveLength(0)
    resume.resolve()
    await expect(pending).rejects.toThrow('unavailable')
    expect(opening).not.toHaveBeenCalled()
    expect(await storage.knex('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
    expect(await storage.knex('snapshot_archive_pages')).toHaveLength(0)
    await expect(replacement.admitReader(identity, offered.request)).rejects.toThrow('unavailable')
    expect(opening).not.toHaveBeenCalled()
  } finally {
    resume.resolve()
    await pending.catch(() => undefined)
  }
})

test.each(['failed', 'resource-limited'] as const)(
  'reader %s capture remains observable until explicit cancellation collects its receipt',
  async state => {
    const { storage, controller, open } = await fixture()
    const offered = (await controller.offerReader(identity, { lifetimeMs: 300000, maxBytes: 32768 }))!
    const failure = state === 'failed' ? new Error('synthetic capture failure') : new SnapshotResourceLimitError('full')
    const opening = jest.spyOn(storage, 'openSnapshotArchiveSource').mockRejectedValueOnce(failure)
    expect(await controller.admitReader(identity, offered.request)).toMatchObject({ outcome: 'accepted' })
    let receipt = await controller.status(identity, offered.request.requestId)
    for (let attempt = 0; receipt.state === 'building' && attempt < 100; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      receipt = await controller.status(identity, offered.request.requestId)
    }
    expect(receipt.state).toBe(state)
    await controller.close()
    const replacementStorage = open()
    await replacementStorage.makeAvailable()
    const replacement = service(replacementStorage)
    expect(await replacement.admitReader(identity, offered.request)).toEqual({
      version: 1,
      outcome: 'accepted',
      receipt
    })
    expect(opening).toHaveBeenCalledTimes(1)
    expect(await storage.knex('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
    await replacement.cancelReader(identity, offered.request)
    expect(await storage.knex('snapshot_archive_requests')).toHaveLength(0)
    await expect(replacement.admitReader(identity, offered.request)).rejects.toThrow('unavailable')
  }
)

test('cancellation through another controller retains quota until the capturing owner drains its physical pool', async () => {
  const { storage, controller, open } = await fixture()
  const replacementStorage = open()
  await replacementStorage.makeAvailable()
  const replacement = service(replacementStorage)
  const input = request()
  const reading = gate()
  const allowRead = gate()
  const destroying = gate()
  const allowDestroy = gate()
  const original = storage.openSnapshotArchiveSource.bind(storage)
  jest.spyOn(storage, 'openSnapshotArchiveSource').mockImplementationOnce(async (key, options, owner) => {
    const source = (await original(key, options, owner))!
    const reader = Reflect.get(storage, 'snapshotSyncSource') as StorageKnex
    const destroy = reader.knex.client.destroyRawConnection.bind(reader.knex.client)
    jest.spyOn(reader.knex.client, 'destroyRawConnection').mockImplementation(async connection => {
      destroying.resolve()
      await allowDestroy.promise
      await destroy(connection)
    })
    return {
      ...source,
      readPage: async (...args) => {
        reading.resolve()
        await allowRead.promise
        return await source.readPage(...args)
      }
    }
  })
  const capture = controller.create(identity, input)
  void capture.catch(() => undefined)
  try {
    await reading.promise
    await expect(replacement.cancelRequest(identity, input)).rejects.toBeInstanceOf(SnapshotArchiveCleanupPendingError)
    expect((await replacement.status(identity, input.requestId)).state).toBe('closed')
    expect(await storage.knex('snapshot_archive_owners')).toHaveLength(1)
    expect((await storage.knex('snapshot_archive_capacity').first()).archives).toBe(1)
    allowRead.resolve()
    await destroying.promise
    await expect(replacement.cancelRequest(identity, input)).rejects.toBeInstanceOf(SnapshotArchiveCleanupPendingError)
    expect(await storage.knex('snapshot_archive_pages')).toHaveLength(0)
    await storage.knex('tx_labels').where({ txLabelId: 1 }).update({ label: 'foreground while owner drains' })
    expect((await storage.knex('snapshot_archive_capacity').first()).archives).toBe(1)
    allowDestroy.resolve()
    await expect(capture).rejects.toThrow('unavailable')
    await replacement.cancelRequest(identity, input)
    expect(await storage.knex('snapshot_archive_owners')).toHaveLength(0)
    expect(await storage.knex('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
  } finally {
    allowRead.resolve()
    allowDestroy.resolve()
    await capture.catch(() => undefined)
  }
})
