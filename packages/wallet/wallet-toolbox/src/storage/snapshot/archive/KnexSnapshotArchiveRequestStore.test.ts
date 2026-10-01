import { snapshotArchiveReaderRequestId } from './SnapshotArchiveReaderRequest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { knex, type Knex } from 'knex'
import { addSnapshotArchiveTables } from '../../schema/snapshotArchiveMigration'
import {
  addSnapshotArchiveRequestTable,
  removeSnapshotArchiveRequestTable
} from '../../schema/snapshotArchiveRequestMigration'
import { KnexSnapshotArchiveStore } from './KnexSnapshotArchiveStore'
import { KnexSnapshotArchiveRequestStore } from './KnexSnapshotArchiveRequestStore'
import { snapshotArchiveRequestId } from './SnapshotArchiveRequest'
import * as ArchiveSql from './SnapshotArchiveSql'
import { snapshotArchiveTables, type SnapshotArchiveBinding, type SnapshotArchiveWriter } from './SnapshotArchive'

const identity = '02' + '11'.repeat(32)
const other = '03' + '22'.repeat(32)
const date = new Date('2026-01-01T00:00:00.000Z')
const binding: SnapshotArchiveBinding = {
  version: 1,
  snapshotId: 'a'.repeat(64),
  sourceSchema: 'request-fixture-v1',
  sourceStorage: {
    created_at: date,
    updated_at: date,
    storageIdentityKey: 'source',
    storageName: 'source',
    chain: 'test',
    dbtype: 'SQLite',
    maxOutputScript: 1024
  },
  user: { created_at: date, updated_at: date, userId: 1, identityKey: identity, activeStorage: 'source' }
}
const databases: Knex[] = []
const directories: string[] = []

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'snapshot-request-'))
  directories.push(directory)
  const open = () => {
    const db = knex({
      client: 'better-sqlite3',
      connection: { filename: join(directory, 'requests.sqlite') },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 },
      acquireConnectionTimeout: 5000
    })
    databases.push(db)
    return db
  }
  const db = open()
  await db.raw('PRAGMA journal_mode = WAL')
  await addSnapshotArchiveTables(db)
  await addSnapshotArchiveRequestTable(db)
  const peer = open()
  return {
    db,
    peer,
    requests: new KnexSnapshotArchiveRequestStore(db),
    second: new KnexSnapshotArchiveRequestStore(peer),
    archives: new KnexSnapshotArchiveStore(db)
  }
}

function request(nonce = 'b'.repeat(64), maxBytes = 32768) {
  const value = { version: 1 as const, nonce, notAfter: Date.now() + 300000, maxBytes }
  return { ...value, requestId: snapshotArchiveRequestId(value) }
}

async function append(archives: KnexSnapshotArchiveStore, writer: SnapshotArchiveWriter) {
  for (const [sequence, table] of snapshotArchiveTables.entries()) {
    await archives.append(writer, { sequence, table, rows: 0, done: true, bytes: Uint8Array.of(0) })
  }
}

afterEach(async () => {
  jest.restoreAllMocks()
  await Promise.all(databases.splice(0).map(db => db.destroy()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

test('lost creation acknowledgements recover the same sealed archive on an independent server', async () => {
  const { db, requests, second, archives } = await fixture()
  const input = request()
  const admitted = await requests.claim(identity, input)
  expect(admitted.receipt).toEqual({
    version: 1,
    requestId: input.requestId,
    expiresAt: input.notAfter,
    state: 'building'
  })
  expect(admitted.owner).toBeDefined()
  expect(await second.claim(identity, input)).toEqual({ receipt: admitted.receipt })
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 1, reservedBytes: input.maxBytes })
  const writer = await requests.begin(admitted.owner!, binding)
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 1, reservedBytes: input.maxBytes })
  await append(archives, writer)
  const manifest = await requests.seal(admitted.owner!, writer)
  expect(manifest.expiresAt).toBe(input.notAfter)
  const recovered = await second.claim(identity, input)
  expect(recovered).toEqual({
    receipt: { ...admitted.receipt, state: 'ready', archiveId: writer.archiveId, digest: manifest.digest }
  })
  expect(await second.status(identity, input.requestId)).toEqual(recovered.receipt)
  expect(JSON.stringify(recovered)).not.toContain(admitted.owner!.claimToken)
  expect(JSON.stringify(recovered)).not.toContain(writer.writerToken)
  await second.close(identity, input.requestId)
  await second.close(identity, input.requestId)
  expect((await requests.claim(identity, input)).receipt.state).toBe('closed')
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
  expect(await db('snapshot_archive_pages')).toHaveLength(0)
  await expect(second.status(other, input.requestId)).rejects.toThrow('unavailable')
})

