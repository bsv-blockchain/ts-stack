import { randomUUID } from 'node:crypto'
import type { ClientSession, Db } from 'mongodb'
import {
  admissionSemanticDigest,
  type AdmissionIdentity,
  type StorageScope
} from '../../storage/AdmissionStorage.js'
import {
  MongoPayloadStore,
  type MongoPayloadStoreOptions
} from '../../storage/mongo/MongoPayloadStore.js'
import {
  MongoReadGuardConflictError,
  MongoReadGuards
} from '../../storage/mongo/MongoReadGuards.js'
import {
  bootstrapMongoOverlay,
  mongoChainKey,
  mongoNodeKey,
  mongoRecordKey,
  type MongoChainScope
} from '../../storage/mongo/MongoSchema.js'
import {
  MongoTransactionRunner,
  type MongoTransactionRequest
} from '../../storage/mongo/MongoTransactionRunner.js'

const scope: StorageScope = {
  network: 'testnet',
  genesisHash: '11'.repeat(32),
  nodeId: 's02-node-a'
}

const dummyDb = { collection: () => ({}) } as unknown as Db

const fakeSession = (inTransaction = true): ClientSession =>
  ({ inTransaction: () => inTransaction }) as ClientSession

const digest = 'aa'.repeat(32)

function payloadStore(db: Db = dummyDb, options?: MongoPayloadStoreOptions) {
  return new MongoPayloadStore(db, scope, options)
}

function identity(): AdmissionIdentity {
  return {
    scope,
    txid: '22'.repeat(32),
    mode: 'live',
    contextDigest: '33'.repeat(32),
    topics: [{ topic: 'topic.a', policyId: 'v1' }]
  }
}

function request(): MongoTransactionRequest {
  const value = identity()
  const semanticDigest = admissionSemanticDigest(value)
  const operationId = randomUUID()
  return {
    identity: value,
    key: { scope, operationId, semanticDigest },
    receipt: {
      operationId,
      semanticDigest,
      durability: 'atomic-local',
      steak: '{"topic.a":{"outputsToAdmit":[0]}}',
      indexes: [{ target: 'lookup', state: 'pending' }],
      propagation: 'pending'
    }
  }
}

describe('Mongo schema key and topology guards', () => {
  test('rejects empty, oversized, and too-many-part record keys', () => {
    expect(() => mongoRecordKey()).toThrow('Invalid Mongo record key')
    expect(() => mongoRecordKey(...Array.from({ length: 33 }, (_, index) => `p${index}`))).toThrow(
      'Invalid Mongo record key'
    )
    expect(() =>
      mongoRecordKey('a'.repeat(1024), 'b'.repeat(1024), 'c'.repeat(1024), 'd'.repeat(1024))
    ).toThrow('Mongo record key is too large')
  })

  test('rejects invalid chain and node scopes', () => {
    expect(() => mongoChainKey(null as unknown as MongoChainScope)).toThrow(
      'Invalid Mongo chain scope'
    )
    expect(() => mongoChainKey({ network: 'test', genesisHash: 'zz'.repeat(32) })).toThrow(
      'Invalid Mongo chain scope'
    )
    expect(() => mongoChainKey({ network: 'n'.repeat(129), genesisHash: 'aa'.repeat(32) })).toThrow(
      'Invalid Mongo chain scope'
    )
    expect(() => mongoChainKey({ network: '\ud800', genesisHash: 'aa'.repeat(32) })).toThrow(
      'Invalid Mongo record key component'
    )
    expect(() => mongoNodeKey({ ...scope, nodeId: '' })).toThrow(
      'Invalid Mongo record key component'
    )
    expect(() => mongoNodeKey({ ...scope, nodeId: 'x\u0000y' })).toThrow(
      'Invalid Mongo record key component'
    )
    expect(() => mongoNodeKey({ ...scope, nodeId: 'n'.repeat(1025) })).toThrow(
      'Invalid Mongo record key component'
    )
  })

  test('requires an unsharded writable replica-set primary before schema work', async () => {
    const command = jest.fn()
    const db = { command } as unknown as Db
    command.mockResolvedValueOnce({ msg: 'isdbgrid', setName: 'rs0', isWritablePrimary: true })
    await expect(bootstrapMongoOverlay(db, scope)).rejects.toThrow('unsharded replica set')
    command.mockResolvedValueOnce({ setName: '', isWritablePrimary: true })
    await expect(bootstrapMongoOverlay(db, scope)).rejects.toThrow('unsharded replica set')
    command.mockResolvedValueOnce({ setName: 'rs0', isWritablePrimary: false })
    await expect(bootstrapMongoOverlay(db, scope)).rejects.toThrow('writable primary')
    command.mockResolvedValueOnce({ isWritablePrimary: true })
    await expect(bootstrapMongoOverlay(db, scope)).rejects.toThrow('unsharded replica set')
  })
})

