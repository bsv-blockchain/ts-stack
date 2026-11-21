import { runSnapshotSyncSession } from './runSnapshotSyncSession'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { knex } from 'knex'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
import { SNAPSHOT_SYNC_CONTENT_RECEIPTS } from '../schema/snapshotSyncReceiptMigration'
import { KnexSnapshotSyncDestination } from './KnexSnapshotSyncDestination'
import { KnexSnapshotSyncContentReceipts, type SnapshotContentSession } from './KnexSnapshotSyncContentReceipts'
import { snapshotSyncTables, type SnapshotSyncCheckpoint } from './SnapshotSync'
import { snapshotSyncContentPosition, snapshotSyncContentSourceKey } from './SnapshotSyncContentRevision'
import type { SnapshotJournalSource } from './journal/SnapshotJournalCapture'
import * as Current from './journal/SnapshotJournalCurrentContentRevision'
import { runInSeries } from '../../utility/runInSeries'

const identity = '02' + '11'.repeat(32)
const stores: StorageKnex[] = [],
  directories: string[] = [],
  views: SnapshotJournalSource[] = []
async function fixture(name: string) {
  const directory = await mkdtemp(join(tmpdir(), 'snapshot-content-receipts-'))
  directories.push(directory)
  const storage = new StorageKnex({
    ...StorageProvider.createStorageBaseOptions('test'),
    knex: knex({
      client: 'better-sqlite3',
      connection: { filename: join(directory, 'wallet.sqlite') },
      useNullAsDefault: true,
      pool: { min: 0, max: 1 }
    })
  })
  stores.push(storage)
  await storage.knex.raw('PRAGMA journal_mode=WAL')
  await storage.migrate(name, name)
  await storage.makeAvailable()
  const { user } = await storage.findOrInsertUser(identity)
  await storage.updateUser(user.userId, { activeStorage: 'source' })
  return storage
}
async function open(storage: StorageKnex) {
  const view = await storage.openCurrentSnapshotJournalSource(identity)
  views.push(view)
  if (view.readContentRevision === undefined) throw new Error('Actual source revision required')
  return { view, revision: await view.readContentRevision() }
}
async function setup() {
  const source = await fixture('source'),
    destination = await fixture('destination')
  const { view, revision } = await open(source)
  const writer = new KnexSnapshotSyncDestination(destination, async () => new Map())
  const checkpoint = await writer.begin(view, view.user.activeStorage, {
    maximumSourceScopes: 8,
    contentRevision: revision
  })
  return {
    source,
    destination,
    view,
    revision,
    writer,
    checkpoint,
    receipts: new KnexSnapshotSyncContentReceipts(destination)
  }
}
async function advance(f: Awaited<ReturnType<typeof setup>>, target: number = snapshotSyncTables.length) {
  let checkpoint = f.checkpoint
  while (checkpoint.tableIndex < target) {
    const page = await f.view.readPage(snapshotSyncTables[checkpoint.tableIndex], checkpoint.cursor)
    checkpoint = (await (await f.writer.prepare(checkpoint, page))()).checkpoint
  }
  f.checkpoint = checkpoint
  return checkpoint
}
async function session(storage: StorageKnex, checkpoint: SnapshotSyncCheckpoint): Promise<SnapshotContentSession> {
  return await storage.knex('snapshot_sync_sessions').where('sessionId', checkpoint.sessionId).first()
}
afterEach(async () => {
  jest.restoreAllMocks()
  await runInSeries(views.splice(0), async view => {
    await view.close()
    await view.closed
  })
  await runInSeries(stores.splice(0), storage => storage.destroy())
  await runInSeries(directories.splice(0), directory => rm(directory, { recursive: true, force: true }))
})

test('actual final row writer commits completion DATA with its checkpoint; capture-only clocks confirm a durable copy', async () => {
  const f = await setup()
  expect(await f.destination.knex(SNAPSHOT_SYNC_CONTENT_RECEIPTS).first()).toMatchObject({
    complete: 0,
    destinationContent: null
  })
  await advance(f)
  const completed = await session(f.destination, f.checkpoint)
  expect(f.checkpoint.done).toBe(true)
  const receipt = await f.destination.knex(SNAPSHOT_SYNC_CONTENT_RECEIPTS).first()
  expect(receipt).toMatchObject({ complete: 1, sourceContent: f.revision.content, sessionId: f.checkpoint.sessionId })
  expect(receipt.destinationContent).toMatch(/^[a-f0-9]{64}$/)
  await f.view.close()
  await f.view.closed
  const next = await open(f.source)
  const observed = await next.view.readContentRevision!(snapshotSyncContentPosition(f.revision))
  expect(BigInt(observed.highWater)).toBeGreaterThan(BigInt(f.revision.highWater))
  expect(observed.unchangedSince).toBe(f.revision.highWater)
  await f.destination.knex.transaction(async trx => {
    await trx('users').where('userId', completed.userId).update({ userId: completed.userId })
    expect(await f.receipts.confirm(trx, completed, observed)).toBe(true)
  })
  expect((await f.destination.knex(SNAPSHOT_SYNC_CONTENT_RECEIPTS).first()).sourceHighWater).toBe(observed.highWater)
  expect(await f.writer.checkpoint(identity, 'source')).toEqual(f.checkpoint)
})