test('a pending claim reserves capacity before any source or archive exists and cancellation releases once', async () => {
  const { db, peer, requests, second, archives } = await fixture()
  const input = request()
  const admitted = await requests.claim(identity, input)
  expect(await db('snapshot_archives')).toHaveLength(0)
  await expect(second.claim(identity, request('c'.repeat(64)))).rejects.toThrow('occupied')
  // Independent synchronous SQLite pools may report SQLITE_BUSY rather than
  // yield to another transaction in this event loop. Drain both requests and
  // retry the refused one; neither outcome may double-release its reservation.
  await db.raw('PRAGMA busy_timeout = 0')
  await peer.raw('PRAGMA busy_timeout = 0')
  const outcomes = await Promise.allSettled([
    requests.close(identity, input.requestId),
    second.close(identity, input.requestId)
  ])
  expect(outcomes.some(result => result.status === 'fulfilled')).toBe(true)
  for (const result of outcomes) {
    if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'SQLITE_BUSY' })
  }
  await requests.close(identity, input.requestId)
  await second.close(identity, input.requestId)
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
  await expect(requests.begin(admitted.owner!, binding)).rejects.toThrow('unavailable')
  const local = await archives.begin(binding)
  await archives.close(identity, local.archiveId)
})

test('failed archive assignment rolls back its capacity handoff and remains safely cancellable', async () => {
  const { db, requests } = await fixture()
  const input = request()
  const admitted = await requests.claim(identity, input)
  await db.raw(
    "CREATE TRIGGER fail_request_assignment BEFORE UPDATE ON snapshot_archive_requests WHEN NEW.archiveId IS NOT NULL BEGIN SELECT RAISE(ABORT, 'synthetic assignment interruption'); END"
  )
  await expect(requests.begin(admitted.owner!, binding)).rejects.toThrow('synthetic assignment interruption')
  expect(await db('snapshot_archives')).toHaveLength(0)
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 1, reservedBytes: input.maxBytes })
  expect((await requests.status(identity, input.requestId)).state).toBe('building')
  await db.raw('DROP TRIGGER fail_request_assignment')
  await requests.close(identity, input.requestId, 'failed')
  expect((await requests.status(identity, input.requestId)).state).toBe('failed')
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
})

test('a failed ready-receipt commit cannot publish the archive separately', async () => {
  const { db, requests, archives } = await fixture()
  const input = request()
  const admitted = await requests.claim(identity, input)
  const writer = await requests.begin(admitted.owner!, binding)
  await append(archives, writer)
  await db.raw(
    "CREATE TRIGGER fail_request_ready BEFORE UPDATE ON snapshot_archive_requests WHEN NEW.state = 'ready' BEGIN SELECT RAISE(ABORT, 'synthetic ready interruption'); END"
  )
  await expect(requests.seal(admitted.owner!, writer)).rejects.toThrow('synthetic ready interruption')
  expect((await requests.status(identity, input.requestId)).state).toBe('building')
  await expect(archives.inspect(identity, writer.archiveId)).rejects.toThrow('unavailable')
  await db.raw('DROP TRIGGER fail_request_ready')
  const manifest = await requests.seal(admitted.owner!, writer)
  expect((await requests.status(identity, input.requestId)).digest).toBe(manifest.digest)
})

