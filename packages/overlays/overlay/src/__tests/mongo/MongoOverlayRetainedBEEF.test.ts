import { Beef, MerklePath } from '@bsv/sdk'
import { buildOverlayAdmissionPlan, getOverlayAdmissionHost } from '../../EngineAdmission.js'
import { MongoOverlayStorage } from '../../storage/mongo/MongoOverlayStorage.js'
import { bootstrapMongoOverlay, MongoCollectionNames } from '../../storage/mongo/MongoSchema.js'
import { createMongoReplicaFixture, type MongoReplicaFixture } from './MongoReplicaFixture.js'
import { retainedBeefFixture } from '../RetainedTransactionBEEFFixture.js'

let fixture: MongoReplicaFixture,
  serial = 0
const budget = { maximumBytes: 4194304 }
beforeAll(async () => {
  fixture = await createMongoReplicaFixture()
  await bootstrapMongoOverlay(fixture.db, fixture.scope)
}, 120000)
afterAll(async () => {
  await fixture?.close()
}, 60000)

// Storage/serialization tests only; the native root-host suite separately
// qualifies actual Script/SPV, chain, authentication and serving premises.
async function admission(storage: MongoOverlayStorage, maximumBytes?: number) {
  const f = retainedBeefFixture(++serial),
    topic = `tm_retained_${serial}`,
    host = getOverlayAdmissionHost(storage)!
  f.child.merklePath = new MerklePath(102, [[{ offset: 0, hash: f.txid, txid: true }]])
  const plan = await buildOverlayAdmissionPlan({
    host: maximumBytes === undefined ? host : { ...host, retainedBEEF: { maximumBytes } },
    tx: f.child,
    txid: f.txid,
    beef: f.bytes,
    topics: [topic],
    mode: 'historical',
    validations: [
      {
        topic,
        isDupe: false,
        previousCoins: [],
        previousOutputs: [],
        admissibleOutputs: { outputsToAdmit: [0], coinsToRetain: [] }
      }
    ],
    failedTopics: new Set(),
    lookupServices: {},
    includePropagation: false
  })
  expect((await storage.admission.commitAdmission(plan)).state).toBe('committed')
  return { ...f, topic, plan }
}

it('keeps default leaf-only behavior and enables complete raw ancestry only through an owned explicit option', async () => {
  const ordinary = new MongoOverlayStorage(fixture.db, fixture.scope),
    supplied = { ...budget },
    retained = new MongoOverlayStorage(fixture.db, fixture.scope, { retainedBEEF: supplied })
  supplied.maximumBytes = 1
  expect(getOverlayAdmissionHost(ordinary)?.retainedBEEF).toBeUndefined()
  expect(retained.retainedBEEF).toEqual(budget)
  expect(Object.isFrozen(retained.retainedBEEF)).toBe(true)
  const old = await admission(ordinary),
    current = await admission(retained)
  expect(old.plan.payloads.some(p => p.kind === 'beef-manifest')).toBe(false)
  expect(current.plan.payloads.some(p => p.kind === 'beef-manifest')).toBe(true)
  const oldBytes = (await ordinary.findOutput(old.txid, 0, old.topic, false, true))!.beef!,
    currentBytes = (await retained.findOutput(current.txid, 0, current.topic, false, true))!.beef!,
    complete = Beef.fromBinary(currentBytes)
  expect(Beef.fromBinary(oldBytes).findTxid(old.parent.id('hex'))).toBeUndefined()
  expect(complete.atomicTxid).toBe(current.txid)
  expect(complete.findTxid(current.parent.id('hex'))?.tx?.toBinary()).toEqual(
    current.parent.toBinary()
  )
  expect(complete.findAtomicTransaction(current.txid)?.merklePath?.blockHeight).toBe(102)
  // Opting in cannot invent ancestry that an older writer never retained.
  expect(
    Beef.fromBinary(
      (await retained.findOutput(old.txid, 0, old.topic, false, true))!.beef!
    ).findTxid(old.parent.id('hex'))
  ).toBeUndefined()
})