describe('Mongo payload store input and operation guards', () => {
  test('rejects constructor bounds that cannot be represented safely', () => {
    expect(() => payloadStore(dummyDb, { inlineCeilingBytes: 0 })).toThrow('inline ceiling')
    expect(() => payloadStore(dummyDb, { inlineCeilingBytes: 1024 * 1024 + 1 })).toThrow(
      'inline ceiling'
    )
    expect(() => payloadStore(dummyDb, { inlineCeilingBytes: 1.5 })).toThrow('inline ceiling')
    expect(() => payloadStore(dummyDb, { gridFsChunkBytes: 0 })).toThrow('GridFS chunk size')
    expect(() => payloadStore(dummyDb, { gridFsChunkBytes: 255 * 1024 + 1 })).toThrow(
      'GridFS chunk size'
    )
    expect(() => payloadStore(dummyDb, { uploadLeaseMs: 0 })).toThrow('upload lease')
    expect(() => payloadStore(dummyDb, { maxPayloadBytes: BigInt(0) })).toThrow(
      'payload byte bound'
    )
    expect(() => payloadStore(dummyDb, { maxPayloadBytes: BigInt(1) << BigInt(64) })).toThrow(
      'payload byte bound'
    )
  })

  test('rejects malformed publish inputs before touching storage', async () => {
    const store = payloadStore()
    const bytes = async function* (): AsyncIterable<Uint8Array> {
      yield new Uint8Array([1])
    }
    await expect(
      store.publish({ kind: 'outbox-data', digest: 'zz', byteLength: '1', bytes: bytes() })
    ).rejects.toThrow('Invalid Mongo payload digest')
    await expect(
      store.publish({ kind: 'outbox-data', digest, byteLength: '01', bytes: bytes() })
    ).rejects.toThrow('Invalid Mongo payload byte length')
    await expect(
      store.publish({
        kind: 'outbox-data',
        digest,
        byteLength: '2',
        bytes: bytes(),
        txid: 'bb'.repeat(32)
      })
    ).rejects.toThrow('Invalid Mongo raw transaction id')
    await expect(
      store.publish({
        kind: 'raw-transaction',
        digest,
        byteLength: '1',
        bytes: bytes(),
        txid: 'zz'
      })
    ).rejects.toThrow('Invalid Mongo raw transaction id')
    const bounded = payloadStore(dummyDb, { maxPayloadBytes: BigInt(1) })
    await expect(
      bounded.publish({ kind: 'outbox-data', digest, byteLength: '2', bytes: bytes() })
    ).rejects.toThrow('exceeds configured byte bound')
  })

  test('rejects cancelled or unbounded payload operations before a database write', async () => {
    const store = payloadStore()
    const controller = new AbortController()
    controller.abort(new Error('cancelled publish'))
    await expect(
      store.publish({
        kind: 'outbox-data',
        digest,
        byteLength: '1',
        bytes: (async function* () {
          yield new Uint8Array([1])
        })(),
        signal: controller.signal
      })
    ).rejects.toThrow('cancelled publish')
    const silent = new AbortController()
    Object.defineProperty(silent.signal, 'aborted', { get: () => true })
    Object.defineProperty(silent.signal, 'reason', { get: () => undefined })
    await expect(
      store.publish({
        kind: 'outbox-data',
        digest,
        byteLength: '1',
        bytes: (async function* () {
          yield new Uint8Array([1])
        })(),
        signal: silent.signal
      })
    ).rejects.toThrow('Mongo payload upload aborted')
    const session = fakeSession()
    const reference = {
      scope,
      payload: { kind: 'outbox-data' as const, digest },
      ownerKind: 'output' as const,
      ownerId: 'owner',
      slot: '0'
    }
    await expect(store.addReference(session, reference, { timeoutMS: 0 })).rejects.toThrow(
      'Invalid Mongo payload operation timeout'
    )
    await expect(store.addReference(session, reference, { timeoutMS: 1.5 })).rejects.toThrow(
      'Invalid Mongo payload operation timeout'
    )
    const aborted = new AbortController()
    aborted.abort(new Error('cancelled reference'))
    await expect(
      store.addReference(session, reference, { signal: aborted.signal })
    ).rejects.toThrow('cancelled reference')
    await expect(store.addReference(fakeSession(false), reference)).rejects.toThrow(
      'active transaction'
    )
    await expect(store.claimGarbage(fakeSession(false), reference.payload)).rejects.toThrow(
      'active transaction'
    )
  })

  test('rejects payload references that violate owner, pin, or scope rules', async () => {
    const store = payloadStore()
    const session = fakeSession()
    const payload = { kind: 'outbox-data' as const, digest }
    await expect(
      store.addReference(session, {
        scope: { ...scope, nodeId: 'other' },
        payload,
        ownerKind: 'output',
        ownerId: 'owner',
        slot: '0'
      })
    ).rejects.toThrow('does not match this store')
    await expect(
      store.addReference(session, {
        scope,
        payload,
        ownerKind: 'output',
        ownerId: '',
        slot: '0'
      })
    ).rejects.toThrow('Invalid Mongo payload reference owner')
    await expect(
      store.addReference(session, {
        scope,
        payload,
        ownerKind: 'output',
        ownerId: 'owner',
        slot: ''
      })
    ).rejects.toThrow('Invalid Mongo payload reference owner')
    await expect(
      store.addReference(session, {
        scope,
        payload,
        ownerKind: 'pin',
        ownerId: 'owner',
        slot: '0'
      })
    ).rejects.toThrow('expiry is valid only for explicit pins')
    await expect(
      store.addReference(session, {
        scope,
        payload,
        ownerKind: 'output',
        ownerId: 'owner',
        slot: '0',
        expiresAt: new Date(Date.now() + 60_000)
      })
    ).rejects.toThrow('expiry is valid only for explicit pins')
    const frozen = payloadStore(dummyDb, { now: () => new Date('2020-01-01T00:00:00.000Z') })
    await expect(
      frozen.addReference(session, {
        scope,
        payload,
        ownerKind: 'pin',
        ownerId: 'owner',
        slot: '0',
        expiresAt: new Date('2019-12-31T00:00:00.000Z')
      })
    ).rejects.toThrow('pin must be unexpired')
  })

  test('rejects malformed manifest components before writing', async () => {
    const store = payloadStore()
    const session = fakeSession()
    const payload = { kind: 'raw-transaction' as const, digest }
    await expect(
      store.addManifestComponent(session, {
        manifestId: '',
        ordinal: '0',
        kind: 'raw-transaction',
        payload
      })
    ).rejects.toThrow('Invalid Mongo manifest component')
    await expect(
      store.addManifestComponent(session, {
        manifestId: 'manifest',
        ordinal: '01',
        kind: 'raw-transaction',
        payload
      })
    ).rejects.toThrow('Invalid Mongo manifest component')
    await expect(
      store.addManifestComponent(session, {
        manifestId: 'manifest',
        ordinal: '0',
        kind: 'outbox-data',
        payload
      })
    ).rejects.toThrow('kind mismatch')
    await expect(
      store.addManifestComponent(fakeSession(false), {
        manifestId: 'manifest',
        ordinal: '0',
        kind: 'raw-transaction',
        payload
      })
    ).rejects.toThrow('active transaction')
  })

  test('treats a missing deleting row as an already-finished GC claim', async () => {
    const store = payloadStore({
      collection: () => ({
        findOne: async () => null,
        find: () => ({ toArray: async () => [] }),
        updateOne: async () => ({ modifiedCount: 0 })
      })
    } as unknown as Db)
    expect(await store.finishGarbage({ kind: 'outbox-data', digest })).toBe(false)
    await expect(store.recoverUploads()).resolves.toBeUndefined()
  })

  test('idempotent and conflicting reference slots are decided from the existing row', async () => {
    const payloadId = mongoRecordKey(mongoChainKey(scope), 'outbox-data', digest)
    const refs: { findOne: jest.Mock } = {
      findOne: jest.fn()
    }
    const payloads = {
      updateOne: jest.fn(async () => ({ matchedCount: 0 }))
    }
    const db = {
      collection: (name: string) => (name.includes('reference') ? refs : payloads)
    } as unknown as Db
    const store = payloadStore(db)
    const session = fakeSession()
    const reference = {
      scope,
      payload: { kind: 'outbox-data' as const, digest },
      ownerKind: 'output' as const,
      ownerId: 'owner',
      slot: '0'
    }
    refs.findOne.mockResolvedValueOnce({ payloadId })
    await expect(store.addReference(session, reference)).resolves.toBeUndefined()
    refs.findOne.mockResolvedValueOnce({ payloadId: 'other' })
    await expect(store.addReference(session, reference)).rejects.toThrow(
      'already names different content'
    )
    refs.findOne.mockResolvedValueOnce(null)
    await expect(store.addReference(session, reference)).rejects.toThrow('not ready for reference')
  })

  test('release requires the named reference row to exist', async () => {
    const store = payloadStore({
      collection: () => ({
        deleteOne: async () => ({ deletedCount: 0 })
      })
    } as unknown as Db)
    await expect(
      store.releaseReference(fakeSession(), {
        scope,
        payload: { kind: 'outbox-data', digest },
        ownerKind: 'output',
        ownerId: 'owner',
        slot: '0'
      })
    ).rejects.toThrow('does not exist')
  })
})