test('pending claims count against ordinary staging capacity and expired claims are reaped', async () => {
  const { db, requests, archives } = await fixture()
  for (let n = 0; n < 8; n++)
    await requests.claim('02' + n.toString(16).padStart(64, '0'), request(n.toString(16).padStart(64, '0')))
  await expect(archives.begin(binding, { maxBytes: 32768 })).rejects.toThrow('occupied')
  await expect(requests.claim(identity, request())).rejects.toThrow('occupied')
  await db('snapshot_archive_requests').update({ expiresAt: 0 })
  await requests.reap()
  expect(await db('snapshot_archive_requests')).toHaveLength(0)
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
})

test('terminal receipt history remains bounded even after physical capacity is released', async () => {
  const { requests, db } = await fixture()
  for (let n = 0; n < 4; n++) {
    const input = request(n.toString(16).padStart(64, '0'))
    await requests.claim(identity, input)
    await requests.close(identity, input.requestId)
  }
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
  await expect(requests.claim(identity, request())).rejects.toThrow('occupied')
  expect(await db('snapshot_archive_requests')).toHaveLength(4)
})

test('schema removal refuses outstanding reservations and repeated creation preserves receipts', async () => {
  const { db, requests } = await fixture()
  const input = request()
  await requests.claim(identity, input)
  await addSnapshotArchiveRequestTable(db)
  expect((await requests.status(identity, input.requestId)).state).toBe('building')
  await expect(removeSnapshotArchiveRequestTable(db)).rejects.toThrow('Close snapshot archive requests')
  await requests.close(identity, input.requestId)
  await removeSnapshotArchiveRequestTable(db)
  await removeSnapshotArchiveRequestTable(db)
  expect(await db.schema.hasTable('snapshot_archive_requests')).toBe(false)
})

test('an actually expired request stays unavailable after its receipt has been collected', async () => {
  const { db, requests } = await fixture()
  const input = { ...request(), notAfter: Date.now() + 100 }
  input.requestId = snapshotArchiveRequestId(input)
  await requests.claim(identity, input)
  await new Promise(resolve => setTimeout(resolve, 150))
  expect((await requests.status(identity, input.requestId)).state).toBe('expired')
  await requests.reap()
  expect(await db('snapshot_archive_requests')).toHaveLength(0)
  await expect(requests.claim(identity, input)).rejects.toThrow('Invalid snapshot archive creation request')
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
})

test('global terminal history bounds many distinct profiles without consuming released capacity', async () => {
  const { db, requests } = await fixture()
  for (let n = 0; n < 64; n++) {
    const owner = '02' + n.toString(16).padStart(64, '0')
    const input = request(n.toString(16).padStart(64, '0'))
    await requests.claim(owner, input)
    await requests.close(owner, input.requestId)
  }
  await expect(requests.claim(identity, request())).rejects.toThrow('occupied')
  expect(await db('snapshot_archive_requests')).toHaveLength(64)
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
})

test('capture ownership, profile and archive binding must all match before durable effects', async () => {
  const { db, requests, archives } = await fixture()
  const input = request()
  const admitted = await requests.claim(identity, input)
  await expect(requests.begin({ ...admitted.owner!, claimToken: '0'.repeat(64) }, binding)).rejects.toThrow(
    'unavailable'
  )
  await expect(
    requests.begin(admitted.owner!, { ...binding, user: { ...binding.user, identityKey: other } })
  ).rejects.toThrow('unavailable')
  expect(await db('snapshot_archives')).toHaveLength(0)
  const writer = await requests.begin(admitted.owner!, binding)
  await expect(requests.begin(admitted.owner!, binding)).rejects.toThrow('unavailable')
  await append(archives, writer)
  await expect(requests.seal(admitted.owner!, { ...writer, archiveId: '0'.repeat(64) })).rejects.toThrow('unavailable')
  await expect(requests.seal(admitted.owner!, { ...writer, writerToken: '0'.repeat(64) })).rejects.toThrow(
    'unavailable'
  )
  const manifest = await requests.seal(admitted.owner!, writer)
  expect(await requests.seal(admitted.owner!, writer)).toEqual(manifest)
  await requests.close(identity, input.requestId)
  await expect(requests.seal(admitted.owner!, writer)).rejects.toThrow('unavailable')
})