it('refuses a complete input/output budget before publishing or committing any payload', async () => {
  const storage = new MongoOverlayStorage(fixture.db, fixture.scope, { retainedBEEF: budget }),
    before = await fixture.db.collection(MongoCollectionNames.payloads).countDocuments()
  await expect(admission(storage, 1)).rejects.toThrow('byte limit')
  expect(await fixture.db.collection(MongoCollectionNames.payloads).countDocuments()).toBe(before)
})

it('keeps evicted and spent history separately scoped without exposing it to current lookup', async () => {
  const storage = new MongoOverlayStorage(fixture.db, fixture.scope, { retainedBEEF: budget }),
    unspent = await admission(storage),
    spent = await admission(storage)
  await storage.deleteOutput(unspent.txid, 0, unspent.topic)
  await storage.markUTXOAsSpent(spent.txid, 0, spent.topic, 'dd'.repeat(32))
  await storage.deleteOutput(spent.txid, 0, spent.topic)
  for (const item of [unspent, spent]) {
    expect(await storage.findOutput(item.txid, 0, item.topic)).toBeNull()
    expect(await storage.findOutputsForTransaction(item.txid)).toEqual([])
    expect(await storage.findUTXOsForTopic(item.topic)).toEqual([])
    expect(await storage.findHistoricalOutput(item.txid, 0, item.topic + '_other', true)).toBeNull()
    expect(await storage.findHistoricalOutput(item.txid, 1, item.topic, true)).toBeNull()
    const history = (await storage.findHistoricalOutput(item.txid, 0, item.topic, true))!
    expect(history.spent).toBe(item === spent)
    expect(Beef.fromBinary(history.beef!).findTxid(item.parent.id('hex'))?.tx?.toBinary()).toEqual(
      item.parent.toBinary()
    )
    expect(history).not.toHaveProperty('context')
    expect(history).not.toHaveProperty('offChainValues')
  }
  const other = new MongoOverlayStorage(
    fixture.db,
    { ...fixture.scope, nodeId: 'other-root' },
    { retainedBEEF: budget }
  )
  expect(await other.findHistoricalOutput(spent.txid, 0, spent.topic, true)).toBeNull()
})

it.each(['missing', 'kind', 'size', 'subject'])(
  'fails closed on a present retained manifest with %s damage',
  async cut => {
    const storage = new MongoOverlayStorage(fixture.db, fixture.scope, { retainedBEEF: budget }),
      item = await admission(storage),
      transactions = fixture.db.collection(MongoCollectionNames.transactions),
      record = (await transactions.findOne({ txid: item.txid }))!,
      payloads = fixture.db.collection(MongoCollectionNames.payloads)
    if (cut === 'subject') {
      const ref = await storage.publishAdmissionPayload({
        kind: 'beef-manifest',
        bytes: Uint8Array.from(item.parent.toAtomicBEEF())
      })
      await transactions.updateOne(
        { _id: record._id },
        { $set: { manifestPayloadId: storage.admission.payloadId(ref) } }
      )
    } else if (cut === 'missing') {
      await payloads.deleteOne({ _id: record.manifestPayloadId })
    } else if (cut === 'kind') {
      await payloads.updateOne(
        { _id: record.manifestPayloadId },
        { $set: { kind: 'locking-script' } }
      )
    } else {
      await payloads.updateOne(
        { _id: record.manifestPayloadId },
        { $set: { byteLength: '00000000000004194305' } }
      )
    }
    await expect(storage.findOutput(item.txid, 0, item.topic, false, true)).rejects.toThrow()
    // Omitting BEEF does not claim or inspect corrupt proof custody.
    expect(await storage.findOutput(item.txid, 0, item.topic, false)).not.toBeNull()
  }
)
