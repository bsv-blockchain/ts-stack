import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { getAdmissionStorage } from '../../storage/AdmissionStorage.js'
import { bootstrapMongoOverlay } from '../../storage/mongo/MongoSchema.js'
import { MongoPayloadStore } from '../../storage/mongo/MongoPayloadStore.js'
import { createMongoReplicaFixture, type MongoReplicaFixture } from './MongoReplicaFixture.js'

const bytes = async function* (
  value: Uint8Array,
  split = value.byteLength
): AsyncIterable<Uint8Array> {
  for (let index = 0; index < value.byteLength; index += split)
    yield value.subarray(index, index + split)
}

const digest = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex')

describe('MongoPayloadStore', () => {
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

  test('stores BSON Binary inline and rejects corrupt stream declarations', async () => {
    const content = Buffer.from('overlay-payload')
    const hash = digest(content)
    await expect(
      store.publish({
        kind: 'locking-script',
        digest: hash,
        byteLength: String(content.byteLength),
        bytes: bytes(content, 3)
      })
    ).resolves.toMatchObject({ digest: hash })
    const row = await fixture.db.collection('overlay_payloads').findOne({ digest: hash })
    expect(row?.inlineData).toBeDefined()
    await expect(
      store.publish({
        kind: 'locking-script',
        digest: digest(Buffer.from('different')),
        byteLength: '1',
        bytes: bytes(content)
      })
    ).rejects.toThrow('declared length')
  })

  test('derives raw transaction identity from streamed bytes', async () => {
    const content = Buffer.from('01000000000000000000', 'hex')
    const hash = digest(content)
    const expectedTxid = createHash('sha256')
      .update(Buffer.from(hash, 'hex'))
      .digest()
      .reverse()
      .toString('hex')
    await expect(
      store.publish({
        kind: 'raw-transaction',
        digest: hash,
        byteLength: String(content.byteLength),
        txid: expectedTxid,
        bytes: bytes(content, 1)
      })
    ).resolves.toMatchObject({ txid: expectedTxid })
    await expect(
      store.publish({
        kind: 'raw-transaction',
        digest: digest(Buffer.from('unmatched')),
        byteLength: String(content.byteLength),
        txid: '00'.repeat(32),
        bytes: bytes(content)
      })
    ).rejects.toThrow()
  })

  test('requires actual ready-row guard in a caller transaction for references', async () => {
    const content = Buffer.from('pinned')
    const hash = digest(content)
    await store.publish({
      kind: 'outbox-data',
      digest: hash,
      byteLength: String(content.byteLength),
      bytes: bytes(content)
    })
    const reference = {
      scope: fixture.scope,
      payload: { kind: 'outbox-data' as const, digest: hash },
      ownerKind: 'pin' as const,
      ownerId: 'test-pin',
      slot: '0',
      expiresAt: new Date(Date.now() + 60_000)
    }
    await expect(store.addReference(fixture.client.startSession(), reference)).rejects.toThrow(
      'active transaction'
    )
    const session = fixture.client.startSession()
    await session.withTransaction(async () => {
      await store.addReference(session, reference)
    })
    await session.endSession()
    expect(
      await fixture.db
        .collection('overlay_payload_references')
        .countDocuments({ ownerId: 'test-pin' })
    ).toBe(1)
  })

  test('streams individual payloads beyond BSON limits through GridFS', async () => {
    const content = Buffer.alloc(16 * 1024 * 1024 + 17, 0x5a)
    const hash = digest(content)
    await store.publish({
      kind: 'locking-script',
      digest: hash,
      byteLength: String(content.byteLength),
      bytes: bytes(content, 255 * 1024)
    })
    const row = await fixture.db.collection('overlay_payloads').findOne({ digest: hash })
    expect(row?.fileId).toBeDefined()
    expect(row?.inlineData).toBeUndefined()
    const files = await fixture.db
      .collection('overlayPayloads.files')
      .countDocuments({ _id: row?.fileId, 'metadata.state': 'published' })
    expect(files).toBe(1)

    const rawHash = digest(Buffer.concat([content, Buffer.from([1])]))
    await store.publish({
      kind: 'raw-transaction',
      digest: rawHash,
      byteLength: String(content.byteLength + 1),
      bytes: bytes(Buffer.concat([content, Buffer.from([1])]), 255 * 1024)
    })
    expect(
      await fixture.db
        .collection('overlay_payloads')
        .countDocuments({ kind: 'raw-transaction', digest: rawHash, fileId: { $exists: true } })
    ).toBe(1)
  }, 60000)

  test('cancels a stalled iterator and releases the reservation for a retry', async () => {
    const content = Buffer.from('cancelled-then-retry')
    const hash = digest(content)
    const controller = new AbortController()
    let returned = false
    const stalled: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => await new Promise<IteratorResult<Uint8Array>>(() => undefined),
          return: async () => {
            returned = true
            return { done: true, value: undefined }
          }
        }
      }
    }
    const pending = store.publish({
      kind: 'outbox-data',
      digest: hash,
      byteLength: String(content.byteLength),
      bytes: stalled,
      signal: controller.signal
    })
    controller.abort(new Error('test cancellation'))
    await expect(pending).rejects.toThrow('test cancellation')
    expect(returned).toBe(true)
    await expect(
      store.publish({
        kind: 'outbox-data',
        digest: hash,
        byteLength: String(content.byteLength),
        bytes: bytes(content)
      })
    ).resolves.toMatchObject({ digest: hash })
    expect(
      (await fixture.db.collection('overlay_payloads').findOne({ kind: 'outbox-data', digest: hash }))
        ?.state
    ).toBe('ready')
  })

  test('rejects an existing ready payload with a conflicting declared length', async () => {
    const content = Buffer.from('same-content')
    const hash = digest(content)
    await store.publish({
      kind: 'outbox-data',
      digest: hash,
      byteLength: String(content.byteLength),
      bytes: bytes(content)
    })
    await expect(
      store.publish({
        kind: 'outbox-data',
        digest: hash,
        byteLength: String(content.byteLength + 1),
        bytes: bytes(content)
      })
    ).rejects.toThrow('byte length')
  })

  test('recovers published staged files and retires corrupt staged files after an interrupted upload', async () => {
    const content = Buffer.alloc(300 * 1024, 0x42)
    const hash = digest(content)
    await store.publish({
      kind: 'outbox-data',
      digest: hash,
      byteLength: String(content.byteLength),
      bytes: bytes(content, 64 * 1024)
    })
    const payloads = fixture.db.collection('overlay_payloads')
    const row = await payloads.findOne({ kind: 'outbox-data', digest: hash })
    expect(row?.fileId).toBeDefined()
    await payloads.updateOne({ _id: row?._id }, [
      {
        $set: {
          state: 'uploading',
          leaseUntil: { $dateSubtract: { startDate: '$$NOW', unit: 'second', amount: 1 } }
        }
      }
    ])
    await fixture.db
      .collection('overlayPayloads.files')
      .updateOne({ _id: row?.fileId }, { $set: { 'metadata.state': 'staged' } })
    await store.recoverUploads()
    expect((await payloads.findOne({ _id: row?._id }))?.state).toBe('ready')

    await payloads.updateOne({ _id: row?._id }, [
      {
        $set: {
          state: 'uploading',
          leaseUntil: { $dateSubtract: { startDate: '$$NOW', unit: 'second', amount: 1 } }
        }
      }
    ])
    await fixture.db.collection('overlayPayloads.chunks').deleteOne({ files_id: row?.fileId })
    await store.recoverUploads()
    expect((await payloads.findOne({ _id: row?._id }))?.state).toBe('deleted')
  })

  test('serializes reference creation against a GC claim in both committed orders', async () => {
    const content = Buffer.from('gc-order')
    const hash = digest(content)
    const payload = { kind: 'outbox-data' as const, digest: hash }
    await store.publish({
      ...payload,
      byteLength: String(content.byteLength),
      bytes: bytes(content)
    })
    const reference = {
      scope: fixture.scope,
      payload,
      ownerKind: 'output' as const,
      ownerId: 'gc-order',
      slot: '0'
    }
    const first = fixture.client.startSession()
    await first.withTransaction(async () => {
      await store.addReference(first, reference)
    })
    const second = fixture.client.startSession()
    await second.withTransaction(async () => {
      expect(await store.claimGarbage(second, payload)).toBe(false)
    })
    await first.withTransaction(async () => {
      await store.releaseReference(first, reference)
    })
    await second.withTransaction(async () => {
      expect(await store.claimGarbage(second, payload)).toBe(true)
    })
    await expect(
      first.withTransaction(async () => {
        await store.addReference(first, reference)
      })
    ).rejects.toThrow('not ready')
    await Promise.all([first.endSession(), second.endSession()])
  })

  test('uses Mongo server time when an explicit pin expires', async () => {
    const content = Buffer.from('expiring-pin')
    const hash = digest(content)
    const payload = { kind: 'outbox-data' as const, digest: hash }
    await store.publish({
      ...payload,
      byteLength: String(content.byteLength),
      bytes: bytes(content)
    })
    const pin = {
      scope: fixture.scope,
      payload,
      ownerKind: 'pin' as const,
      ownerId: 'expiry',
      slot: '0',
      expiresAt: new Date(Date.now() + 60_000)
    }
    const session = fixture.client.startSession()
    await session.withTransaction(async () => {
      await store.addReference(session, pin)
    })
    await session.withTransaction(async () => {
      expect(await store.claimGarbage(session, payload)).toBe(false)
    })
    await fixture.db.collection('overlay_payload_references').updateOne({ ownerId: 'expiry' }, [
      {
        $set: { expiresAt: { $dateSubtract: { startDate: '$$NOW', unit: 'second', amount: 1 } } }
      }
    ])
    await session.withTransaction(async () => {
      expect(await store.claimGarbage(session, payload)).toBe(true)
    })
    await session.endSession()
  })

  test('uses majority journaled writes even when the caller client defaults to w:1', async () => {
    const weak = await fixture.connect({ monitorCommands: true, writeConcern: { w: 1 } })
    const concerns: unknown[] = []
    weak.on('commandStarted', event => {
      if (event.commandName === 'findAndModify' || event.commandName === 'update')
        concerns.push(event.command.writeConcern)
    })
    const weakStore = new MongoPayloadStore(weak.db(fixture.db.databaseName), fixture.scope)
    const content = Buffer.from('explicit-write-concern')
    await weakStore.publish({
      kind: 'outbox-data',
      digest: digest(content),
      byteLength: String(content.byteLength),
      bytes: bytes(content)
    })
    expect(concerns).toContainEqual({ w: 'majority', j: true })
    await weak.close()
  })

  test('snapshots the constructor scope before asynchronous publication', async () => {
    const mutableScope = { ...fixture.scope }
    const isolated = new MongoPayloadStore(fixture.db, mutableScope)
    mutableScope.network = 'mutated-network'
    const content = Buffer.from('scope-snapshot')
    await isolated.publish({
      kind: 'outbox-data',
      digest: digest(content),
      byteLength: String(content.byteLength),
      bytes: bytes(content)
    })
    expect(
      await fixture.db
        .collection('overlay_payloads')
        .countDocuments({ network: fixture.scope.network, digest: digest(content) })
    ).toBe(1)
    expect(
      await fixture.db
        .collection('overlay_payloads')
        .countDocuments({ network: 'mutated-network', digest: digest(content) })
    ).toBe(0)
  })

  test('live references from every non-pin owner class prevent a GC claim', async () => {
    const content = Buffer.from('reference-guard')
    const hash = digest(content)
    const payload = { kind: 'outbox-data' as const, digest: hash }
    await store.publish({
      ...payload,
      byteLength: String(content.byteLength),
      bytes: bytes(content)
    })
    const ownerKinds = [
      'transaction',
      'applied-history',
      'output',
      'gasp-graph',
      'gasp-node',
      'basm-job',
      'lookup-outbox',
      'propagation-outbox',
      'manifest'
    ] as const
    for (const ownerKind of ownerKinds) {
      const reference = {
        scope: fixture.scope,
        payload,
        ownerKind,
        ownerId: `owner-${ownerKind}`,
        slot: '0'
      }
      const session = fixture.client.startSession()
      await session.withTransaction(async () => {
        await store.addReference(session, reference)
      })
      await session.withTransaction(async () => {
        expect(await store.claimGarbage(session, payload)).toBe(false)
        await store.releaseReference(session, reference)
      })
      await session.endSession()
    }
    const session = fixture.client.startSession()
    await session.withTransaction(async () => {
      expect(await store.claimGarbage(session, payload)).toBe(true)
    })
    await session.endSession()
    expect(await store.finishGarbage(payload)).toBe(true)
  })

  test('does not advertise an admission-storage capability', () => {
    expect(getAdmissionStorage(store)).toBeUndefined()
  })

  test('overlapping publishers of the same digest reuse one ready payload', async () => {
    const content = Buffer.from('overlap-same-digest')
    const hash = digest(content)
    const publish = async (): Promise<unknown> =>
      store.publish({
        kind: 'outbox-data',
        digest: hash,
        byteLength: String(content.byteLength),
        bytes: bytes(content)
      })
    const [first, second] = await Promise.all([publish(), publish()])
    expect(first).toEqual(second)
    expect(
      await fixture.db
        .collection('overlay_payloads')
        .countDocuments({ kind: 'outbox-data', digest: hash, state: 'ready' })
    ).toBe(1)
  })

  test('identical bytes under a different kind keep separate metadata', async () => {
    const content = Buffer.from('cross-kind-bytes')
    const hash = digest(content)
    const input = {
      digest: hash,
      byteLength: String(content.byteLength),
      bytes: bytes(content)
    }
    await store.publish({ ...input, kind: 'locking-script' })
    await store.publish({ ...input, kind: 'outbox-data', bytes: bytes(content) })
    expect(await fixture.db.collection('overlay_payloads').countDocuments({ digest: hash })).toBe(2)
  })

  test('recovers an upload that crashed after GridFS publication and before ready', async () => {
    const content = Buffer.alloc(300 * 1024, 0x71)
    const hash = digest(content)
    const crashing = new MongoPayloadStore(fixture.db, fixture.scope, {
      hooks: {
        beforeReadyCas: () => {
          throw new Error('crash after GridFS publication')
        }
      }
    })
    await expect(
      crashing.publish({
        kind: 'outbox-data',
        digest: hash,
        byteLength: String(content.byteLength),
        bytes: bytes(content, 64 * 1024)
      })
    ).rejects.toThrow('crash after GridFS publication')
    const payloads = fixture.db.collection('overlay_payloads')
    const row = await payloads.findOne({ kind: 'outbox-data', digest: hash })
    expect(row?.state).toBe('uploading')
    expect(row?.fileId).toBeDefined()
    await payloads.updateOne({ _id: row?._id }, [
      {
        $set: {
          leaseUntil: { $dateSubtract: { startDate: '$$NOW', unit: 'second', amount: 1 } }
        }
      }
    ])
    await store.recoverUploads()
    expect((await payloads.findOne({ _id: row?._id }))?.state).toBe('ready')
  })

  test('overlapping uncommitted GC and reference creation conflict on the payload row', async () => {
    const content = Buffer.from('gc-overlap')
    const hash = digest(content)
    const payload = { kind: 'outbox-data' as const, digest: hash }
    await store.publish({
      ...payload,
      byteLength: String(content.byteLength),
      bytes: bytes(content)
    })
    const reference = {
      scope: fixture.scope,
      payload,
      ownerKind: 'output' as const,
      ownerId: 'gc-overlap',
      slot: '0'
    }
    const pin = fixture.client.startSession()
    const gc = fixture.client.startSession()
    try {
      pin.startTransaction()
      await store.addReference(pin, reference)
      gc.startTransaction()
      const competing = store.claimGarbage(gc, payload)
      await delay(25)
      await pin.commitTransaction()
      await expect(competing).rejects.toMatchObject({ code: 112 })
    } finally {
      await Promise.allSettled([pin.abortTransaction(), gc.abortTransaction()])
      await Promise.all([pin.endSession(), gc.endSession()])
    }
  })

  test('physical GridFS deletion resumes after a crash between claim and finish', async () => {
    const content = Buffer.alloc(300 * 1024, 0x63)
    const hash = digest(content)
    const payload = { kind: 'outbox-data' as const, digest: hash }
    await store.publish({
      ...payload,
      byteLength: String(content.byteLength),
      bytes: bytes(content, 64 * 1024)
    })
    const row = await fixture.db.collection('overlay_payloads').findOne({ digest: hash, kind: 'outbox-data' })
    expect(row?.fileId).toBeDefined()
    const session = fixture.client.startSession()
    await session.withTransaction(async () => {
      expect(await store.claimGarbage(session, payload)).toBe(true)
    })
    await session.endSession()
    expect((await fixture.db.collection('overlay_payloads').findOne({ _id: row?._id }))?.state).toBe(
      'deleting'
    )
    await store.recoverUploads()
    expect((await fixture.db.collection('overlay_payloads').findOne({ _id: row?._id }))?.state).toBe(
      'deleted'
    )
    expect(
      await fixture.db.collection('overlayPayloads.files').countDocuments({ _id: row?.fileId })
    ).toBe(0)
    expect(await store.finishGarbage(payload)).toBe(false)
  })

  test('shared manifest components pin the same payload against GC', async () => {
    const content = Buffer.from('shared-ancestor')
    const hash = digest(content)
    const payload = { kind: 'raw-transaction' as const, digest: hash }
    await store.publish({
      ...payload,
      byteLength: String(content.byteLength),
      bytes: bytes(content)
    })
    const session = fixture.client.startSession()
    await session.withTransaction(async () => {
      await store.addManifestComponent(session, {
        manifestId: 'manifest-a',
        ordinal: '0',
        kind: 'raw-transaction',
        payload
      })
      await store.addManifestComponent(session, {
        manifestId: 'manifest-b',
        ordinal: '0',
        kind: 'raw-transaction',
        payload
      })
    })
    await session.withTransaction(async () => {
      expect(await store.claimGarbage(session, payload)).toBe(false)
    })
    await session.endSession()
  })
})