describe('Mongo read guard input and sentinel guards', () => {
  const key = 'output.0'

  test('swallows a duplicate-key race and then requires a matching sentinel', async () => {
    const collection = {
      updateOne: jest.fn(async () => {
        throw { code: 11000 }
      }),
      findOne: jest.fn()
    }
    const guards = new MongoReadGuards({ collection: () => collection } as unknown as Db)
    collection.findOne.mockResolvedValueOnce({
      network: scope.network,
      genesisHash: scope.genesisHash,
      nodeId: scope.nodeId,
      key
    })
    await expect(guards.initialize(scope, key)).resolves.toBeUndefined()
    collection.findOne.mockResolvedValueOnce(null)
    await expect(guards.initialize(scope, key)).rejects.toThrow(
      'Incompatible Mongo read guard sentinel'
    )
    collection.updateOne.mockRejectedValueOnce({ code: 42 })
    await expect(guards.initialize(scope, key)).rejects.toMatchObject({ code: 42 })
  })

  test('rejects an existing sentinel whose identity drifted', async () => {
    const collection = {
      updateOne: jest.fn(async () => ({})),
      findOne: jest.fn(async () => ({
        network: 'other',
        genesisHash: scope.genesisHash,
        nodeId: scope.nodeId,
        key
      }))
    }
    const guards = new MongoReadGuards({ collection: () => collection } as unknown as Db)
    await expect(guards.initialize(scope, key)).rejects.toThrow(
      'Incompatible Mongo read guard sentinel'
    )
  })

  test('check and changeVersion require a live transaction and matching version', async () => {
    const collection = {
      updateOne: jest.fn()
    }
    const guards = new MongoReadGuards({ collection: () => collection } as unknown as Db)
    const read = { scope, key, expectedVersion: null }
    await expect(guards.check(fakeSession(false), read)).rejects.toThrow('active transaction')
    await expect(guards.changeVersion(fakeSession(false), read, 'v1')).rejects.toThrow(
      'active transaction'
    )
    collection.updateOne.mockResolvedValueOnce({ matchedCount: 0 })
    await expect(guards.check(fakeSession(), read)).rejects.toBeInstanceOf(
      MongoReadGuardConflictError
    )
    collection.updateOne.mockResolvedValueOnce({ matchedCount: 0 })
    await expect(guards.changeVersion(fakeSession(), read, 'v1')).rejects.toBeInstanceOf(
      MongoReadGuardConflictError
    )
    collection.updateOne.mockResolvedValue({ matchedCount: 1 })
    await expect(guards.check(fakeSession(), read, { timeoutMS: 1 })).resolves.toBeUndefined()
    await expect(guards.changeVersion(fakeSession(), read, 'v1')).resolves.toBeUndefined()
    await expect(guards.changeVersion(fakeSession(), read, 'v'.repeat(257))).rejects.toThrow(
      'Invalid Mongo read guard version'
    )
    await expect(
      guards.check(fakeSession(), { ...read, expectedVersion: 'bad\u0000version' })
    ).rejects.toThrow('Invalid Mongo read guard version')
    await expect(
      guards.check(fakeSession(), { ...read, expectedVersion: '\ud800' })
    ).rejects.toThrow('Invalid Mongo read guard version')
  })

  test('rejects cancelled operations and non-integer timeouts', async () => {
    const guards = new MongoReadGuards(dummyDb)
    await expect(guards.initialize(scope, key, { timeoutMS: 0 })).rejects.toThrow(
      'Invalid Mongo read guard operation timeout'
    )
    await expect(guards.initialize(scope, key, { timeoutMS: 1.5 })).rejects.toThrow(
      'Invalid Mongo read guard operation timeout'
    )
    const controller = new AbortController()
    Object.defineProperty(controller.signal, 'aborted', { get: () => true })
    Object.defineProperty(controller.signal, 'reason', { get: () => undefined })
    await expect(guards.initialize(scope, key, { signal: controller.signal })).rejects.toThrow(
      'Mongo read guard operation aborted'
    )
  })
})