test('post-data completion failure rolls back the original final checkpoint and leaves pending DATA', async () => {
  const f = await setup()
  await advance(f, snapshotSyncTables.length - 1)
  const old = { ...f.checkpoint },
    page = await f.view.readPage('provenTxReqs', old.cursor)
  jest.spyOn(Current, 'readCurrentSnapshotJournalContentRevision').mockRejectedValueOnce(new Error('after data fault'))
  await expect((await f.writer.prepare(old, page))()).rejects.toThrow('after data fault')
  expect(await f.writer.checkpoint(identity, 'source')).toEqual(old)
  expect(await f.destination.knex(SNAPSHOT_SYNC_CONTENT_RECEIPTS).first()).toMatchObject({
    complete: 0,
    destinationContent: null
  })
  await advance(f)
  expect(f.checkpoint.done).toBe(true)
  expect((await f.destination.knex(SNAPSHOT_SYNC_CONTENT_RECEIPTS).first()).complete).toBe(1)
})

test('destination data or primary drift refuses reuse without altering the previous completed receipt', async () => {
  const f = await setup()
  await advance(f)
  const completed = await session(f.destination, f.checkpoint),
    original = await f.destination.knex(SNAPSHOT_SYNC_CONTENT_RECEIPTS).first()
  await f.destination.findOrInsertTxLabel(completed.userId, 'new destination data')
  await f.destination.knex.transaction(async trx => {
    await trx('users').where('userId', completed.userId).update({ userId: completed.userId })
    expect(await f.receipts.confirm(trx, completed, f.revision)).toBe(false)
  })
  expect(await f.destination.knex(SNAPSHOT_SYNC_CONTENT_RECEIPTS).first()).toEqual(original)
  await f.destination.updateUser(completed.userId, { activeStorage: 'destination' })
  await expect(
    f.destination.knex.transaction(async trx => await f.receipts.confirm(trx, completed, f.revision))
  ).rejects.toThrow()
  expect(await f.destination.knex(SNAPSHOT_SYNC_CONTENT_RECEIPTS).first()).toEqual(original)
})

test('a completed legacy copy cannot acquire a retroactive completed-content stamp', async () => {
  const f = await setup()
  await f.destination.knex(SNAPSHOT_SYNC_CONTENT_RECEIPTS).delete()
  await advance(f)
  await expect(
    f.writer.begin(f.view, f.view.user.activeStorage, { maximumSourceScopes: 8, contentRevision: f.revision })
  ).rejects.toThrow()
  expect(await f.destination.knex(SNAPSHOT_SYNC_CONTENT_RECEIPTS)).toHaveLength(0)
})

test('one-use completion refuses an ended transaction and cannot restamp another writer', async () => {
  const f = await setup()
  await advance(f, snapshotSyncTables.length - 1)
  const old = await session(f.destination, f.checkpoint)
  let complete: ((row: SnapshotContentSession) => Promise<void>) | undefined
  await f.destination.knex.transaction(async trx => {
    complete = await f.receipts.prepareCompletion(trx, old)
  })
  expect(complete).toBeDefined()
  await expect(
    complete!({ ...old, tableIndex: snapshotSyncTables.length, sequence: old.sequence + 1 })
  ).rejects.toThrow()
  expect((await f.destination.knex(SNAPSHOT_SYNC_CONTENT_RECEIPTS).first()).complete).toBe(0)
})

test('source lookup preserves exact case and trailing spaces and refuses malformed UTF16', () => {
  expect(new Set(['source', 'Source', 'source '].map(snapshotSyncContentSourceKey)).size).toBe(3)
  expect(() => snapshotSyncContentSourceKey('\ud800')).toThrow()
})

