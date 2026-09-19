import { setTimeout as delay } from 'node:timers/promises'
import {
  MongoReadGuardConflictError,
  MongoReadGuards,
  type MongoReadGuard
} from '../../storage/mongo/MongoReadGuards.js'
import { bootstrapMongoOverlay, MongoCollectionNames } from '../../storage/mongo/MongoSchema.js'
import { createMongoReplicaFixture, type MongoReplicaFixture } from './MongoReplicaFixture.js'

describe('Mongo read guards', () => {
  let fixture: MongoReplicaFixture
  let guards: MongoReadGuards
  const key = 'missing.output.0'

  const absentRead = (): MongoReadGuard => ({
    scope: fixture.scope,
    key,
    expectedVersion: null
  })

  beforeAll(async () => {
    fixture = await createMongoReplicaFixture()
    await bootstrapMongoOverlay(fixture.db, fixture.scope)
    guards = new MongoReadGuards(fixture.db)
  }, 90000)

  afterAll(async () => {
    await fixture.close()
  })

  beforeEach(async () => {
    await fixture.db.collection(MongoCollectionNames.readGuards).deleteMany({})
    await guards.initialize(fixture.scope, key)
  })

  test('requires the sentinel before an active transaction can make an absent predicate', async () => {
    const session = fixture.client.startSession()
    await expect(guards.check(session, absentRead())).rejects.toThrow(
      'Mongo read guards require an active transaction'
    )
    await session.endSession()
  })

  test('reports a version mismatch as an explicit predicate conflict', async () => {
    const session = fixture.client.startSession()
    try {
      session.startTransaction()
      await guards.changeVersion(session, absentRead(), 'v1')
      await session.commitTransaction()
    } finally {
      await session.endSession()
    }

    const stale = fixture.client.startSession()
    try {
      stale.startTransaction()
      await expect(guards.check(stale, absentRead())).rejects.toBeInstanceOf(
        MongoReadGuardConflictError
      )
      await stale.abortTransaction()
    } finally {
      await stale.endSession()
    }
  })

  test('serializes a negative-read guard before a writer with an actual database write conflict', async () => {
    const reader = fixture.client.startSession()
    const writer = fixture.client.startSession()
    try {
      reader.startTransaction()
      await guards.check(reader, absentRead())
      writer.startTransaction()
      const competing = guards.changeVersion(writer, absentRead(), 'v1')
      await delay(25)
      await reader.commitTransaction()
      await expect(competing).rejects.toMatchObject({ code: 112 })
    } finally {
      await Promise.allSettled([reader.abortTransaction(), writer.abortTransaction()])
      await Promise.all([reader.endSession(), writer.endSession()])
    }
  })

  test('serializes a writer before a negative-read guard with an actual database write conflict', async () => {
    const writer = fixture.client.startSession()
    const reader = fixture.client.startSession()
    try {
      writer.startTransaction()
      await guards.changeVersion(writer, absentRead(), 'v1')
      reader.startTransaction()
      const competing = guards.check(reader, absentRead())
      await delay(25)
      await writer.commitTransaction()
      await expect(competing).rejects.toMatchObject({ code: 112 })
    } finally {
      await Promise.allSettled([reader.abortTransaction(), writer.abortTransaction()])
      await Promise.all([reader.endSession(), writer.endSession()])
    }
  })

  test('changeVersion conflicts when the persisted version no longer matches', async () => {
    const session = fixture.client.startSession()
    try {
      session.startTransaction()
      await guards.changeVersion(session, absentRead(), 'v1')
      await session.commitTransaction()
    } finally {
      await session.endSession()
    }
    const stale = fixture.client.startSession()
    try {
      stale.startTransaction()
      await expect(guards.changeVersion(stale, absentRead(), 'v2')).rejects.toBeInstanceOf(
        MongoReadGuardConflictError
      )
      await stale.abortTransaction()
    } finally {
      await stale.endSession()
    }
  })

  test('refuses a sentinel whose stored identity no longer matches the requested key', async () => {
    await fixture.db
      .collection(MongoCollectionNames.readGuards)
      .updateOne({ key }, { $set: { network: 'other-network' } })
    await expect(guards.initialize(fixture.scope, key)).rejects.toThrow(
      'Incompatible Mongo read guard sentinel'
    )
  })

  test('rejects malformed read inputs and bounded operation controls', async () => {
    await expect(guards.initialize(fixture.scope, '', { timeoutMS: 1 })).rejects.toThrow(
      'Invalid Mongo read guard key'
    )
    await expect(guards.initialize(fixture.scope, key, { timeoutMS: 30_001 })).rejects.toThrow(
      'Invalid Mongo read guard operation timeout'
    )
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(
      guards.initialize(fixture.scope, key, { signal: controller.signal })
    ).rejects.toThrow('cancelled')
  })
})