test('a local archive that wins a profile race leaves the pending request reservation recoverable', async () => {
  const { db, requests, archives } = await fixture()
  const input = request()
  const admitted = await requests.claim(identity, input)
  const local = await archives.begin(binding, { maxBytes: 8192 })
  await expect(requests.begin(admitted.owner!, binding)).rejects.toThrow('occupied')
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 2, reservedBytes: 40960 })
  await requests.close(identity, input.requestId, 'failed')
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 1, reservedBytes: 8192 })
  await archives.close(identity, local.archiveId)
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
})

test.each(['', 'x' + identity, identity + 'x', 7, null])(
  'refuses malformed request profile %p before database work',
  async value => {
    const { requests, db } = await fixture()
    await expect(requests.claim(value as string, request())).rejects.toThrow(
      /identityKey.*compressed public identity key/
    )
    expect(await db('snapshot_archive_requests')).toHaveLength(0)
  }
)

test.each(['', 'x' + 'a'.repeat(64), 'a'.repeat(64) + 'x', 7, null])(
  'refuses malformed request identifier %p',
  async value => {
    const { requests } = await fixture()
    await expect(requests.status(identity, value as string)).rejects.toThrow(
      /requestId.*version-one snapshot archive request identifier/
    )
  }
)

test('ready profiles retain independent deadlines and cleanup ownership', async () => {
  const { db, requests, archives } = await fixture()
  const first = request()
  const firstClaim = await requests.claim(identity, first)
  const firstWriter = await requests.begin(firstClaim.owner!, binding)
  await append(archives, firstWriter)
  await requests.seal(firstClaim.owner!, firstWriter)
  const next = { ...request('c'.repeat(64)), notAfter: first.notAfter - 60000 }
  next.requestId = snapshotArchiveRequestId(next)
  const nextClaim = await requests.claim(other, next)
  const nextWriter = await requests.begin(nextClaim.owner!, {
    ...binding,
    user: { ...binding.user, identityKey: other }
  })
  await append(archives, nextWriter)
  const nextManifest = await requests.seal(nextClaim.owner!, nextWriter)
  expect((await archives.inspect(identity, firstWriter.archiveId)).expiresAt).toBe(first.notAfter)
  expect(nextManifest.expiresAt).toBe(next.notAfter)
  await requests.close(identity, first.requestId)
  expect((await requests.status(other, next.requestId)).state).toBe('ready')
  expect((await db('snapshot_archive_requests').where({ identityKey: other }).first()).released).toBe(0)
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 1, reservedBytes: 32768 })
  expect((await archives.inspect(other, nextWriter.archiveId)).digest).toBe(nextManifest.digest)
  await requests.close(other, next.requestId)
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
})

test('existing local archives refuse request admission for their profile', async () => {
  const { db, requests, archives } = await fixture()
  const local = await archives.begin(binding, { maxBytes: 8192 })
  await expect(requests.claim(identity, request())).rejects.toThrow('occupied')
  expect(await db('snapshot_archive_requests')).toHaveLength(0)
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 1, reservedBytes: 8192 })
  await archives.close(identity, local.archiveId)
})

test('byte reservations accept the exact global limit and reject the next capture', async () => {
  const { db, requests } = await fixture()
  for (let n = 0; n < 4; n++)
    await requests.claim(
      '02' + n.toString(16).padStart(64, '0'),
      request(n.toString(16).padStart(64, '0'), 32 * 1024 * 1024)
    )
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 4, reservedBytes: 128 * 1024 * 1024 })
  await expect(requests.claim(identity, request())).rejects.toThrow('occupied')
  expect(await db('snapshot_archive_requests')).toHaveLength(4)
})