test('the coordinator binds the actual copied view while a completed observation drains before reuse', async () => {
  const source = await fixture('source'),
    destination = await fixture('destination')
  const { view, revision } = await open(source)
  const capability = destination.getSnapshotSync()!
  const result = await runSnapshotSyncSession(
    {
      view,
      destination: capability,
      activeStorage: 'source',
      commit: async operation => await operation()
    },
    {}
  )
  expect(result.status).toBe('completed')
  expect(result.snapshotCheckpoint?.done).toBe(true)
  const previous = await capability.previousContentReceipt!(identity, 'source')
  expect(previous?.source).toEqual(revision)
  await view.close()
  await view.closed
  const observed = await source.getSnapshotSync()!.observeContentRevision!(
    identity,
    snapshotSyncContentPosition(revision)
  )
  expect(observed?.unchangedSince).toBe(revision.highWater)
  expect(await capability.confirmContentReceipt!(identity, 'source', observed!)).toEqual(result.snapshotCheckpoint)
  // The DATA result did not retain the physical source. A new actual owner can open.
  const reopened = await open(source)
  expect(reopened.view.isOpen).toBe(true)
  await reopened.view.close()
  await reopened.view.closed
  const user = (await source.findUserByIdentityKey(identity))!
  await source.findOrInsertTxLabel(user.userId, 'changed after completed copy')
  const changed = await source.getSnapshotSync()!.observeContentRevision!(
    identity,
    snapshotSyncContentPosition(observed!)
  )
  expect(changed?.content).not.toBe(observed?.content)
  expect(changed?.unchangedSince).toBeUndefined()
  expect(await capability.confirmContentReceipt!(identity, 'source', changed!)).toBeUndefined()
})

test('a foreground source mutation cannot stamp its newer state onto the older copied view', async () => {
  const source = await fixture('source'),
    destination = await fixture('destination')
  const { view, revision } = await open(source)
  await source.findOrInsertTxLabel(view.user.userId, 'outside retained view')
  view.sourceStorage.storageIdentityKey = 'edited public DATA'
  view.user.updated_at.setUTCFullYear(2040)
  expect(view.sourceStorage.storageIdentityKey).toBe('source')
  expect(view.user.updated_at.getUTCFullYear()).not.toBe(2040)
  const result = await runSnapshotSyncSession(
    {
      view,
      destination: destination.getSnapshotSync()!,
      activeStorage: 'source',
      commit: async operation => await operation()
    },
    {}
  )
  const previous = await destination.getSnapshotSync()!.previousContentReceipt!(identity, 'source')
  expect(previous?.checkpoint).toEqual(result.snapshotCheckpoint)
  expect(previous?.source).toEqual(revision)
  expect(await destination.findTxLabels({ partial: { userId: 1, label: 'outside retained view' } })).toHaveLength(0)
  await view.close()
  await view.closed
  const observed = await source.observeSnapshotSyncContentRevision(identity, snapshotSyncContentPosition(revision))
  expect(observed?.content).not.toBe(revision.content)
  expect(await destination.getSnapshotSync()!.confirmContentReceipt!(identity, 'source', observed!)).toBeUndefined()
})

test('a selected-primary change invalidates public comparison DATA and permits a fresh normal copy', async () => {
  const f = await setup()
  await advance(f)
  const user = (await f.destination.findUserByIdentityKey(identity))!
  await f.destination.updateUser(user.userId, { activeStorage: 'destination' })
  expect(await f.writer.previousContentReceipt(identity, 'source')).toBeUndefined()
  expect(await f.writer.confirmContentReceipt(identity, 'source', f.revision)).toBeUndefined()
  await f.view.close()
  await f.view.closed
  const next = await open(f.source)
  const checkpoint = await f.writer.beginContent(next.view, next.view.user.activeStorage, next.revision)
  expect(checkpoint.done).toBe(false)
  expect(checkpoint.sessionId).not.toBe(f.checkpoint.sessionId)
})

test('hashed auxiliary source scopes retain their own quota even after an older session row is removed', async () => {
  const f = await setup(),
    other = await fixture('second-source'),
    captured = await open(other)
  const original = await f.destination.knex(SNAPSHOT_SYNC_CONTENT_RECEIPTS).first()
  await f.destination.knex('snapshot_sync_sessions').where('sessionId', f.checkpoint.sessionId).delete()
  await expect(
    f.writer.beginContent(captured.view, captured.view.user.activeStorage, captured.revision, {
      maximumSourceScopes: 1
    })
  ).rejects.toThrow('content receipt source-scope quota')
  expect(await f.destination.knex('snapshot_sync_sessions')).toHaveLength(0)
  expect(await f.destination.knex(SNAPSHOT_SYNC_CONTENT_RECEIPTS)).toEqual([original])
})
