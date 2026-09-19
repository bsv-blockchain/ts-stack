import { randomUUID } from 'node:crypto'
import { Transaction } from '@bsv/sdk'
import type { Output } from '../../Output.js'
import { MongoOverlayStorage } from '../../storage/mongo/MongoOverlayStorage.js'
import { MongoPayloadStore } from '../../storage/mongo/MongoPayloadStore.js'
import {
  bootstrapMongoOverlay,
  encodeMongoOutputIndex,
  encodeMongoUint64,
  MongoCollectionNames
} from '../../storage/mongo/MongoSchema.js'
import { createMongoReplicaFixture, type MongoReplicaFixture } from './MongoReplicaFixture.js'
import { admissionSemanticDigest, type AdmissionCommit } from '../../storage/AdmissionStorage.js'

const BRC62Hex =
  '0100beef01fe636d0c0007021400fe507c0c7aa754cef1f7889d5fd395cf1f785dd7de98eed895dbedfe4e5bc70d1502ac4e164f5bc16746bb0868404292ac8318bbac3800e4aad13a014da427adce3e010b00bc4ff395efd11719b277694cface5aa50d085a0bb81f613f70313acd28cf4557010400574b2d9142b8d28b61d88e3b2c3f44d858411356b49a28a4643b6d1a6a092a5201030051a05fc84d531b5d250c23f4f886f6812f9fe3f402d61607f977b4ecd2701c19010000fd781529d58fc2523cf396a7f25440b409857e7e221766c57214b1d38c7b481f01010062f542f45ea3660f86c013ced80534cb5fd4c19d66c56e7e8c5d4bf2d40acc5e010100b121e91836fd7cd5102b654e9f72f3cf6fdbfd0b161c53a9c54b12c841126331020100000001cd4e4cac3c7b56920d1e7655e7e260d31f29d9a388d04910f1bbd72304a79029010000006b483045022100e75279a205a547c445719420aa3138bf14743e3f42618e5f86a19bde14bb95f7022064777d34776b05d816daf1699493fcdf2ef5a5ab1ad710d9c97bfb5b8f7cef3641210263e2dee22b1ddc5e11f6fab8bcd2378bdd19580d640501ea956ec0e786f93e76ffffffff013e660000000000001976a9146bfd5c7fbe21529d45803dbcf0c87dd3c71efbc288ac0000000001000100000001ac4e164f5bc16746bb0868404292ac8318bbac3800e4aad13a014da427adce3e000000006a47304402203a61a2e931612b4bda08d541cfb980885173b8dcf64a3471238ae7abcd368d6402204cbf24f04b9aa2256d8901f0ed97866603d2be8324c2bfb7a37bf8fc90edd5b441210263e2dee22b1ddc5e11f6fab8bcd2378bdd19580d640501ea956ec0e786f93e76ffffffff013c660000000000001976a9146bfd5c7fbe21529d45803dbcf0c87dd3c71efbc288ac0000000000'

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
  return Array.from({ length: bytes }, () =>
    Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, '0')
  ).join('')
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

    const raw = await fixture.db.collection(MongoCollectionNames.outputs).findOne({
      txid,
      topic,
      network: fixture.scope.network,
      genesisHash: fixture.scope.genesisHash
    })
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

  test('uses a caller-supplied payload store instead of constructing its own', async () => {
    const real = new MongoPayloadStore(fixture.db, fixture.scope)
    const calls: string[] = []
    const payloads = {
      publish: async (input: Parameters<MongoPayloadStore['publish']>[0]) => {
        calls.push(input.kind)
        return await real.publish(input)
      }
    } as unknown as MongoPayloadStore
    const overlay = new MongoOverlayStorage(fixture.db, fixture.scope, { payloads })
    await overlay.publishAdmissionPayload({ kind: 'locking-script', bytes: new Uint8Array([7]) })
    // Proves the constructor actually used the injected store (the
    // `options.payloads ?? new MongoPayloadStore(...)` branch) rather than
    // silently falling back to one it constructs itself.
    expect(calls).toEqual(['locking-script'])
    await overlay.close()
  })

  test('insertOutput records a spent output as spent from the start', async () => {
    const txid = randomHex(32)
    const topic = `Spent-${randomUUID()}`
    await storage.insertOutput({
      txid,
      outputIndex: 0,
      outputScript: [4, 5],
      satoshis: 10,
      topic,
      spent: true,
      outputsConsumed: [],
      consumedBy: []
    })
    expect(await storage.findOutput(txid, 0, topic, true)).toEqual(
      expect.objectContaining({ spent: true })
    )
    expect(await storage.findOutput(txid, 0, topic, false)).toBeNull()
  })

  test('findOutput with includeBEEF leaves beef unset when no transaction row exists for the output', async () => {
    const txid = randomHex(32)
    const topic = `NoBeef-${randomUUID()}`
    // insertOutput without a `beef` field never calls persistTransactionBeef,
    // so no row exists in the transactions collection for this txid at all.
    await storage.insertOutput({
      txid,
      outputIndex: 0,
      outputScript: [9, 9],
      satoshis: 1,
      topic,
      spent: false,
      outputsConsumed: [],
      consumedBy: []
    })
    const found = await storage.findOutput(txid, 0, topic, false, true)
    expect(found).not.toBeNull()
    expect(found?.beef).toBeUndefined()
  })

  test('readScript returns an empty script when the output document carries no scriptPayloadId', async () => {
    const txid = randomHex(32)
    const topic = `NoScript-${randomUUID()}`
    const now = new Date()
    // The live schema validator requires scriptPayloadId on every write, so
    // a document missing it can only arrive here as a pre-existing (e.g.
    // migrated, or written under an older schema) row -- simulated with
    // bypassDocumentValidation rather than a normal insertOutput() + $unset,
    // which the validator would reject outright.
    await fixture.db.collection(MongoCollectionNames.outputs).insertOne(
      {
        _id: `no-script-${randomUUID()}`,
        schemaVersion: 1,
        network: fixture.scope.network,
        genesisHash: fixture.scope.genesisHash,
        nodeId: fixture.scope.nodeId,
        topic,
        txid,
        outputIndex: encodeMongoOutputIndex('0'),
        satoshis: encodeMongoUint64('1'),
        score: encodeMongoUint64('1'),
        scriptOffset: encodeMongoUint64('0'),
        scriptByteLength: encodeMongoUint64('0'),
        state: 'unspent',
        version: '1',
        createdAt: now,
        updatedAt: now
      },
      { bypassDocumentValidation: true }
    )
    const found = await storage.findOutput(txid, 0, topic)
    expect(found?.outputScript).toEqual([])
  })

  test('findOutput with includeBEEF leaves beef unset when the transaction row names a payload that is no longer ready', async () => {
    const tx = Transaction.fromHexBEEF(BRC62Hex)
    const txid = tx.id('hex')
    const beef = tx.toBEEF()
    const topic = `EvictedRaw-${randomUUID()}`
    await storage.insertOutput({
      txid,
      outputIndex: 0,
      outputScript: [1, 1],
      satoshis: 1,
      topic,
      spent: false,
      outputsConsumed: [],
      consumedBy: [],
      beef
    })
    // Simulate a raw-transaction payload that has since been garbage
    // collected (or is otherwise no longer ready) while the transaction row
    // that named it is left in place -- readBeef must fail closed to
    // "no BEEF" rather than surfacing a null-pointer or stale bytes.
    const transaction = await fixture.db
      .collection(MongoCollectionNames.transactions)
      .findOne({ txid })
    expect(typeof transaction?.rawPayloadId).toBe('string')
    await fixture.db
      .collection(MongoCollectionNames.payloads)
      .updateOne({ _id: transaction?.rawPayloadId as string }, { $set: { state: 'deleted' } })
    const found = await storage.findOutput(txid, 0, topic, false, true)
    expect(found?.beef).toBeUndefined()
  })

  test('readBeef hydrates a merkle path pinned by an admission commit into the returned atomic BEEF', async () => {
    const exampleTX = Transaction.fromHexBEEF(BRC62Hex)
    const proven = exampleTX.inputs[0].sourceTransaction
    if (proven === undefined || proven.merklePath === undefined) {
      throw new Error('expected the BEEF ancestor to carry a merkle path')
    }
    const txid = proven.id('hex')
    const topic = `Merkle-${randomUUID()}`
    const raw = await storage.publishAdmissionPayload({
      kind: 'raw-transaction',
      bytes: Buffer.from(proven.toBinary()),
      txid
    })
    const merkle = await storage.publishAdmissionPayload({
      kind: 'merkle-path',
      bytes: Buffer.from(proven.merklePath.toBinary())
    })
    const script = await storage.publishAdmissionPayload({
      kind: 'locking-script',
      bytes: Buffer.from(proven.outputs[0].lockingScript.toBinary())
    })
    const identity = {
      scope: storage.admissionScope,
      txid,
      mode: 'historical' as const,
      contextDigest: '00'.repeat(32),
      topics: [{ topic, policyId: 'merkle-hydration-test' }]
    }
    const plan: AdmissionCommit = {
      key: {
        scope: storage.admissionScope,
        operationId: `merkle-hydrate-${txid}`,
        semanticDigest: admissionSemanticDigest(identity)
      },
      identity,
      payloads: [raw],
      decisions: [
        {
          topic,
          expectedHistory: { chainEpoch: '0', topicHistoryGeneration: '0' },
          reads: [],
          spends: [],
          evictions: [],
          outputs: [
            {
              txid,
              outputIndex: '0',
              satoshis: String(proven.outputs[0].satoshis),
              score: '1',
              script: { payload: script, offset: '0', byteLength: script.byteLength }
            }
          ],
          edges: [],
          applied: { txid, proof: merkle, firstSeenHeight: '1' }
        }
      ],
      outbox: [],
      steak: JSON.stringify({
        [topic]: { outputsToAdmit: [0], coinsToRetain: [], coinsRemoved: [] }
      })
    }
    const committed = await storage.admission.commitAdmission(plan)
    expect(committed.state).toBe('committed')
    const found = await storage.findOutput(txid, 0, topic, false, true)
    expect(found?.beef).toBeDefined()
    const rebuilt = Transaction.fromBEEF(found?.beef ?? [])
    expect(rebuilt.id('hex')).toBe(txid)
    expect(rebuilt.merklePath).toBeDefined()

    // The merkle-path *reference* still names this transaction, but the
    // payload it points at is no longer ready (GC'd, or never finished
    // uploading) -- readBeef must fall back to the plain (non-atomic) BEEF
    // rather than crashing or fabricating a merkle path.
    await fixture.db
      .collection(MongoCollectionNames.payloads)
      .updateOne({ _id: storage.admission.payloadId(merkle) }, { $set: { state: 'deleted' } })
    const withoutMerkle = await storage.findOutput(txid, 0, topic, false, true)
    expect(withoutMerkle?.beef).toBeDefined()
    const rebuiltWithoutMerkle = Transaction.fromBEEF(withoutMerkle?.beef ?? [])
    expect(rebuiltWithoutMerkle.id('hex')).toBe(txid)
    expect(rebuiltWithoutMerkle.merklePath).toBeUndefined()
  })
})