test.each(['closed', 'failed', 'expired'] as const)(
  'reaping resumes interrupted %s cleanup without collecting unexpired history',
  async state => {
    const { db, requests, archives } = await fixture()
    const input = request()
    const admitted = await requests.claim(identity, input)
    const writer = await requests.begin(admitted.owner!, binding)
    await append(archives, writer)
    await db.raw(
      "CREATE TRIGGER fail_request_cleanup BEFORE DELETE ON snapshot_archive_pages BEGIN SELECT RAISE(ABORT, 'synthetic cleanup interruption'); END"
    )
    await expect(requests.close(identity, input.requestId, state)).rejects.toThrow('synthetic cleanup interruption')
    expect((await requests.status(identity, input.requestId)).state).toBe(state)
    expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 1, reservedBytes: 32768 })
    expect((await db('snapshot_archive_requests').first()).released).toBe(0)
    await db.raw('DROP TRIGGER fail_request_cleanup')
    await requests.reap()
    expect(await db('snapshot_archive_requests')).toHaveLength(1)
    expect((await db('snapshot_archive_requests').first()).released).toBe(1)
    expect(await db('snapshot_archive_pages')).toHaveLength(0)
    expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
  }
)

test('a creation request expires exactly at its immutable database-clock deadline', async () => {
  const { db, requests } = await fixture()
  const input = request()
  const admitted = await requests.claim(identity, input)
  const clock = jest.spyOn(ArchiveSql, 'snapshotArchiveDatabaseNow').mockResolvedValue(input.notAfter)
  try {
    expect((await requests.status(identity, input.requestId)).state).toBe('expired')
    await expect(requests.begin(admitted.owner!, binding)).rejects.toThrow('unavailable')
    await requests.reap()
    expect(await db('snapshot_archive_requests')).toHaveLength(0)
  } finally {
    clock.mockRestore()
  }
})

test.each([0, 1])('admission rechecks %i remaining milliseconds after ownership lookup', async remaining => {
  const { db, requests } = await fixture()
  const input = request()
  const admitted = await requests.claim(identity, input)
  const clock = jest
    .spyOn(ArchiveSql, 'snapshotArchiveDatabaseNow')
    .mockResolvedValueOnce(input.notAfter - 1)
    .mockResolvedValue(input.notAfter - remaining)
  try {
    const pending = requests.begin(admitted.owner!, binding)
    if (remaining === 0) {
      await expect(pending).rejects.toThrow('unavailable')
      expect(await db('snapshot_archives')).toHaveLength(0)
    } else {
      const writer = await pending
      expect((await db('snapshot_archives').where({ archiveId: writer.archiveId }).first()).expiresAt).toBe(
        input.notAfter
      )
    }
    expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 1, reservedBytes: 32768 })
  } finally {
    clock.mockRestore()
  }
})

test('full-request cancellation fences a delayed first claim on another connection without reserving capacity', async () => {
  const { db, requests, second } = await fixture()
  const input = request()
  await second.markCancellation(identity, input)
  const closed = { version: 1, requestId: input.requestId, expiresAt: input.notAfter, state: 'closed' }
  expect(await requests.claim(identity, input)).toEqual({ receipt: closed })
  expect(await second.status(identity, input.requestId)).toEqual(closed)
  expect(await db('snapshot_archive_requests').first()).toMatchObject({
    state: 'closed',
    released: 1,
    reservedBytes: 0,
    archiveId: null
  })
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
  await requests.markCancellation(identity, { ...input })
  await second.close(identity, input.requestId)
  expect(await db('snapshot_archive_requests')).toHaveLength(1)
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
  const separate = await requests.claim(other, input)
  expect(separate.owner).toBeDefined()
  expect(separate.receipt.state).toBe('building')
  await requests.close(other, input.requestId)
})

