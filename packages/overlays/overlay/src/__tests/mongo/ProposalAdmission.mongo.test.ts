import { Engine } from '../../Engine.js'
import { OverlayProposalAdmission } from '../../ProposalAdmission.js'
import type { TopicManager } from '../../TopicManager.js'
import { MongoOverlayStorage } from '../../storage/mongo/MongoOverlayStorage.js'
import { bootstrapMongoOverlay, MongoCollectionNames } from '../../storage/mongo/MongoSchema.js'
import {
  identity,
  inputs,
  rulesDigest,
  scope,
  service,
  topic,
  transaction
} from '../ProposalAdmissionFixture.js'
import { createMongoReplicaFixture, type MongoReplicaFixture } from './MongoReplicaFixture.js'

// Jest provides the same test object to native ESM through import.meta.
const jest = import.meta.jest

describe('proposal recovery through an actual Engine and three-member Mongo replica set', () => {
  let replica: MongoReplicaFixture
  const adapters: MongoOverlayStorage[] = []
  const decide = jest.fn().mockResolvedValue({ outputsToAdmit: [0], coinsToRetain: [] })
  const manager: TopicManager = {
    identifyAdmissibleOutputs: decide,
    getDocumentation: async () => 'Synthetic records topic',
    getMetaData: async () => ({ name: 'Records', shortDescription: 'Test topic' })
  }
  const tracker = { isValidRootForHeight: async () => true, currentHeight: async () => 800000 }
  function install() {
    const storage = new MongoOverlayStorage(replica.db, scope, { retainAdmissionHistory: true })
    adapters.push(storage)
    // No broadcaster or advertiser: no external network calls or funded effects.
    const engine = new Engine({ [topic]: manager, tm_private: manager }, {}, storage, tracker)
    const bridge = new OverlayProposalAdmission({ engine, identity, rulesDigest, service, topic })
    return { storage, engine, bridge }
  }
  beforeAll(async () => {
    replica = await createMongoReplicaFixture()
    await bootstrapMongoOverlay(replica.db, scope)
  }, 120000)
  afterAll(async () => {
    for (const adapter of adapters) await adapter.close()
    await replica.close()
  }, 60000)

  test('recovers historical multi-topic admission after restart and serving eviction without resubmitting', async () => {
    const f = inputs()
    const first = install()
    await first.engine.submit(
      { beef: transaction.toBEEF(), topics: [topic, 'tm_private'] },
      undefined,
      'historical-tx'
    )
    const before = await first.bridge.recover(f.job, f.proposal, f.selection, f.context)
    expect(before.status).toBe('admitted')
    if (before.status === 'admitted') expect(Object.keys(before.steak)).toEqual([topic])
    await first.storage.close()
    await replica.db
      .collection(MongoCollectionNames.appliedTransactions)
      .updateMany({}, { $set: { state: 'evicted' } })
    await replica.db
      .collection(MongoCollectionNames.outputs)
      .updateMany({}, { $set: { state: 'spent' } })
    const restarted = install()
    const submit = jest.spyOn(restarted.engine, 'submit')
    const recovered = await restarted.bridge.recover(
      { ...f.job, operationId: 'proposal-after-restart' },
      f.proposal,
      f.selection,
      { ...f.context, id: 'later-context' }
    )
    expect(recovered).toEqual({ ...before, operationId: 'proposal-after-restart' })
    expect(submit).not.toHaveBeenCalled()
  }, 30000)

  test('concurrent ordinary submission and a lost Engine response recover one durable operation', async () => {
    // A separate namespace proves the new-admission path rather than reusing the
    // preceding historical receipt. Collections are scoped by node identity.
    const freshScope = { ...scope, nodeId: 'second-node' }
    await bootstrapMongoOverlay(replica.db, freshScope)
    const storage = new MongoOverlayStorage(replica.db, freshScope, {
      retainAdmissionHistory: true
    })
    adapters.push(storage)
    const engine = new Engine({ [topic]: manager }, {}, storage, tracker)
    const bridge = new OverlayProposalAdmission({ engine, identity, rulesDigest, service, topic })
    const submit = engine.submit.bind(engine)
    jest.spyOn(engine, 'submit').mockImplementation(async (...args) => {
      await submit(...args)
      throw new Error('lost response after actual committed Engine admission')
    })
    const f = inputs()
    const pending = [0, 1, 2].map(
      async index =>
        await bridge.recover(
          { ...f.job, operationId: `proposal-concurrent-${index}` },
          f.proposal,
          f.selection,
          f.context
        )
    )
    let outcomes: Awaited<(typeof pending)[number]>[]
    try {
      outcomes = await Promise.all(pending)
    } finally {
      // A failed caller must not leave another native transaction in teardown.
      await Promise.allSettled(pending)
    }
    const first = outcomes[0]
    expect(first.status).toBe('admitted')
    for (let index = 0; index < outcomes.length; index += 1)
      expect(outcomes[index]).toEqual({ ...first, operationId: `proposal-concurrent-${index}` })
    expect(await storage.doesAppliedTransactionExist({ txid: f.job.txid, topic })).toBe(true)
    expect(await storage.findOutput(f.job.txid, 0, topic)).toBeDefined()
  }, 30000)
})