describe('Mongo transaction runner input and budget guards', () => {
  test('rejects constructor and call bounds that are not safe integers in range', () => {
    expect(() => new MongoTransactionRunner(dummyDb, scope, { maxBodyAttempts: 0 })).toThrow(
      'Invalid Mongo transaction bound'
    )
    expect(() => new MongoTransactionRunner(dummyDb, scope, { maxBodyAttempts: 11 })).toThrow(
      'Invalid Mongo transaction bound'
    )
    expect(() => new MongoTransactionRunner(dummyDb, scope, { maxCommitAttempts: 1.5 })).toThrow(
      'Invalid Mongo transaction bound'
    )
    expect(() => new MongoTransactionRunner(dummyDb, scope, { leaseMS: 0 })).toThrow(
      'Invalid Mongo transaction bound'
    )
    expect(() => new MongoTransactionRunner(dummyDb, scope, { leaseMS: 60_001 })).toThrow(
      'Invalid Mongo transaction bound'
    )
    expect(() => new MongoTransactionRunner(dummyDb, scope, { maxRetainedSessions: 0 })).toThrow(
      'Invalid Mongo transaction bound'
    )
    expect(() => new MongoTransactionRunner(dummyDb, scope, { maxRetainedSessions: 1025 })).toThrow(
      'Invalid Mongo transaction bound'
    )
  })

  test('rejects malformed receipts, identities, and closed runners before storage work', async () => {
    const runner = new MongoTransactionRunner(dummyDb, scope)
    const body = jest.fn(async () => {})
    const valid = request()
    const badDurability = structuredClone(valid)
    ;(badDurability.receipt as { durability: string }).durability = 'best-effort'
    await expect(runner.run(badDurability, body)).rejects.toThrow(
      'Invalid Mongo transaction receipt'
    )
    const badSteak = structuredClone(valid)
    badSteak.receipt.steak = '{'
    await expect(runner.run(badSteak, body)).rejects.toThrow()
    const illFormed = structuredClone(valid)
    illFormed.receipt.steak = '\ud800'
    await expect(runner.run(illFormed, body)).rejects.toThrow('Invalid Mongo transaction receipt')
    const badIndex = structuredClone(valid)
    badIndex.receipt.indexes = [{ target: '', state: 'pending' }]
    await expect(runner.run(badIndex, body)).rejects.toThrow('Invalid Mongo transaction receipt')
    const badState = structuredClone(valid)
    badState.receipt.indexes = [{ target: 'lookup', state: 'missing' as 'pending' }]
    await expect(runner.run(badState, body)).rejects.toThrow('Invalid Mongo transaction receipt')
    const badPropagation = structuredClone(valid)
    ;(badPropagation.receipt as { propagation: string }).propagation = 'done'
    await expect(runner.run(badPropagation, body)).rejects.toThrow(
      'Invalid Mongo transaction receipt'
    )
    const huge = structuredClone(valid)
    huge.receipt.steak = JSON.stringify({ padding: 'x'.repeat(1_048_576) })
    await expect(runner.run(huge, body)).rejects.toThrow('too large')
    const mismatchedPlan = structuredClone(valid)
    mismatchedPlan.receipt.operationId = randomUUID()
    expect(await runner.run(mismatchedPlan, body)).toEqual({
      state: 'rejected',
      code: 'invalid-plan'
    })
    const mismatchedDigest = structuredClone(valid)
    mismatchedDigest.identity.contextDigest = '44'.repeat(32)
    expect(await runner.run(mismatchedDigest, body)).toEqual({
      state: 'rejected',
      code: 'digest-mismatch'
    })
    await expect(runner.run(valid, body, { timeoutMS: 0 })).rejects.toThrow(
      'Invalid Mongo transaction bound'
    )
    await expect(runner.run(valid, body, { timeoutMS: 50_001 })).rejects.toThrow(
      'Invalid Mongo transaction bound'
    )
    await runner.close()
    await expect(runner.run(valid, body)).rejects.toThrow('runner is closed')
    expect(body).not.toHaveBeenCalled()
  })
})
