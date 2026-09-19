import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { Binary, GridFSBucket } from 'mongodb'
import { getAdmissionStorage } from '../../storage/AdmissionStorage.js'
import {
  bootstrapMongoOverlay,
  encodeMongoUint64,
  mongoChainKey,
  mongoRecordKey
} from '../../storage/mongo/MongoSchema.js'
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

/**
 * A minimal AbortSignal-shaped test double whose `aborted` flag can be
 * flipped after construction (a real AbortSignal cannot). It implements the
 * only members MongoPayloadStore reads from a signal: the synchronous
 * `aborted`/`reason` properties, plus the two EventTarget methods raceAbort
 * registers, so it is safe to pass anywhere `AbortSignal` is accepted.
 */
function fakeAbortSignal(): AbortSignal & {
  setAborted: (aborted: boolean) => void
  setReason: (reason: unknown) => void
} {
  let abortedFlag = false
  let reasonValue: unknown
  return {
    get aborted() {
      return abortedFlag
    },
    get reason() {
      return reasonValue
    },
    setAborted(aborted: boolean) {
      abortedFlag = aborted
    },
    setReason(reason: unknown) {
      reasonValue = reason
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  } as unknown as AbortSignal & { setAborted: (aborted: boolean) => void; setReason: (reason: unknown) => void }
}

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

  test('re-adding a pin slot extends its expiry but never shortens it silently', async () => {
    const content = Buffer.from('pin-extend')
    const hash = digest(content)
    const payload = { kind: 'outbox-data' as const, digest: hash }
    await store.publish({
      ...payload,
      byteLength: String(content.byteLength),
      bytes: bytes(content)
    })
    const basePin = {
      scope: fixture.scope,
      payload,
      ownerKind: 'pin' as const,
      ownerId: 'pin-extend',
      slot: '0'
    }
    const firstExpiry = new Date(Date.now() + 60_000)
    const session = fixture.client.startSession()
    await session.withTransaction(async () => {
      await store.addReference(session, { ...basePin, expiresAt: firstExpiry })
    })
    const laterExpiry = new Date(Date.now() + 120_000)
    await session.withTransaction(async () => {
      await store.addReference(session, { ...basePin, expiresAt: laterExpiry })
    })
    expect(
      (
        await fixture.db
          .collection('overlay_payload_references')
          .findOne({ ownerId: 'pin-extend' })
      )?.expiresAt
    ).toEqual(laterExpiry)
    const earlierExpiry = new Date(Date.now() + 90_000)
    await expect(
      session.withTransaction(async () => {
        await store.addReference(session, { ...basePin, expiresAt: earlierExpiry })
      })
    ).rejects.toThrow('must not shorten')
    expect(
      (
        await fixture.db
          .collection('overlay_payload_references')
          .findOne({ ownerId: 'pin-extend' })
      )?.expiresAt
    ).toEqual(laterExpiry)
    await session.endSession()
  })

  test('re-adding an expired pin slot reactivates it and makes the payload live again', async () => {
    const content = Buffer.from('pin-reactivate')
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
      ownerId: 'pin-reactivate',
      slot: '0',
      expiresAt: new Date(Date.now() + 60_000)
    }
    const session = fixture.client.startSession()
    await session.withTransaction(async () => {
      await store.addReference(session, pin)
    })
    await fixture.db.collection('overlay_payload_references').updateOne({ ownerId: 'pin-reactivate' }, [
      {
        $set: { expiresAt: { $dateSubtract: { startDate: '$$NOW', unit: 'second', amount: 1 } } }
      }
    ])
    const revived = { ...pin, expiresAt: new Date(Date.now() + 60_000) }
    await session.withTransaction(async () => {
      await store.addReference(session, revived)
    })
    await session.withTransaction(async () => {
      expect(await store.claimGarbage(session, payload)).toBe(false)
    })
    expect(
      (
        await fixture.db
          .collection('overlay_payload_references')
          .findOne({ ownerId: 'pin-reactivate' })
      )?.expiresAt
    ).toEqual(revived.expiresAt)
    await session.endSession()
  })

  test('claimGarbage deletes the expired pin reference row inside the same transaction as its claim', async () => {
    const content = Buffer.from('pin-gc-cleanup')
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
      ownerId: 'pin-gc-cleanup',
      slot: '0',
      expiresAt: new Date(Date.now() + 60_000)
    }
    const session = fixture.client.startSession()
    await session.withTransaction(async () => {
      await store.addReference(session, pin)
    })
    await fixture.db.collection('overlay_payload_references').updateOne({ ownerId: 'pin-gc-cleanup' }, [
      {
        $set: { expiresAt: { $dateSubtract: { startDate: '$$NOW', unit: 'second', amount: 1 } } }
      }
    ])
    await session.withTransaction(async () => {
      expect(await store.claimGarbage(session, payload)).toBe(true)
    })
    expect(
      await fixture.db
        .collection('overlay_payload_references')
        .countDocuments({ ownerId: 'pin-gc-cleanup' })
    ).toBe(0)
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

  test('many concurrent first-time publishers of the same digest still converge on one ready payload', async () => {
    const weak = await fixture.connect({ retryWrites: false })
    const racer = new MongoPayloadStore(weak.db(fixture.db.databaseName), fixture.scope)
    const content = Buffer.from('many-way-overlap-same-digest')
    const hash = digest(content)
    const publish = async (): Promise<unknown> =>
      racer.publish({
        kind: 'outbox-data',
        digest: hash,
        byteLength: String(content.byteLength),
        bytes: bytes(content)
      })
    const results = await Promise.all(Array.from({ length: 12 }, publish))
    for (const result of results) expect(result).toEqual(results[0])
    expect(
      await fixture.db
        .collection('overlay_payloads')
        .countDocuments({ kind: 'outbox-data', digest: hash, state: 'ready' })
    ).toBe(1)
    await weak.close()
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

  test('refreshes the declared length when reclaiming a deleted upload', async () => {
    const content = Buffer.from('reclaimed-upload')
    const hash = digest(content)
    await store.publish({ kind: 'outbox-data', digest: hash, byteLength: String(content.byteLength), bytes: bytes(content) })
    const payloads = fixture.db.collection('overlay_payloads')
    const row = await payloads.findOne({ kind: 'outbox-data', digest: hash })
    await payloads.updateOne({ _id: row?._id }, { $set: { state: 'deleted', byteLength: '00000000000000000999' } })
    await expect(store.publish({ kind: 'outbox-data', digest: hash, byteLength: String(content.byteLength), bytes: bytes(content) })).resolves.toMatchObject({ digest: hash })
    expect(BigInt((await payloads.findOne({ _id: row?._id }))?.byteLength.toString() ?? '0')).toBe(BigInt(content.byteLength))
  })

  test('recovers a too-small declared length by reclaiming the deleted row on retry with the correct length', async () => {
    const content = Buffer.from('too-small-declared-length')
    const hash = digest(content)
    const payloads = fixture.db.collection('overlay_payloads')
    await expect(
      store.publish({
        kind: 'outbox-data',
        digest: hash,
        byteLength: String(content.byteLength - 1),
        bytes: bytes(content)
      })
    ).rejects.toThrow('exceeds declared length')
    const failed = await payloads.findOne({ kind: 'outbox-data', digest: hash })
    expect(failed?.state).toBe('deleted')
    await expect(
      store.publish({
        kind: 'outbox-data',
        digest: hash,
        byteLength: String(content.byteLength),
        bytes: bytes(content)
      })
    ).resolves.toMatchObject({ digest: hash, byteLength: String(content.byteLength) })
    const recovered = await payloads.findOne({ _id: failed?._id })
    expect(recovered?.state).toBe('ready')
    expect(BigInt(recovered?.byteLength.toString() ?? '0')).toBe(BigInt(content.byteLength))
  })

  test('does not reuse an existing reference after its payload was reclaimed', async () => {
    const content = Buffer.from('reclaimed-reference')
    const hash = digest(content)
    const payload = { kind: 'outbox-data' as const, digest: hash }
    await store.publish({ ...payload, byteLength: String(content.byteLength), bytes: bytes(content) })
    const reference = { scope: fixture.scope, payload, ownerKind: 'output' as const, ownerId: 'reclaimed-reference', slot: '0' }
    const session = fixture.client.startSession()
    await session.withTransaction(async () => { await store.addReference(session, reference) })
    await fixture.db.collection('overlay_payloads').updateOne({ digest: hash, kind: payload.kind }, { $set: { state: 'deleted' } })
    await session.withTransaction(async () => {
      await expect(store.addReference(session, reference)).rejects.toThrow('not ready for reference')
    })
    await session.endSession()
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

  test('cancels an in-flight stream after the first chunk has been accepted', async () => {
    const content = Buffer.alloc(64 * 1024, 0x5e)
    const hash = digest(content)
    const controller = new AbortController()
    const pending = store.publish({
      kind: 'outbox-data',
      digest: hash,
      byteLength: String(content.byteLength),
      bytes: (async function* () {
        yield content.subarray(0, 32 * 1024)
        await delay(100)
        yield content.subarray(32 * 1024)
      })(),
      signal: controller.signal
    })
    await delay(20)
    controller.abort(new Error('mid-stream cancel'))
    await expect(pending).rejects.toThrow('mid-stream cancel')
  })

  test('rejects a non-byte stream, over-length stream, and iterator failure', async () => {
    const hash = digest(Buffer.from('stream-guards'))
    await expect(
      store.publish({
        kind: 'outbox-data',
        digest: hash,
        byteLength: '1',
        bytes: {
          [Symbol.asyncIterator]() {
            return {
              next: async () => ({ done: false, value: 'nope' }),
              return: async () => ({ done: true, value: undefined })
            }
          }
        } as AsyncIterable<Uint8Array>
      })
    ).rejects.toThrow('non-byte chunk')
    await expect(
      store.publish({
        kind: 'outbox-data',
        digest: digest(Buffer.from('too-long')),
        byteLength: '1',
        bytes: bytes(Buffer.from('ab'))
      })
    ).rejects.toThrow('exceeds declared length')
    await expect(
      store.publish({
        kind: 'outbox-data',
        digest: digest(Buffer.from('iterator-failed')),
        byteLength: '1',
        bytes: {
          [Symbol.asyncIterator]() {
            return {
              next: async () => {
                throw new Error('iterator-failed')
              },
              return: async () => ({ done: true, value: undefined })
            }
          }
        }
      })
    ).rejects.toThrow('iterator-failed')
  })

  test('reuses a reference slot for the same content and rejects a conflicting slot', async () => {
    const content = Buffer.from('slot-reuse')
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
      ownerId: 'slot-reuse',
      slot: '0'
    }
    const session = fixture.client.startSession()
    await session.withTransaction(async () => {
      await store.addReference(session, reference)
      await store.addReference(session, reference)
    })
    await expect(
      session.withTransaction(async () => {
        await store.addReference(session, {
          ...reference,
          payload: { kind: 'locking-script', digest: hash }
        })
      })
    ).rejects.toThrow('already names different content')
    await session.withTransaction(async () => {
      await store.releaseReference(session, reference)
    })
    await expect(
      session.withTransaction(async () => {
        await store.releaseReference(session, reference)
      })
    ).rejects.toThrow('does not exist')
    await session.endSession()
  })

  test('rejects a reference to a payload that is not ready and reuses a matching manifest ordinal', async () => {
    const missing = { kind: 'outbox-data' as const, digest: digest(Buffer.from('missing-ready')) }
    const session = fixture.client.startSession()
    await expect(
      session.withTransaction(async () => {
        await store.addReference(session, {
          scope: fixture.scope,
          payload: missing,
          ownerKind: 'output',
          ownerId: 'missing-ready',
          slot: '0'
        })
      })
    ).rejects.toThrow('not ready for reference')
    const content = Buffer.from('manifest-ordinal')
    const hash = digest(content)
    const payload = { kind: 'raw-transaction' as const, digest: hash }
    await store.publish({
      ...payload,
      byteLength: String(content.byteLength),
      bytes: bytes(content)
    })
    const component = {
      manifestId: 'manifest-ordinal',
      ordinal: '0',
      kind: 'raw-transaction' as const,
      payload
    }
    await session.withTransaction(async () => {
      await store.addManifestComponent(session, component)
      await store.addManifestComponent(session, component)
    })
    await fixture.db
      .collection('overlay_manifest_components')
      .updateOne({ manifestId: component.manifestId }, { $set: { kind: 'outbox-data' } })
    await expect(
      session.withTransaction(async () => {
        await store.addManifestComponent(session, component)
      })
    ).rejects.toThrow('already names different content')
    await session.endSession()
  })

  test('keeps an oversized inline payload from exceeding the BSON safety ceiling', async () => {
    const tight = new MongoPayloadStore(fixture.db, fixture.scope, {
      inlineCeilingBytes: 1024 * 1024
    })
    const content = Buffer.alloc(1024 * 1024, 0x21)
    await expect(
      tight.publish({
        kind: 'outbox-data',
        digest: digest(content),
        byteLength: String(content.byteLength),
        bytes: bytes(content, 64 * 1024)
      })
    ).rejects.toThrow('inline BSON document exceeds safety ceiling')
  }, 30000)

  test('re-adding a pin slot with the identical unexpired expiry performs no write', async () => {
    const fixedNow = new Date('2030-01-01T00:00:00.000Z')
    const stable = new MongoPayloadStore(fixture.db, fixture.scope, { now: () => fixedNow })
    const content = Buffer.from('pin-identical-expiry')
    const hash = digest(content)
    const payload = { kind: 'outbox-data' as const, digest: hash }
    await stable.publish({ ...payload, byteLength: String(content.byteLength), bytes: bytes(content) })
    const expiresAt = new Date(fixedNow.getTime() + 60_000)
    const pin = {
      scope: fixture.scope,
      payload,
      ownerKind: 'pin' as const,
      ownerId: 'pin-identical-expiry',
      slot: '0',
      expiresAt
    }
    const session = fixture.client.startSession()
    await session.withTransaction(async () => {
      await stable.addReference(session, pin)
    })
    const first = await fixture.db
      .collection('overlay_payload_references')
      .findOne({ ownerId: 'pin-identical-expiry' })
    await session.withTransaction(async () => {
      await stable.addReference(session, pin)
    })
    const second = await fixture.db
      .collection('overlay_payload_references')
      .findOne({ ownerId: 'pin-identical-expiry' })
    expect(second?.updatedAt).toEqual(first?.updatedAt)
    expect(second?.expiresAt).toEqual(expiresAt)
    await session.endSession()
  })

  test('claimGarbage on a payload that was never published returns false without side effects', async () => {
    const missing = { kind: 'outbox-data' as const, digest: digest(Buffer.from('never-published')) }
    const session = fixture.client.startSession()
    await session.withTransaction(async () => {
      expect(await store.claimGarbage(session, missing)).toBe(false)
    })
    await session.endSession()
  })

  test('invokes the afterDeleteClaim hook exactly when a GC claim succeeds', async () => {
    let calls = 0
    const hooked = new MongoPayloadStore(fixture.db, fixture.scope, {
      hooks: {
        afterDeleteClaim: () => {
          calls += 1
        }
      }
    })
    const content = Buffer.from('hook-delete-claim')
    const hash = digest(content)
    const payload = { kind: 'outbox-data' as const, digest: hash }
    await hooked.publish({ ...payload, byteLength: String(content.byteLength), bytes: bytes(content) })
    const session = fixture.client.startSession()
    await session.withTransaction(async () => {
      expect(await hooked.claimGarbage(session, payload)).toBe(true)
    })
    await session.endSession()
    expect(calls).toBe(1)
  })

  test('finishGarbage preserves a GridFS file whose ownership metadata has since changed', async () => {
    const content = Buffer.alloc(300 * 1024, 0x11)
    const hash = digest(content)
    const payload = { kind: 'outbox-data' as const, digest: hash }
    await store.publish({
      ...payload,
      byteLength: String(content.byteLength),
      bytes: bytes(content, 64 * 1024)
    })
    const payloads = fixture.db.collection('overlay_payloads')
    const row = await payloads.findOne({ digest: hash, kind: 'outbox-data' })
    expect(row?.fileId).toBeDefined()
    const session = fixture.client.startSession()
    await session.withTransaction(async () => {
      expect(await store.claimGarbage(session, payload)).toBe(true)
    })
    await session.endSession()
    await fixture.db
      .collection('overlayPayloads.files')
      .updateOne({ _id: row?.fileId }, { $set: { 'metadata.ownerId': 'someone-else' } })
    expect(await store.finishGarbage(payload)).toBe(true)
    expect((await payloads.findOne({ _id: row?._id }))?.state).toBe('deleted')
    expect(
      await fixture.db.collection('overlayPayloads.files').countDocuments({ _id: row?.fileId })
    ).toBe(1)
  })

  test('finishGarbage tolerates a concurrent retry that already deleted the GridFS file', async () => {
    const content = Buffer.alloc(300 * 1024, 0x12)
    const hash = digest(content)
    const payload = { kind: 'outbox-data' as const, digest: hash }
    await store.publish({
      ...payload,
      byteLength: String(content.byteLength),
      bytes: bytes(content, 64 * 1024)
    })
    const payloads = fixture.db.collection('overlay_payloads')
    const row = await payloads.findOne({ digest: hash, kind: 'outbox-data' })
    expect(row?.fileId).toBeDefined()
    const session = fixture.client.startSession()
    await session.withTransaction(async () => {
      expect(await store.claimGarbage(session, payload)).toBe(true)
    })
    await session.endSession()
    // A competing finisher removes the file after this one's ownership read, so
    // the real driver raises its own "File not found for id" error here.
    const bucket = (store as unknown as { bucket: GridFSBucket }).bucket
    const realDelete = bucket.delete.bind(bucket)
    const deleteSpy = jest.spyOn(bucket, 'delete').mockImplementationOnce(async id => {
      await realDelete(id)
      await realDelete(id)
    })
    expect(await store.finishGarbage(payload)).toBe(true)
    expect(deleteSpy).toHaveBeenCalledTimes(1)
    expect((await payloads.findOne({ _id: row?._id }))?.state).toBe('deleted')
    expect(
      await fixture.db.collection('overlayPayloads.files').countDocuments({ _id: row?.fileId })
    ).toBe(0)
    deleteSpy.mockRestore()
  })

  test('rejects publication when the upload lease is stolen just before the ready CAS', async () => {
    const content = Buffer.from('stolen-before-ready')
    const hash = digest(content)
    const fencing = new MongoPayloadStore(fixture.db, fixture.scope, {
      hooks: {
        beforeReadyCas: async () => {
          await fixture.db
            .collection('overlay_payloads')
            .updateOne(
              { kind: 'outbox-data', digest: hash },
              { $set: { guard: 'stolen-guard', ownerId: 'stolen-owner' } }
            )
        }
      }
    })
    await expect(
      fencing.publish({
        kind: 'outbox-data',
        digest: hash,
        byteLength: String(content.byteLength),
        bytes: bytes(content)
      })
    ).rejects.toThrow('fenced before publication')
  })

  test('rejects a wrong explicit txid on an otherwise-correct raw-transaction upload', async () => {
    const content = Buffer.from('02000000000000000001', 'hex')
    const hash = digest(content)
    await expect(
      store.publish({
        kind: 'raw-transaction',
        digest: hash,
        byteLength: String(content.byteLength),
        txid: 'ab'.repeat(32),
        bytes: bytes(content)
      })
    ).rejects.toThrow('does not match bytes')
  })

  test('rejects a wrong explicit txid when the referenced content is already ready', async () => {
    const content = Buffer.from('03000000000000000002', 'hex')
    const hash = digest(content)
    await store.publish({
      kind: 'raw-transaction',
      digest: hash,
      byteLength: String(content.byteLength),
      bytes: bytes(content)
    })
    await expect(
      store.publish({
        kind: 'raw-transaction',
        digest: hash,
        byteLength: String(content.byteLength),
        txid: 'cd'.repeat(32),
        bytes: bytes(content)
      })
    ).rejects.toThrow('does not match bytes')
  })

  test('rejects with a generic message when an aborted signal carries no explicit reason', async () => {
    const signal = fakeAbortSignal()
    const content = Buffer.from('fake-signal-no-reason')
    const chunked: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        let sent = false
        return {
          next: async () => {
            if (sent) return { done: true as const, value: undefined }
            sent = true
            signal.setAborted(true)
            return { done: false as const, value: content }
          }
        }
      }
    }
    await expect(
      store.publish({
        kind: 'outbox-data',
        digest: digest(content),
        byteLength: String(content.byteLength),
        bytes: chunked,
        signal
      })
    ).rejects.toThrow('Mongo payload upload aborted')
  })

  test('rejects with the signal reason when a chunk observes an already-aborted signal that carries one', async () => {
    const signal = fakeAbortSignal()
    const reason = new Error('fake-signal-explicit-reason')
    const content = Buffer.from('fake-signal-with-reason')
    const chunked: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        let sent = false
        return {
          next: async () => {
            if (sent) return { done: true as const, value: undefined }
            sent = true
            signal.setReason(reason)
            signal.setAborted(true)
            return { done: false as const, value: content }
          }
        }
      }
    }
    await expect(
      store.publish({
        kind: 'outbox-data',
        digest: digest(content),
        byteLength: String(content.byteLength),
        bytes: chunked,
        signal
      })
    ).rejects.toBe(reason)
  })

  test('claimGarbage falls back to a generic message when the operation signal reason is unset', async () => {
    const signal = fakeAbortSignal()
    signal.setAborted(true)
    const session = fixture.client.startSession()
    await expect(
      store.claimGarbage(
        session,
        { kind: 'outbox-data', digest: digest(Buffer.from('fake-signal-claim')) },
        { signal }
      )
    ).rejects.toThrow('Mongo payload operation aborted')
    await session.endSession()
  })

  test('rejects staging when the upload lease is stolen mid-stream', async () => {
    const content = Buffer.alloc(300 * 1024, 0x22)
    const hash = digest(content)
    let stolen = false
    const chunked = async function* (): AsyncIterable<Uint8Array> {
      const chunkSize = 64 * 1024
      for (let offset = 0; offset < content.byteLength; offset += chunkSize) {
        yield content.subarray(offset, offset + chunkSize)
        if (!stolen && offset > 0) {
          stolen = true
          await fixture.db
            .collection('overlay_payloads')
            .updateOne(
              { kind: 'outbox-data', digest: hash },
              { $set: { guard: 'mid-stream-steal', ownerId: 'mid-stream-steal' } }
            )
        }
      }
    }
    await expect(
      store.publish({
        kind: 'outbox-data',
        digest: hash,
        byteLength: String(content.byteLength),
        bytes: chunked()
      })
    ).rejects.toThrow('fenced before staging')
  })

  test('invokes GridFS crash-boundary hooks and rejects when the staged file state changes before publication', async () => {
    const content = Buffer.alloc(300 * 1024, 0x33)
    const hash = digest(content)
    const hookCalls: string[] = []
    const hooked = new MongoPayloadStore(fixture.db, fixture.scope, {
      hooks: {
        afterGridFsUploaded: async () => {
          hookCalls.push('afterGridFsUploaded')
          await fixture.db
            .collection('overlayPayloads.files')
            .updateOne({ 'metadata.digest': hash }, { $set: { 'metadata.state': 'corrupted' } })
        },
        afterGridFsPublished: () => {
          hookCalls.push('afterGridFsPublished')
        },
        beforeReadyCas: () => {
          hookCalls.push('beforeReadyCas')
        }
      }
    })
    await expect(
      hooked.publish({
        kind: 'outbox-data',
        digest: hash,
        byteLength: String(content.byteLength),
        bytes: bytes(content, 64 * 1024)
      })
    ).rejects.toThrow('staged file was lost')
    expect(hookCalls).toEqual(['afterGridFsUploaded'])
  })

  test('invokes every GridFS crash-boundary hook in order on a successful large upload', async () => {
    const content = Buffer.alloc(300 * 1024, 0x44)
    const hash = digest(content)
    const hookCalls: string[] = []
    const hooked = new MongoPayloadStore(fixture.db, fixture.scope, {
      hooks: {
        afterGridFsUploaded: () => {
          hookCalls.push('afterGridFsUploaded')
        },
        afterGridFsPublished: () => {
          hookCalls.push('afterGridFsPublished')
        },
        beforeReadyCas: () => {
          hookCalls.push('beforeReadyCas')
        }
      }
    })
    await expect(
      hooked.publish({
        kind: 'outbox-data',
        digest: hash,
        byteLength: String(content.byteLength),
        bytes: bytes(content, 64 * 1024)
      })
    ).resolves.toMatchObject({ digest: hash })
    expect(hookCalls).toEqual(['afterGridFsUploaded', 'afterGridFsPublished', 'beforeReadyCas'])
  })

  test('abandonUpload does not delete a file a fenced winner already published', async () => {
    const content = Buffer.alloc(300 * 1024, 0x55)
    const hash = digest(content)
    const crashing = new MongoPayloadStore(fixture.db, fixture.scope, {
      hooks: {
        beforeReadyCas: async () => {
          const row = await fixture.db
            .collection('overlay_payloads')
            .findOne({ kind: 'outbox-data', digest: hash })
          await fixture.db
            .collection('overlayPayloads.files')
            .updateOne({ _id: row?.fileId }, { $set: { 'metadata.state': 'published' } })
          throw new Error('simulated crash after independent publish')
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
    ).rejects.toThrow('simulated crash after independent publish')
    const payloadRow = await fixture.db
      .collection('overlay_payloads')
      .findOne({ kind: 'outbox-data', digest: hash })
    expect(payloadRow?.state).toBe('uploading')
    expect(payloadRow?.fileId).toBeDefined()
    expect(
      await fixture.db.collection('overlayPayloads.files').countDocuments({ _id: payloadRow?.fileId })
    ).toBe(1)
  })

  test('a digest mismatch detected after spilling to GridFS retires the orphaned file', async () => {
    const content = Buffer.alloc(300 * 1024, 0x66)
    const wrongDigest = digest(Buffer.from('wrong-declared-digest'))
    await expect(
      store.publish({
        kind: 'outbox-data',
        digest: wrongDigest,
        byteLength: String(content.byteLength),
        bytes: bytes(content, 64 * 1024)
      })
    ).rejects.toThrow('digest or declared length mismatch')
    const row = await fixture.db
      .collection('overlay_payloads')
      .findOne({ kind: 'outbox-data', digest: wrongDigest })
    expect(row?.state).toBe('deleted')
    expect(row?.retiredFileId).toBeDefined()
    expect(
      await fixture.db.collection('overlayPayloads.files').countDocuments({ _id: row?.retiredFileId })
    ).toBe(0)
  })

  test('recovers a stale inline upload that has no GridFS file by marking it deleted', async () => {
    const now = new Date()
    const hash = digest(Buffer.from('stale-inline-upload'))
    const payloadId = `stale-inline-${hash}`
    await fixture.db.collection('overlay_payloads').insertOne({
      _id: payloadId,
      schemaVersion: 1,
      network: fixture.scope.network,
      genesisHash: fixture.scope.genesisHash,
      kind: 'outbox-data',
      digest: hash,
      byteLength: encodeMongoUint64('5'),
      state: 'uploading',
      guard: 'stale-owner',
      ownerNodeId: fixture.scope.nodeId,
      ownerId: 'stale-owner',
      fencingToken: encodeMongoUint64('0'),
      leaseUntil: new Date(Date.now() - 1000),
      createdAt: now,
      updatedAt: now
    })
    await store.recoverUploads()
    const row = await fixture.db.collection('overlay_payloads').findOne({ _id: payloadId })
    expect(row?.state).toBe('deleted')
    expect(row?.fileId).toBeUndefined()
    expect(row?.retiredFileId).toBeUndefined()
  })

  test('retires an orphaned GridFS file when a fresh publish reclaims an expired crashed reservation', async () => {
    const donorContent = Buffer.alloc(300 * 1024, 0xdd)
    const donorHash = digest(donorContent)
    await store.publish({
      kind: 'outbox-data',
      digest: donorHash,
      byteLength: String(donorContent.byteLength),
      bytes: bytes(donorContent, 64 * 1024)
    })
    const donorRow = await fixture.db
      .collection('overlay_payloads')
      .findOne({ kind: 'outbox-data', digest: donorHash })
    const donorFile = await fixture.db
      .collection('overlayPayloads.files')
      .findOne({ _id: donorRow?.fileId })
    expect(donorFile).not.toBeNull()

    const crashedContent = Buffer.from('crashed-reservation')
    const crashedHash = digest(crashedContent)
    const crashedOwner = (donorFile as { metadata: { ownerId: string } }).metadata.ownerId
    const crashedFence = (donorFile as { metadata: { fencingToken: string } }).metadata.fencingToken
    await fixture.db.collection('overlay_payloads').insertOne({
      _id: mongoRecordKey(mongoChainKey(fixture.scope), 'outbox-data', crashedHash),
      schemaVersion: 1,
      network: fixture.scope.network,
      genesisHash: fixture.scope.genesisHash,
      kind: 'outbox-data',
      digest: crashedHash,
      byteLength: encodeMongoUint64(String(crashedContent.byteLength)),
      state: 'uploading',
      guard: crashedOwner,
      ownerNodeId: fixture.scope.nodeId,
      ownerId: crashedOwner,
      fencingToken: crashedFence,
      fileId: donorFile?._id,
      leaseUntil: new Date(Date.now() - 1000),
      createdAt: new Date(),
      updatedAt: new Date()
    })
    await expect(
      store.publish({
        kind: 'outbox-data',
        digest: crashedHash,
        byteLength: String(crashedContent.byteLength),
        bytes: bytes(crashedContent)
      })
    ).resolves.toMatchObject({ digest: crashedHash })
    expect(
      await fixture.db.collection('overlayPayloads.files').countDocuments({ _id: donorFile?._id })
    ).toBe(0)
  })

  test('claimGarbage rejects immediately with the operation signal reason when already aborted', async () => {
    const controller = new AbortController()
    const reason = new Error('operation cancelled up front')
    controller.abort(reason)
    const session = fixture.client.startSession()
    await expect(
      store.claimGarbage(
        session,
        { kind: 'outbox-data', digest: digest(Buffer.from('pre-aborted')) },
        { signal: controller.signal }
      )
    ).rejects.toBe(reason)
    await session.endSession()
  })

  test('publishes normally with a live but never-aborted signal attached to a GridFS upload', async () => {
    const content = Buffer.alloc(300 * 1024, 0x77)
    const hash = digest(content)
    const controller = new AbortController()
    await expect(
      store.publish({
        kind: 'outbox-data',
        digest: hash,
        byteLength: String(content.byteLength),
        bytes: bytes(content, 64 * 1024),
        signal: controller.signal
      })
    ).resolves.toMatchObject({ digest: hash })
  })

  test('propagates a genuine iterator failure through raceAbort when a live signal is attached', async () => {
    const controller = new AbortController()
    const failing: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            throw new Error('genuine-iterator-failure')
          }
        }
      }
    }
    await expect(
      store.publish({
        kind: 'outbox-data',
        digest: digest(Buffer.from('genuine-iterator-failure-payload')),
        byteLength: '1',
        bytes: failing,
        signal: controller.signal
      })
    ).rejects.toThrow('genuine-iterator-failure')
    expect(controller.signal.aborted).toBe(false)
  })

  test('rejects a staged GridFS upload whose content was corrupted without changing its declared length', async () => {
    const content = Buffer.alloc(300 * 1024, 0xaa)
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
    const chunk = await fixture.db
      .collection('overlayPayloads.chunks')
      .findOne({ files_id: row?.fileId, n: 0 })
    const originalData = chunk?.data as Buffer | Binary
    const originalLength = Buffer.isBuffer(originalData) ? originalData.length : originalData.length()
    await fixture.db
      .collection('overlayPayloads.chunks')
      .updateOne({ _id: chunk?._id }, { $set: { data: Buffer.alloc(originalLength, 0xcc) } })
    await payloads.updateOne({ _id: row?._id }, [
      {
        $set: {
          state: 'uploading',
          leaseUntil: { $dateSubtract: { startDate: '$$NOW', unit: 'second', amount: 1 } }
        }
      }
    ])
    await store.recoverUploads()
    const recovered = await payloads.findOne({ _id: row?._id })
    expect(recovered?.state).toBe('deleted')
    expect(
      await fixture.db.collection('overlayPayloads.files').countDocuments({ _id: row?.fileId })
    ).toBe(0)
  })
})
