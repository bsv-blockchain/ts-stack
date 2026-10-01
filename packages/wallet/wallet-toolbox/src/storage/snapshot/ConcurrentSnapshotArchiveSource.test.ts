import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { knex } from 'knex'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
import { seedArchiveClosure } from '../../../test/utils/snapshotArchiveFixtures'
import { KnexSnapshotArchiveStore } from './archive/KnexSnapshotArchiveStore'
import { KnexSnapshotArchiveRequestStore } from './archive/KnexSnapshotArchiveRequestStore'
import { snapshotArchiveRequestId } from './archive/SnapshotArchiveRequest'
import { captureSnapshotArchiveSource } from './archive/captureSnapshotArchiveSource'
import { verifySnapshotArchiveDirectory } from './archive/SnapshotArchiveDirectory'

const identity = '02' + '11'.repeat(32)
const stores: StorageKnex[] = []
const directories: string[] = []
function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'owned-archive-source-'))
  directories.push(directory)
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
  await storage.knex.raw('PRAGMA journal_mode = WAL')
  await storage.migrate('original source', 'original-source')
  await storage.makeAvailable()
  const { user } = await storage.findOrInsertUser(identity)
  const { user: other } = await storage.findOrInsertUser('03' + '22'.repeat(32))
  await seedArchiveClosure(storage, user.userId, other.userId)
  return storage
}
afterEach(async () => {
  jest.restoreAllMocks()
  await Promise.all(stores.splice(0).map(store => store.destroy()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

test('a ready request waits for owned reader destruction while foreground storage remains usable', async () => {
  const storage = await fixture()
  expect(await storage.supportsSnapshotArchiveSource()).toBe(true)
  expect(Reflect.get(storage, 'snapshotSyncSource')).toBeUndefined()
  const requests = new KnexSnapshotArchiveRequestStore(storage.knex)
  const archives = new KnexSnapshotArchiveStore(storage.knex)
  const fields = { version: 1 as const, nonce: 'b'.repeat(64), notAfter: Date.now() + 300000, maxBytes: 32768 }
  const input = { ...fields, requestId: snapshotArchiveRequestId(fields) }
  const admitted = await requests.claim(identity, input)
  const source = (await storage.openSnapshotArchiveSource(identity))!
  expect(source.user.identityKey).toBe(identity)
  expect(source.sourceStorage.storageIdentityKey).toBe('original-source')
  expect(source.sourceSchema).toBe('2026-10-01-001 add snapshot archive source owners')
  const reader = Reflect.get(storage, 'snapshotSyncSource') as StorageKnex
  expect(reader.knex).not.toBe(storage.knex)
  expect(reader.knex.client.config.pool).toMatchObject({ min: 0, max: 1 })
  const entered = gate()
  const finish = gate()
  const destroy = reader.destroy.bind(reader)
  const intercept = jest.spyOn(reader, 'destroy').mockImplementation(async () => {
    entered.resolve()
    await finish.promise
    await destroy()
  })
  let settled = false
  const pending = captureSnapshotArchiveSource(
    source,
    {
      begin: binding => requests.begin(admitted.owner!, binding),
      append: (writer, page) => archives.append(writer, page),
      seal: writer => requests.seal(admitted.owner!, writer),
      close: () => requests.close(identity, input.requestId, 'failed')
    },
    identity,
    'test'
  ).finally(() => {
    settled = true
  })
  void pending.catch(() => undefined)
  try {
    await Promise.race([
      entered.promise,
      pending.then(() => {
        throw new Error('Capture completed before physical close')
      })
    ])
    expect(settled).toBe(false)
    expect((await requests.status(identity, input.requestId)).state).toBe('building')
    expect((await storage.knex('snapshot_archives').first()).state).toBe('building')
    await expect(storage.getSnapshotSync()!.openSource(identity)).rejects.toThrow('opening or active')
    await storage.knex('tx_labels').where({ txLabelId: 1 }).update({ label: 'foreground write after capture' })
    finish.resolve()
    const manifest = await pending
    expect(Reflect.get(storage, 'snapshotSyncSource')).toBeUndefined()
    expect((await requests.status(identity, input.requestId)).state).toBe('ready')
    const verified = verifySnapshotArchiveDirectory(await archives.directory(identity, manifest.archiveId), {
      identityKey: identity,
      chain: 'test',
      sourceStorageIdentityKey: 'original-source',
      digest: manifest.digest
    })
    expect(verified.manifest).toEqual(manifest)
    const next = (await storage.getSnapshotSync()!.openSource(identity))!
    await next.close()
    await requests.close(identity, input.requestId)
    expect((await storage.knex('snapshot_archive_capacity').first()).archives).toBe(0)
  } finally {
    finish.resolve()
    await pending.catch(() => undefined)
    intercept.mockRestore()
  }
})

test('provider destruction closes its archive reader and fences further admission', async () => {
  const storage = await fixture()
  const source = (await storage.openSnapshotArchiveSource(identity))!
  await storage.destroy()
  await source.closed
  expect(source.isOpen).toBe(false)
  expect(await storage.supportsSnapshotArchiveSource()).toBe(false)
  await expect(storage.openSnapshotArchiveSource(identity)).rejects.toThrow('destruction begins')
})

test('cancellation after source acquisition closes the owned pool before any archive is reserved', async () => {
  const storage = await fixture()
  const source = (await storage.openSnapshotArchiveSource(identity))!
  const controller = new AbortController()
  controller.abort()
  await expect(
    captureSnapshotArchiveSource(source, new KnexSnapshotArchiveStore(storage.knex), identity, 'test', {
      signal: controller.signal
    })
  ).rejects.toThrow('cancelled')
  expect(Reflect.get(storage, 'snapshotSyncSource')).toBeUndefined()
  expect(await storage.knex('snapshot_archives')).toHaveLength(0)
})

test('unsupported in-memory SQLite does not construct a dedicated archive reader', async () => {
  const storage = new StorageKnex({
    ...StorageProvider.createStorageBaseOptions('test'),
    knex: knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  })
  stores.push(storage)
  expect(await storage.supportsSnapshotArchiveSource()).toBe(false)
  expect(await storage.openSnapshotArchiveSource(identity)).toBeUndefined()
  expect(Reflect.get(storage, 'snapshotSyncSource')).toBeUndefined()
})