test('the cancellation fence retains an existing reservation until ordinary physical cleanup', async () => {
  const { db, requests, second } = await fixture()
  const input = request()
  const admitted = await requests.claim(identity, input)
  await second.markCancellation(identity, input)
  expect((await requests.status(identity, input.requestId)).state).toBe('closed')
  expect(await db('snapshot_archive_requests').first()).toMatchObject({ released: 0, reservedBytes: input.maxBytes })
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 1, reservedBytes: input.maxBytes })
  await expect(requests.begin(admitted.owner!, binding)).rejects.toThrow('unavailable')
  await second.close(identity, input.requestId)
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
})

test('a cancellation tombstone expires at the original deadline and cannot make that request reusable', async () => {
  const { db, requests, second } = await fixture()
  const input = request()
  await requests.markCancellation(identity, input)
  const clock = jest.spyOn(ArchiveSql, 'snapshotArchiveDatabaseNow').mockResolvedValue(input.notAfter)
  await second.reap()
  expect(await db('snapshot_archive_requests')).toHaveLength(0)
  await requests.markCancellation(identity, input)
  expect(await db('snapshot_archive_requests')).toHaveLength(0)
  await expect(second.claim(identity, input)).rejects.toThrow('Invalid snapshot archive creation request')
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
  clock.mockRestore()
})

test('cancellation history exhaustion fails observably without falsely acknowledging a durable fence', async () => {
  const { db, requests, second } = await fixture()
  const retained = []
  for (let i = 0; i < 4; i++) {
    const input = request(i.toString(16).padStart(64, '0'))
    retained.push(input)
    await requests.markCancellation(identity, input)
  }
  await expect(second.markCancellation(identity, request())).rejects.toThrow('history is occupied')
  expect(await db('snapshot_archive_requests')).toHaveLength(4)
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
  // A retained request remains idempotently cancellable at the history ceiling.
  await second.markCancellation(identity, retained[0])
  expect((await requests.claim(identity, retained[0])).receipt.state).toBe('closed')
})

test('failed cancellation persistence rolls back and never creates a partial reservation', async () => {
  const { db, requests } = await fixture()
  const input = request()
  await db.raw(
    "CREATE TRIGGER fail_request_cancel BEFORE INSERT ON snapshot_archive_requests WHEN NEW.state = 'closed' BEGIN SELECT RAISE(ABORT, 'synthetic cancellation interruption'); END"
  )
  await expect(requests.markCancellation(identity, input)).rejects.toThrow('synthetic cancellation interruption')
  expect(await db('snapshot_archive_requests')).toHaveLength(0)
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
  await db.raw('DROP TRIGGER fail_request_cancel')
  await requests.markCancellation(identity, input)
  expect((await requests.claim(identity, input)).receipt.state).toBe('closed')
})

// Append to RequestStore tests after implementing the offer. Uses real existing
// independent SQLite fixture and assertions against independently read tables.
test('server offers retain bounded cancellation ownership without charging a capture', async () => {
  const { db, requests, second } = await fixture()
  const options = { lifetimeMs: 300000, maxBytes: 32768 }
  const issued = (await requests.offer(identity, options))!
  expect(issued.request.notAfter).toBe(issued.serverTime + options.lifetimeMs)
  expect(issued.request.maxBytes).toBe(options.maxBytes)
  expect(issued.request.requestId).toBe(snapshotArchiveReaderRequestId(issued.request))
  expect(await db('snapshot_archive_requests').first()).toMatchObject({
    identityKey: identity,
    state: 'offered',
    reservedBytes: 0,
    released: 1,
    archiveId: null
  })
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
  expect(await db('snapshot_archives')).toHaveLength(0)
  await second.markReaderCancellation(identity, issued.request)
  await second.close(identity, issued.request.requestId)
  expect(await db('snapshot_archive_requests')).toHaveLength(0)
  await expect(requests.claimReader(identity, issued.request)).rejects.toThrow('unavailable')
  await expect(requests.claim(identity, issued.request)).rejects.toThrow('Invalid snapshot archive creation request')
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
})

