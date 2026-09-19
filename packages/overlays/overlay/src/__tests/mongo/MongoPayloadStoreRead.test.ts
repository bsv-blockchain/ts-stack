import { createHash, randomUUID } from 'node:crypto'
import { ObjectId } from 'mongodb'
import {
  bootstrapMongoOverlay,
  encodeMongoUint64,
  mongoChainKey,
  mongoRecordKey,
  MongoCollectionNames
} from '../../storage/mongo/MongoSchema.js'
import { MongoPayloadStore } from '../../storage/mongo/MongoPayloadStore.js'
import { createMongoReplicaFixture, type MongoReplicaFixture } from './MongoReplicaFixture.js'

// Scoped to MongoPayloadStore.read()/readBytes() specifically (per the
// worklist for this PR). Every other MongoPayloadStore.ts line belongs to a
// different PR's worklist and is covered in MongoPayloadStore.test.ts on its
// own branch; this file stays separate so the two never collide on a merge.

const bytes = async function* (
  value: Uint8Array,
  split = value.byteLength
): AsyncIterable<Uint8Array> {
  for (let index = 0; index < value.byteLength; index += split)
    yield value.subarray(index, index + split)
}

const digest = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex')

describe('MongoPayloadStore.read() and readBytes()', () => {
  let fixture: MongoReplicaFixture
  let store: MongoPayloadStore

  beforeAll(async () => {
    fixture = await createMongoReplicaFixture()
    await bootstrapMongoOverlay(fixture.db, fixture.scope)
    store = new MongoPayloadStore(fixture.db, fixture.scope)
  }, 120000)

  afterAll(async () => {
    await fixture.close()
  }, 30000)

  test('read() throws when no ready payload exists for the requested content', async () => {
    await expect(store.read({ kind: 'locking-script', digest: 'aa'.repeat(32) })).rejects.toThrow(
      'Mongo payload is not ready'
    )
  })

  test('read() rejects a range whose offset or length is negative, or whose end exceeds the content', async () => {
    const content = Buffer.from('range-guard-content')
    const hash = digest(content)
    await store.publish({
      kind: 'locking-script',
      digest: hash,
      byteLength: String(content.byteLength),
      bytes: bytes(content)
    })
    const ref = { kind: 'locking-script' as const, digest: hash }

    await expect(
      store.read(ref, { offset: '-1', byteLength: String(content.byteLength) })
    ).rejects.toThrow('Mongo payload range is invalid')
    await expect(store.read(ref, { offset: '0', byteLength: '-1' })).rejects.toThrow(
      'Mongo payload range is invalid'
    )
    await expect(
      store.read(ref, { offset: '1', byteLength: String(content.byteLength) })
    ).rejects.toThrow('Mongo payload range is invalid')

    // A range that fits exactly still succeeds, proving the guard is not
    // simply rejecting every explicit range.
    const whole = await store.read(ref, { offset: '0', byteLength: String(content.byteLength) })
    expect(Buffer.from(whole).toString()).toBe(content.toString())
  })

  test('read() rejects a range whose end would exceed a safe JavaScript integer', async () => {
    // Directly seed a "ready" payload record whose declared byteLength is
    // enormous (but a legal uint64), without ever streaming that much real
    // content -- read() must fail closed on the arithmetic before it ever
    // attempts to fetch bytes.
    const hugeLength = '18446744073709551615'
    const id = mongoRecordKey(mongoChainKey(fixture.scope), 'locking-script', 'bb'.repeat(32))
    const now = new Date()
    await fixture.db.collection(MongoCollectionNames.payloads).insertOne({
      _id: id,
      schemaVersion: 1,
      network: fixture.scope.network,
      genesisHash: fixture.scope.genesisHash,
      kind: 'locking-script',
      digest: 'bb'.repeat(32),
      byteLength: encodeMongoUint64(hugeLength),
      state: 'ready',
      guard: randomUUID(),
      ownerNodeId: fixture.scope.nodeId,
      ownerId: randomUUID(),
      fencingToken: encodeMongoUint64('1'),
      leaseUntil: now,
      createdAt: now,
      updatedAt: now
    })
    await expect(
      store.read(
        { kind: 'locking-script', digest: 'bb'.repeat(32) },
        { offset: '0', byteLength: hugeLength }
      )
    ).rejects.toThrow('Mongo payload range exceeds safe integer')
  })

  test('readBytes() downloads content that spilled to GridFS across several chunks', async () => {
    const tight = new MongoPayloadStore(fixture.db, fixture.scope, {
      inlineCeilingBytes: 16,
      gridFsChunkBytes: 8 * 1024
    })
    const content = Buffer.from(
      'this content is well over the sixteen byte inline ceiling for this test'
    )
    const hash = digest(content)
    const published = await tight.publish({
      kind: 'outbox-data',
      digest: hash,
      byteLength: String(content.byteLength),
      bytes: bytes(content, 10)
    })
    const row = await fixture.db
      .collection(MongoCollectionNames.payloads)
      .findOne({ digest: hash, kind: 'outbox-data' })
    expect(row?.fileId).toBeDefined()
    expect(row?.inlineData).toBeUndefined()

    const roundTripped = await tight.read(published)
    expect(Buffer.from(roundTripped).toString()).toBe(content.toString())

    // A partial, mid-file range read must still line up byte-for-byte.
    const slice = await tight.read(published, { offset: '5', byteLength: '10' })
    expect(Buffer.from(slice).toString()).toBe(content.subarray(5, 15).toString())
  })

  test('readBytes() surfaces a download failure when the GridFS file behind a ready record is gone', async () => {
    const now = new Date()
    const missingFileId = new ObjectId()
    const id = mongoRecordKey(mongoChainKey(fixture.scope), 'outbox-data', 'cc'.repeat(32))
    await fixture.db.collection(MongoCollectionNames.payloads).insertOne({
      _id: id,
      schemaVersion: 1,
      network: fixture.scope.network,
      genesisHash: fixture.scope.genesisHash,
      kind: 'outbox-data',
      digest: 'cc'.repeat(32),
      byteLength: encodeMongoUint64('4'),
      state: 'ready',
      guard: randomUUID(),
      ownerNodeId: fixture.scope.nodeId,
      ownerId: randomUUID(),
      fencingToken: encodeMongoUint64('1'),
      leaseUntil: now,
      createdAt: now,
      updatedAt: now,
      // Points at a GridFS file that was never uploaded (deleted/evicted),
      // simulating a ready record left behind after its content was reclaimed.
      fileId: missingFileId
    })
    await expect(store.read({ kind: 'outbox-data', digest: 'cc'.repeat(32) })).rejects.toThrow(
      /FileNotFound/
    )
  })

  test('readBytes() fails closed when a ready record carries neither inline data nor a GridFS file', async () => {
    const now = new Date()
    const id = mongoRecordKey(mongoChainKey(fixture.scope), 'outbox-data', 'dd'.repeat(32))
    // A record can only reach `ready` through completeUpload(), which always
    // sets exactly one of inlineData/fileId -- this simulates a corrupted or
    // hand-edited row that skipped that invariant.
    await fixture.db.collection(MongoCollectionNames.payloads).insertOne({
      _id: id,
      schemaVersion: 1,
      network: fixture.scope.network,
      genesisHash: fixture.scope.genesisHash,
      kind: 'outbox-data',
      digest: 'dd'.repeat(32),
      byteLength: encodeMongoUint64('4'),
      state: 'ready',
      guard: randomUUID(),
      ownerNodeId: fixture.scope.nodeId,
      ownerId: randomUUID(),
      fencingToken: encodeMongoUint64('1'),
      leaseUntil: now,
      createdAt: now,
      updatedAt: now
    })
    await expect(store.read({ kind: 'outbox-data', digest: 'dd'.repeat(32) })).rejects.toThrow(
      'Mongo ready payload has no bytes'
    )
  })
})
