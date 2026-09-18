import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Binary, type CommandStartedEvent, type Document } from 'mongodb'
import {
  admissionSemanticDigest,
  getAdmissionStorage,
  type AdmissionIdentity
} from '../../storage/AdmissionStorage.js'
import { bootstrapMongoOverlay, encodeMongoUint64, MongoCollectionNames, mongoRecordKey } from '../../storage/mongo/MongoSchema.js'
import { MongoTransactionRunner, type MongoTransactionRequest } from '../../storage/mongo/MongoTransactionRunner.js'
import { createMongoReplicaFixture, type MongoReplicaFixture } from './MongoReplicaFixture.js'

describe('Mongo transaction boundary on three data-bearing WiredTiger members', () => {
  let fixture: MongoReplicaFixture
  let runner: MongoTransactionRunner
  const runners: MongoTransactionRunner[] = []
  const commands: CommandStartedEvent[] = []

  function request(operationId = randomUUID()): MongoTransactionRequest {
    const identity: AdmissionIdentity = { scope: fixture.scope, txid: '22'.repeat(32), mode: 'live', contextDigest: '33'.repeat(32), topics: [{ topic: 'topic.a', policyId: 'v1' }] }
    const semanticDigest = admissionSemanticDigest(identity)
    return { identity, key: { scope: fixture.scope, operationId, semanticDigest }, receipt: { operationId, semanticDigest, durability: 'atomic-local', steak: '{ "topic.a" : { "outputsToAdmit": [0] } }\n', indexes: [{ target: 'lookup', state: 'pending' }], propagation: 'pending' } }
  }

  function operationId(input: MongoTransactionRequest): string {
    return mongoRecordKey('operation', fixture.scope.network, fixture.scope.genesisHash, fixture.scope.nodeId, input.key.operationId)
  }

  beforeAll(async () => {
    fixture = await createMongoReplicaFixture()
    await bootstrapMongoOverlay(fixture.db, fixture.scope)
    // Driver core calls retain their own retry policy. Disable it in this
    // fixture client so each failpoint corresponds to one runner commit attempt.
    const client = await fixture.connect({ monitorCommands: true, maxAdaptiveRetries: 0 })
    client.on('commandStarted', event => commands.push(event))
    fixture.db = client.db(fixture.db.databaseName)
    runner = new MongoTransactionRunner(client.db(fixture.db.databaseName), fixture.scope, { maxCommitAttempts: 2 })
    runners.push(runner)
  }, 90000)

  afterEach(async () => {
    await fixture.disableFailPoint()
  })

  afterAll(async () => {
    await Promise.all(runners.map(async item => await item.close()))
    await fixture.close()
  }, 60000)

  test('does not advertise an admission-storage capability', () => {
    expect(getAdmissionStorage(runner)).toBeUndefined()
  })

  test('rejects a committed row whose receipt is missing or identity-corrupt', async () => {
    const input = request()
    await runner.run(input, async () => {})
    const collection = fixture.db.collection(MongoCollectionNames.submissionOperations)
    await collection.updateOne({ _id: operationId(input) }, { $unset: { receipt: '' } })
    await expect(runner.reconcile(input.key)).rejects.toThrow('Committed Mongo operation has no receipt')
    await collection.updateOne(
      { _id: operationId(input) },
      { $set: { receipt: new Binary(Buffer.from(JSON.stringify({ ...input.receipt, operationId: randomUUID() }))) } }
    )
    await expect(runner.reconcile(input.key)).rejects.toThrow('Corrupt Mongo operation receipt identity')
  })

  test('cannot close while a trusted body is still running', async () => {
    const input = request()
    let resume!: () => void
    const barrier = new Promise<void>(resolve => { resume = resolve })
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const pending = runner.run(input, async () => { entered(); await barrier })
    await started
    await expect(runner.close()).rejects.toThrow('during a call')
    resume()
    expect((await pending).state).toBe('committed')
  })

  test('saves exact receipt with effects and replays it after runner restart', async () => {
    const input = request()
    let bodies = 0
    const result = await runner.run(input, async context => {
      bodies += 1
      await fixture.db.collection('test_effects').insertOne({ operationId: input.key.operationId, value: '18446744073709551615' }, context.options())
    })
    expect(result).toEqual({ state: 'committed', receipt: input.receipt })
    const replacement = new MongoTransactionRunner(fixture.db, fixture.scope)
    runners.push(replacement)
    expect(await replacement.run(input, async () => { bodies += 1 })).toEqual(result)
    expect(await replacement.reconcile(input.key)).toEqual(result)
    expect(bodies).toBe(1)
    const stored = await fixture.db.collection(MongoCollectionNames.submissionOperations).findOne({ _id: operationId(input) })
    expect(stored?.receipt).toBeInstanceOf(Binary)
    expect(await fixture.db.collection('test_effects').countDocuments({ operationId: input.key.operationId })).toBe(1)
  })

  test('rejects conflicting semantics and wrong scope without running a body', async () => {
    const input = request()
    await runner.run(input, async () => {})
    const changed = structuredClone(input)
    changed.identity.contextDigest = '44'.repeat(32)
    changed.key.semanticDigest = admissionSemanticDigest(changed.identity)
    changed.receipt.semanticDigest = changed.key.semanticDigest
    const body = jest.fn(async () => {})
    expect(await runner.run(changed, body)).toEqual({ state: 'rejected', code: 'digest-mismatch' })
    changed.key.scope.nodeId = 'different-node'
    await expect(runner.run(changed, body)).rejects.toThrow('scope')
    expect(body).not.toHaveBeenCalled()
  })

  test('aborts all body effects on an ordinary error and permits a later fresh attempt', async () => {
    const input = request()
    await expect(runner.run(input, async context => {
      await fixture.db.collection('test_effects').insertOne({ operationId: input.key.operationId }, context.options())
      throw new Error('decision failed')
    })).rejects.toThrow('decision failed')
    expect(await fixture.db.collection('test_effects').countDocuments({ operationId: input.key.operationId })).toBe(0)
    expect(await runner.reconcile(input.key)).toEqual({ state: 'aborted' })
    expect((await runner.run(input, async () => {})).state).toBe('committed')
  })

  test('a real transient server error permits a bounded fresh body and no partial effect', async () => {
    const input = request()
    let bodies = 0
    const result = await runner.run(input, async context => {
      bodies += 1
      if (bodies === 1) await fixture.failCommands({ failCommands: ['insert'], errorCode: 112, errorLabels: ['TransientTransactionError'] })
      await fixture.db.collection('test_effects').insertOne({ operationId: input.key.operationId, body: bodies }, context.options())
    })
    expect(result.state).toBe('committed')
    expect(bodies).toBe(2)
    expect(await fixture.db.collection('test_effects').find({ operationId: input.key.operationId }).toArray()).toEqual([expect.objectContaining({ body: 2 })])
  })

  test('unknown commit exhausts finitely, never reruns body, and resumes the same session and transaction number', async () => {
    const input = request()
    const start = commands.length
    let bodies = 0
    await fixture.failCommands({ failCommands: ['commitTransaction'], errorCode: 91, errorLabels: ['UnknownTransactionCommitResult'] }, 2)
    const uncertain = await runner.run(input, async context => {
      bodies += 1
      await fixture.db.collection('test_effects').insertOne({ operationId: input.key.operationId }, context.options())
    })
    expect(uncertain.state).toBe('pending')
    expect(await runner.run(input, async () => { bodies += 1 })).toEqual(uncertain)
    await fixture.disableFailPoint()
    const result = await runner.reconcile(input.key, uncertain.state === 'pending' ? uncertain.attemptId : undefined)
    expect(result).toEqual({ state: 'committed', receipt: input.receipt })
    expect(bodies).toBe(1)
    const commits = commands.slice(start).filter(event => event.commandName === 'commitTransaction')
    expect(commits).toHaveLength(3)
    expect(new Set(commits.map(event => `${String(event.command.lsid.id)}:${String(event.command.txnNumber)}`)).size).toBe(1)
  }, 15000)

  test('unknown label wins when a server error also carries a transient label', async () => {
    const input = request()
    let bodies = 0
    await fixture.failCommands({ failCommands: ['commitTransaction'], errorCode: 91, errorLabels: ['UnknownTransactionCommitResult', 'TransientTransactionError'] }, 2)
    const result = await runner.run(input, async () => { bodies += 1 })
    expect(result.state).toBe('pending')
    expect(bodies).toBe(1)
    await fixture.disableFailPoint()
    expect((await runner.reconcile(input.key)).state).toBe('committed')
  }, 15000)

  test('missing operation is pending, and expired orphan abort requires a successful majority row write', async () => {
    const input = request()
    expect(await runner.reconcile(input.key, 'unknown-attempt')).toEqual({ state: 'pending', attemptId: 'unknown-attempt' })
    const attemptId = randomUUID()
    await fixture.db.collection<Document & { _id: string }>(MongoCollectionNames.submissionOperations).insertOne({ _id: operationId(input), schemaVersion: 1, ...fixture.scope, operationId: input.key.operationId, semanticDigest: input.key.semanticDigest, txid: input.identity.txid, state: 'pending', attemptId, leaseOwner: randomUUID(), leaseToken: encodeMongoUint64('9007199254740993'), leaseUntil: new Date(0), guard: randomUUID(), createdAt: new Date(), updatedAt: new Date() })
    expect(await runner.reconcile(input.key, attemptId)).toEqual({ state: 'aborted' })
    const row = await fixture.db.collection(MongoCollectionNames.submissionOperations).findOne({ _id: operationId(input) })
    expect(row?.state).toBe('aborted')
    expect((await runner.run(input, async () => {})).state).toBe('committed')
  })

  test('concurrent same-key calls do not fork the body', async () => {
    const input = request()
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    let resume!: () => void
    const barrier = new Promise<void>(resolve => { resume = resolve })
    let bodies = 0
    const first = runner.run(input, async () => { bodies += 1; entered(); await barrier })
    await started
    const second = await runner.run(input, async () => { bodies += 1 })
    expect(second.state).toBe('pending')
    expect(await runner.reconcile(input.key)).toEqual(second)
    resume()
    expect((await first).state).toBe('committed')
    expect(bodies).toBe(1)
  })

  test('cancellation fences subsequent operations and rolls back the body', async () => {
    const input = request()
    const controller = new AbortController()
    let lateOptions: (() => unknown) | undefined
    await expect(runner.run(input, async context => {
      lateOptions = context.options
      await fixture.db.collection('test_effects').insertOne({ operationId: input.key.operationId }, context.options())
      controller.abort(new Error('cancelled fixture'))
      await delay(5)
      context.options()
    }, { signal: controller.signal })).rejects.toThrow('cancelled fixture')
    expect(() => lateOptions?.()).toThrow('no longer active')
    expect(await fixture.db.collection('test_effects').countDocuments({ operationId: input.key.operationId })).toBe(0)
  })

  test('snapshots caller identity before asynchronous storage work', async () => {
    const input = structuredClone(request())
    const original = structuredClone(input)
    const pending = runner.run(input, async () => {})
    input.key.operationId = 'mutated-operation'
    input.identity.txid = '99'.repeat(32)
    input.key.scope.nodeId = 'mutated-node'
    input.receipt.steak = '{}'
    expect(await pending).toEqual({ state: 'committed', receipt: original.receipt })
    const row = await fixture.db.collection(MongoCollectionNames.submissionOperations).findOne({ _id: operationId(original) })
    expect(row).toMatchObject({ operationId: original.key.operationId, txid: original.identity.txid, nodeId: fixture.scope.nodeId })
  })

  test('the retained-session capacity also bounds simultaneous different-key claims', async () => {
    const limited = new MongoTransactionRunner(fixture.db, fixture.scope, { maxRetainedSessions: 1 })
    runners.push(limited)
    let resume!: () => void
    const barrier = new Promise<void>(resolve => { resume = resolve })
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    let bodies = 0
    const body = async () => { bodies += 1; entered(); await barrier }
    const calls = [limited.run(request(), body), limited.run(request(), body)]
    const rejected = Promise.any(calls.map(async call => {
      try { await call; throw new Error('Unexpected success before barrier') } catch (error) { return error }
    }))
    await started
    expect(await rejected).toEqual(expect.objectContaining({ message: 'Mongo unresolved transaction capacity reached' }))
    expect(bodies).toBe(1)
    resume()
    const results = await Promise.allSettled(calls)
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  })

  test('server transient failures stop at the configured body budget', async () => {
    const input = request()
    let bodies = 0
    await expect(runner.run(input, async context => {
      bodies += 1
      await fixture.failCommands({ failCommands: ['insert'], errorCode: 112, errorLabels: ['TransientTransactionError'] })
      await fixture.db.collection('test_effects').insertOne({ operationId: input.key.operationId }, context.options())
    })).rejects.toMatchObject({ code: 112 })
    expect(bodies).toBe(3)
    expect(await runner.reconcile(input.key)).toEqual({ state: 'aborted' })
  })

  test('write CSOT bounds a server-blocked body and pre-cancellation starts no body', async () => {
    const input = request()
    const controller = new AbortController()
    controller.abort(new Error('before claim'))
    const body = jest.fn(async () => {})
    await expect(runner.run(input, body, { signal: controller.signal })).rejects.toThrow('before claim')
    expect(body).not.toHaveBeenCalled()
    const started = performance.now()
    await expect(runner.run(input, async context => {
      await fixture.failCommands({ failCommands: ['insert'], blockConnection: true, blockTimeMS: 500 })
      await fixture.db.collection('test_effects').insertOne({ operationId: input.key.operationId }, context.options())
    }, { timeoutMS: 150 })).rejects.toThrow()
    expect(performance.now() - started).toBeLessThan(2500)
    expect(await fixture.db.collection('test_effects').countDocuments({ operationId: input.key.operationId })).toBe(0)
  })

  test('expired orphan CAS wins against a stale transaction snapshot', async () => {
    const input = request()
    const attemptId = randomUUID()
    const collection = fixture.db.collection<Document & { _id: string }>(MongoCollectionNames.submissionOperations)
    await collection.insertOne({ _id: operationId(input), schemaVersion: 1, ...fixture.scope, operationId: input.key.operationId, semanticDigest: input.key.semanticDigest, txid: input.identity.txid, state: 'pending', attemptId, leaseOwner: randomUUID(), leaseToken: encodeMongoUint64('1'), leaseUntil: new Date(0), guard: randomUUID(), createdAt: new Date(), updatedAt: new Date() })
    const session = fixture.db.client.startSession()
    try {
      session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority', j: true } })
      expect((await collection.findOne({ _id: operationId(input) }, { session }))?.state).toBe('pending')
      expect(await runner.reconcile(input.key, attemptId)).toEqual({ state: 'aborted' })
      await expect(collection.updateOne({ _id: operationId(input), state: 'pending', attemptId }, { $set: { guard: randomUUID() } }, { session, timeoutMS: 1000 })).rejects.toMatchObject({ code: 112 })
    } finally {
      if (session.inTransaction()) await session.abortTransaction()
      await session.endSession()
    }
  })

  test('a committed receipt wins against overlapping expired-orphan reconciliation', async () => {
    const input = request()
    const attemptId = randomUUID()
    const collection = fixture.db.collection<Document & { _id: string }>(MongoCollectionNames.submissionOperations)
    await collection.insertOne({ _id: operationId(input), schemaVersion: 1, ...fixture.scope, operationId: input.key.operationId, semanticDigest: input.key.semanticDigest, txid: input.identity.txid, state: 'pending', attemptId, leaseOwner: randomUUID(), leaseToken: encodeMongoUint64('1'), leaseUntil: new Date(0), guard: randomUUID(), createdAt: new Date(), updatedAt: new Date() })
    const session = fixture.db.client.startSession()
    let listener: ((event: CommandStartedEvent) => void) | undefined
    try {
      session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority', j: true } })
      await collection.updateOne({ _id: operationId(input), state: 'pending', attemptId }, { $set: { guard: randomUUID(), state: 'committed', receipt: new Binary(Buffer.from(JSON.stringify(input.receipt))) } }, { session })
      const attemptedCas = new Promise<void>(resolve => {
        listener = event => {
          if (event.commandName === 'findAndModify' && event.command.query.attemptId === attemptId) resolve()
        }
        fixture.db.client.on('commandStarted', listener)
      })
      const reconciliation = runner.reconcile(input.key, attemptId)
      await attemptedCas
      await session.commitTransaction({ timeoutMS: 5000 })
      expect(await reconciliation).toEqual({ state: 'committed', receipt: input.receipt })
    } finally {
      if (listener !== undefined) fixture.db.client.off('commandStarted', listener)
      if (session.inTransaction()) await session.abortTransaction()
      await session.endSession()
    }
  })

  test('actual primary stepdown aborts the old body and commits a fresh transaction', async () => {
    const input = request()
    let bodies = 0
    const result = await runner.run(input, async context => {
      bodies += 1
      if (bodies === 1) await fixture.stepDown()
      await fixture.db.collection('test_effects').insertOne({ operationId: input.key.operationId, body: bodies }, context.options())
    }, { timeoutMS: 40000 })
    expect(result.state).toBe('committed')
    expect(bodies).toBe(2)
  }, 60000)

  test('majority receipt and effects survive an actual SIGKILL of the acknowledged primary', async () => {
    const input = request()
    expect((await runner.run(input, async context => {
      await fixture.db.collection('test_effects').insertOne({ operationId: input.key.operationId }, context.options())
    }, { timeoutMS: 15000 })).state).toBe('committed')
    const election = await fixture.killPrimary()
    expect(election.current).not.toBe(election.previous)
    const restarted = new MongoTransactionRunner(fixture.db, fixture.scope)
    runners.push(restarted)
    expect(await restarted.reconcile(input.key, undefined, { timeoutMS: 15000 })).toEqual({ state: 'committed', receipt: input.receipt })
    expect(await fixture.db.collection('test_effects').countDocuments({ operationId: input.key.operationId })).toBe(1)
  }, 60000)
})
