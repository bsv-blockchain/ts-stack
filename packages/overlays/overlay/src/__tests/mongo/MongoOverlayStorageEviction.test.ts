import { randomUUID } from 'node:crypto'
import type { Output } from '../../Output.js'
import { MongoOverlayStorage } from '../../storage/mongo/MongoOverlayStorage.js'
import { bootstrapMongoOverlay, MongoCollectionNames } from '../../storage/mongo/MongoSchema.js'
import { createMongoReplicaFixture, type MongoReplicaFixture } from './MongoReplicaFixture.js'

// Direct access to the private mapping function this finding names: it is
// the single place responsible for never surfacing a non-serving (evicted)
// document as a live output. Every current public read path (findOutput,
// findOutputsForTransaction, findUTXOsForTopic) already filters `evicted`
// out of its Mongo query before a document ever reaches this function, so
// exercising the defect end-to-end through those methods cannot fail on the
// pre-fix code — the mapping bug is only observable by feeding `toOutput`
// the raw (evicted) document directly, which is exactly what a future read
// path that forgets the query-level filter would do.
type ToOutputHost = {
  toOutput: (document: Record<string, unknown>, includeBEEF: boolean) => Promise<Output | null>
}

function randomHex(bytes: number): string {
  return Array.from({ length: bytes }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('')
}

describe('MongoOverlayStorage eviction and consumption-edge hydration', () => {
  let fixture: MongoReplicaFixture
  let storage: MongoOverlayStorage

  beforeAll(async () => {
    fixture = await createMongoReplicaFixture()
    await bootstrapMongoOverlay(fixture.db, fixture.scope)
    storage = new MongoOverlayStorage(fixture.db, fixture.scope)
  }, 120000)

  afterAll(async () => {
    await fixture.close()
  }, 60000)

  test('toOutput never maps an evicted document to a live output', async () => {
    const txid = randomHex(32)
    const topic = 'Hello'
    const output: Output = {
      txid,
      outputIndex: 0,
      outputScript: [1, 2, 3],
      satoshis: 1000,
      topic,
      spent: false,
      outputsConsumed: [],
      consumedBy: []
    }
    await storage.insertOutput(output)
    await storage.deleteOutput(txid, 0, topic)

    const raw = await fixture.db
      .collection(MongoCollectionNames.outputs)
      .findOne({ txid, topic, network: fixture.scope.network, genesisHash: fixture.scope.genesisHash })
    expect(raw?.state).toBe('evicted')
    if (raw === null) throw new Error('expected the evicted document to still exist for audit')

    const mapped = await (storage as unknown as ToOutputHost).toOutput(raw, false)
    expect(mapped).toBeNull()
  })

  test('findOutput and findOutputsForTransaction hydrate outputsConsumed/consumedBy from persisted consumption edges', async () => {
    const topic = `Edges-${randomUUID()}`
    const sourceTxid = randomHex(32)
    const consumerTxid = randomHex(32)

    const source: Output = {
      txid: sourceTxid,
      outputIndex: 0,
      outputScript: [9],
      satoshis: 500,
      topic,
      spent: false,
      outputsConsumed: [],
      consumedBy: []
    }
    const consumer: Output = {
      txid: consumerTxid,
      outputIndex: 0,
      outputScript: [7],
      satoshis: 400,
      topic,
      spent: false,
      outputsConsumed: [],
      consumedBy: []
    }
    await storage.insertOutput(source)
    await storage.insertOutput(consumer)

    // The admission transaction that created `consumer` also spent `source`;
    // this is how both MongoAdmissionStorage.insertEdge (during commit) and
    // MongoOverlayStorage.updateConsumedBy (classic path) persist that edge.
    await storage.updateConsumedBy(sourceTxid, 0, topic, [{ txid: consumerTxid, outputIndex: 0 }])

    const foundSource = await storage.findOutput(sourceTxid, 0, topic)
    expect(foundSource?.outputsConsumed).toEqual([])
    expect(foundSource?.consumedBy).toEqual([{ txid: consumerTxid, outputIndex: 0 }])

    const foundConsumer = await storage.findOutput(consumerTxid, 0, topic)
    expect(foundConsumer?.outputsConsumed).toEqual([{ txid: sourceTxid, outputIndex: 0 }])
    expect(foundConsumer?.consumedBy).toEqual([])

    const forTransaction = await storage.findOutputsForTransaction(consumerTxid)
    expect(forTransaction).toHaveLength(1)
    expect(forTransaction[0].outputsConsumed).toEqual([{ txid: sourceTxid, outputIndex: 0 }])
  })
})
