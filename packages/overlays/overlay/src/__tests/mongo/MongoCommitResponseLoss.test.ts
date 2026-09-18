import { randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import { admissionSemanticDigest, type AdmissionIdentity } from '../../storage/AdmissionStorage.js'
import {
  MongoTransactionRunner,
  type MongoTransactionRequest
} from '../../storage/mongo/MongoTransactionRunner.js'
import { bootstrapMongoOverlay } from '../../storage/mongo/MongoSchema.js'
import { MongoCommitResponseProxy } from './MongoCommitResponseProxy.js'
import { createMongoReplicaFixture, type MongoReplicaFixture } from './MongoReplicaFixture.js'

describe('Mongo commit response loss', () => {
  let fixture: MongoReplicaFixture

  function request(operationId = randomUUID()): MongoTransactionRequest {
    const identity: AdmissionIdentity = {
      scope: fixture.scope,
      txid: '52'.repeat(32),
      mode: 'live',
      contextDigest: '63'.repeat(32),
      topics: [{ topic: 'commit.loss', policyId: 'v1' }]
    }
    const semanticDigest = admissionSemanticDigest(identity)
    return {
      identity,
      key: { scope: fixture.scope, operationId, semanticDigest },
      receipt: {
        operationId,
        semanticDigest,
        durability: 'atomic-local',
        steak: '{"commit.loss":{"outputsToAdmit":[0]}}',
        indexes: [{ target: 'lookup', state: 'pending' }],
        propagation: 'pending'
      }
    }
  }

  async function lostReplyClient(): Promise<{
    client: MongoClient
    proxy: MongoCommitResponseProxy
  }> {
    const hello = await fixture.db.admin().command({ hello: 1 })
    if (typeof hello.primary !== 'string') throw new Error('Replica fixture has no primary')
    const proxy = await MongoCommitResponseProxy.create(hello.primary)
    const client = new MongoClient(proxy.uri, {
      directConnection: true,
      maxAdaptiveRetries: 0,
      retryReads: false,
      retryWrites: false,
      serverSelectionTimeoutMS: 15000,
      connectTimeoutMS: 5000,
      maxPoolSize: 2,
      writeConcern: { w: 'majority', j: true }
    })
    await client.connect()
    return { client, proxy }
  }

  beforeAll(async () => {
    fixture = await createMongoReplicaFixture()
    await bootstrapMongoOverlay(fixture.db, fixture.scope)
  }, 90000)

  afterAll(async () => {
    await fixture.close()
  })

  test('reconciles a successful commit whose real server response was dropped using the same session', async () => {
    const { client, proxy } = await lostReplyClient()
    const runner = new MongoTransactionRunner(client.db(fixture.db.databaseName), fixture.scope, {
      maxCommitAttempts: 1
    })
    const input = request()
    let bodies = 0
    try {
      const pending = await runner.run(
        input,
        async context => {
          bodies += 1
          await client
            .db(fixture.db.databaseName)
            .collection('response_loss_effects')
            .insertOne({ operationId: input.key.operationId }, context.options())
        },
        { timeoutMS: 15000 }
      )
      await proxy.waitForDroppedReply()
      expect(proxy.droppedSuccessfulCommitReply).toBe(true)
      expect(pending.state).toBe('pending')
      const attemptId = pending.state === 'pending' ? pending.attemptId : undefined
      expect(await runner.reconcile(input.key, attemptId, { timeoutMS: 15000 })).toEqual({
        state: 'committed',
        receipt: input.receipt
      })
      expect(bodies).toBe(1)
      expect(proxy.commits).toHaveLength(1)
      expect(proxy.commits[0].lsid).not.toHaveLength(0)
      expect(proxy.commits[0].txnNumber).toBe('1')
    } finally {
      await runner.close()
      await client.close()
      await proxy.close()
    }
  }, 30000)

  test('replays the majority receipt after disposing the runner that lost the response', async () => {
    const { client, proxy } = await lostReplyClient()
    const runner = new MongoTransactionRunner(client.db(fixture.db.databaseName), fixture.scope, {
      maxCommitAttempts: 1
    })
    const input = request()
    let bodies = 0
    try {
      const pending = await runner.run(
        input,
        async () => {
          bodies += 1
        },
        { timeoutMS: 15000 }
      )
      await proxy.waitForDroppedReply()
      expect(proxy.droppedSuccessfulCommitReply).toBe(true)
      expect(pending.state).toBe('pending')
      await runner.close()
      const restarted = new MongoTransactionRunner(fixture.db, fixture.scope)
      try {
        expect(
          await restarted.run(input, async () => {
            bodies += 1
          })
        ).toEqual({
          state: 'committed',
          receipt: input.receipt
        })
      } finally {
        await restarted.close()
      }
      expect(bodies).toBe(1)
    } finally {
      await client.close()
      await proxy.close()
    }
  }, 30000)
})