test('a retained offer can be admitted when every history slot is occupied, charging exactly once', async () => {
  const { db, requests, second } = await fixture()
  const offers = []
  for (let n = 0; n < 4; n++) offers.push((await requests.offer(identity, { lifetimeMs: 300000, maxBytes: 32768 }))!)
  expect(new Set(offers.map(offer => offer.request.requestId)).size).toBe(4)
  expect(await requests.offer(identity, { lifetimeMs: 300000, maxBytes: 32768 })).toBeUndefined()
  expect(await db('snapshot_archive_requests')).toHaveLength(4)
  const admitted = await second.claimReader(identity, offers[0].request)
  expect(admitted.owner).toBeDefined()
  expect(await requests.claimReader(identity, offers[0].request)).toEqual({ receipt: admitted.receipt })
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 1, reservedBytes: 32768 })
  await expect(requests.claimReader(identity, offers[1].request)).rejects.toThrow('occupied')
  await requests.markReaderCancellation(identity, offers[1].request)
  await requests.close(identity, offers[1].request.requestId)
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 1, reservedBytes: 32768 })
  await second.close(identity, offers[0].request.requestId)
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
})

test('lost offers expire without source or capture quota and cannot be admitted after collection', async () => {
  const { db, requests } = await fixture()
  const clock = jest.spyOn(ArchiveSql, 'snapshotArchiveDatabaseNow').mockResolvedValue(1000000)
  const issued = (await requests.offer(identity, { lifetimeMs: 50, maxBytes: 32768 }))!
  clock.mockResolvedValue(1000050)
  await requests.reap()
  expect(await db('snapshot_archive_requests')).toHaveLength(0)
  expect(await db('snapshot_archives')).toHaveLength(0)
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
  await expect(requests.claimReader(identity, issued.request)).rejects.toThrow(
    'Invalid snapshot archive reader request'
  )
})

test('failed offered-to-claimed persistence rolls back quota and remains cancellable', async () => {
  const { db, requests, second } = await fixture()
  const issued = (await requests.offer(identity, { lifetimeMs: 300000, maxBytes: 32768 }))!
  await db.raw(
    "CREATE TRIGGER fail_offer_claim BEFORE UPDATE ON snapshot_archive_requests WHEN NEW.state = 'claimed' BEGIN SELECT RAISE(ABORT, 'synthetic offered admission interruption'); END"
  )
  await expect(second.claimReader(identity, issued.request)).rejects.toThrow('synthetic offered admission interruption')
  expect(await db('snapshot_archive_requests').first()).toMatchObject({
    state: 'offered',
    released: 1,
    reservedBytes: 0
  })
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
  await db.raw('DROP TRIGGER fail_offer_claim')
  await requests.markReaderCancellation(identity, issued.request)
  await requests.close(identity, issued.request.requestId)
  await expect(second.claimReader(identity, issued.request)).rejects.toThrow('unavailable')
  expect(await db('snapshot_archive_requests')).toHaveLength(0)
})

test('frequent completed readers release history immediately without reopening delayed requests', async () => {
  const { db, requests, second } = await fixture()
  const old = []
  for (let n = 0; n < 16; n++) {
    const offer = (await requests.offer(identity, { lifetimeMs: 300000, maxBytes: 32768 }))!
    old.push(offer.request)
    const admitted = await requests.claimReader(identity, offer.request)
    expect(admitted.owner).toBeDefined()
    await second.markReaderCancellation(identity, offer.request)
    await second.close(identity, offer.request.requestId)
    expect(await db('snapshot_archive_requests')).toHaveLength(0)
    expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
  }
  for (const request of old) {
    await expect(requests.claimReader(identity, request)).rejects.toThrow('unavailable')
    await expect(requests.claim(identity, request)).rejects.toThrow('Invalid snapshot archive creation request')
    await expect(second.markReaderCancellation(identity, request)).resolves.toBeUndefined()
  }
  expect(await db('snapshot_archive_requests')).toHaveLength(0)
})

test('a caller cannot admit a reader tuple that the server never offered', async () => {
  const { db, requests } = await fixture()
  const fields = { version: 2 as const, nonce: 'a'.repeat(64), notAfter: Date.now() + 300000, maxBytes: 32768 }
  const input = { ...fields, requestId: snapshotArchiveReaderRequestId(fields) }
  await expect(requests.claimReader(identity, input)).rejects.toThrow('unavailable')
  await expect(requests.claim(identity, input)).rejects.toThrow('Invalid snapshot archive creation request')
  await expect(requests.markReaderCancellation(identity, input)).resolves.toBeUndefined()
  expect(await db('snapshot_archive_requests')).toHaveLength(0)
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
})

test('reader cleanup keeps its reservation and fence through a failed page deletion', async () => {
  const { db, requests, second, archives } = await fixture()
  const offered = (await requests.offer(identity, { lifetimeMs: 300000, maxBytes: 32768 }))!
  const admitted = await requests.claimReader(identity, offered.request)
  const writer = await requests.begin(admitted.owner!, binding)
  await append(archives, writer)
  await requests.seal(admitted.owner!, writer)
  await db.raw(
    "CREATE TRIGGER fail_reader_cleanup BEFORE DELETE ON snapshot_archive_pages BEGIN SELECT RAISE(ABORT, 'synthetic reader cleanup interruption'); END"
  )
  await expect(second.close(identity, offered.request.requestId)).rejects.toThrow(
    'synthetic reader cleanup interruption'
  )
  expect(await db('snapshot_archive_requests').first()).toMatchObject({
    state: 'closed',
    released: 0,
    archiveId: writer.archiveId
  })
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 1, reservedBytes: 32768 })
  expect(await requests.claimReader(identity, offered.request)).toEqual({
    receipt: { version: 1, requestId: offered.request.requestId, expiresAt: offered.request.notAfter, state: 'closed' }
  })
  expect(await requests.offer(identity, { lifetimeMs: 300000, maxBytes: 32768 })).toBeUndefined()
  await db.raw('DROP TRIGGER fail_reader_cleanup')
  await second.close(identity, offered.request.requestId)
  expect(await db('snapshot_archive_requests')).toHaveLength(0)
  expect(await db('snapshot_archive_pages')).toHaveLength(0)
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
  await expect(requests.claimReader(identity, offered.request)).rejects.toThrow('unavailable')
})

test('reader offers remain profile-bound through claim and cancellation', async () => {
  const { db, requests, second } = await fixture()
  const issued = (await requests.offer(identity, { lifetimeMs: 300000, maxBytes: 32768 }))!
  await expect(second.claimReader(other, issued.request)).rejects.toThrow('unavailable')
  await second.markReaderCancellation(other, issued.request)
  expect(await db('snapshot_archive_requests')).toHaveLength(1)
  expect(await db('snapshot_archive_requests').first()).toMatchObject({ identityKey: identity, state: 'offered' })
  expect((await requests.claimReader(identity, issued.request)).owner).toBeDefined()
  await second.close(identity, issued.request.requestId)
  expect(await db('snapshot_archive_requests')).toHaveLength(0)
})

test('early reader collection refuses altered persisted tuple binding and rolls back release', async () => {
  const { db, requests } = await fixture()
  const issued = (await requests.offer(identity, { lifetimeMs: 300000, maxBytes: 32768 }))!
  await requests.claimReader(identity, issued.request)
  await db('snapshot_archive_requests').update({
    requestJson: JSON.stringify({ ...issued.request, requestId: '0'.repeat(64) })
  })
  await expect(requests.close(identity, issued.request.requestId)).rejects.toThrow(
    'Invalid snapshot archive reader request'
  )
  expect(await db('snapshot_archive_requests').first()).toMatchObject({ state: 'closed', released: 0 })
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 1, reservedBytes: 32768 })
  await db('snapshot_archive_requests').update({ requestJson: JSON.stringify(issued.request) })
  await requests.close(identity, issued.request.requestId)
  expect(await db('snapshot_archive_requests')).toHaveLength(0)
  expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
})
