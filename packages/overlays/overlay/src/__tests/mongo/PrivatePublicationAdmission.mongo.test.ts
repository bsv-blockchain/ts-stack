import { Engine } from '../../Engine.js'
import { OverlayPrivatePublicationAdmission } from '../../PrivatePublicationAdmission.js'
import { MongoOverlayStorage } from '../../storage/mongo/MongoOverlayStorage.js'
import { bootstrapMongoOverlay, MongoCollectionNames } from '../../storage/mongo/MongoSchema.js'
import type { TopicManager } from '../../TopicManager.js'
import { privateAdmissionFixture } from '../PrivatePublicationAdmissionFixture.js'
import {
  identity,
  rulesDigest,
  scope,
  service,
  topic,
  transaction
} from '../ProposalAdmissionFixture.js'
import { createMongoReplicaFixture, type MongoReplicaFixture } from './MongoReplicaFixture.js'
import type { Transaction } from '@bsv/sdk'

// Jest provides the same test object to native ESM through import.meta.
const jest = import.meta.jest

describe('private publication admission with an actual Engine and three-member Mongo replica set', () => {
  let replica: MongoReplicaFixture
  const adapters: MongoOverlayStorage[] = []
  // Fixed public BRC-62 proof fixture: accept only its preselected anchor roots.
  // Full independent header-policy verification belongs to the reference service.
  const roots = new Set<string>()
  function anchors(tx: Transaction): void {
    if (tx.merklePath)
      roots.add(`${tx.merklePath.blockHeight}:${tx.merklePath.computeRoot(tx.id('hex'))}`)
    for (const input of tx.inputs) if (input.sourceTransaction) anchors(input.sourceTransaction)
  }
  anchors(transaction)
  const tracker = {
    currentHeight: async () => 800000,
    isValidRootForHeight: async (root: string, height: number) => roots.has(`${height}:${root}`)
  }

  beforeAll(async () => {
    replica = await createMongoReplicaFixture()
  }, 120000)
  afterAll(async () => {
    for (const adapter of adapters) await adapter.close()
    await replica?.close()
  }, 60000)

  async function install(name: string, reuse: boolean, loseReply = false) {
    const localScope = { ...scope, nodeId: name }
    await bootstrapMongoOverlay(replica.db, localScope)
    const storage = new MongoOverlayStorage(replica.db, localScope, {
      retainAdmissionHistory: true
    })
    adapters.push(storage)
    const decide = jest
      .fn<
        ReturnType<TopicManager['identifyAdmissibleOutputs']>,
        Parameters<TopicManager['identifyAdmissibleOutputs']>
      >()
      .mockResolvedValue({ outputsToAdmit: [0], coinsToRetain: [] })
    const manager: TopicManager = {
      identifyAdmissibleOutputs: decide,
      getDocumentation: async () => 'Synthetic private material topic',
      getMetaData: async () => ({
        name: 'Private material',
        shortDescription: 'Synthetic admission integration'
      })
    }
    const engine = new Engine({ [topic]: manager }, {}, storage, tracker)
    const original = engine.submit.bind(engine)
    const submit = jest.spyOn(engine, 'submit').mockImplementation(async (...args) => {
      const value = await original(...args)
      if (loseReply) throw new Error('Synthetic reply loss after retained commit')
      return value
    })
    const f = privateAdmissionFixture()
    const bridge = new OverlayPrivatePublicationAdmission({
      engine,
      identity,
      rulesDigest,
      service,
      topic,
      publicAdmissionReuse: reuse ? 'after-independent-private-validation' : 'disabled',
      isCurrent: () => true
    })
    return {
      storage,
      engine,
      decide,
      submit,
      f,
      bridge,
      run: () => bridge.recover(f.job, f.selection, f.context)
    }
  }

  test('the actual topic receives private bytes and a lost reply recovers one retained receipt', async () => {
    const first = await install('private-publication-new', false, true)
    const result = await first.run()
    expect(result.status).toBe('admitted')
    expect(result).toMatchObject({ context: 'matching-private-values' })
    expect(first.decide).toHaveBeenCalledTimes(1)
    expect(first.decide.mock.calls[0][2]).toEqual([1, 2, 3])
    expect(
      await first.storage.findOutput(first.f.job.request.evidence.txid, 0, topic)
    ).toBeDefined()
    await first.storage.close()
    const restarted = await install('private-publication-new', false)
    expect(await restarted.run()).toEqual(result)
    expect(restarted.submit).not.toHaveBeenCalled()
    expect(restarted.decide).not.toHaveBeenCalled()
  }, 30000)

  test('an already public output can reuse only its original admission and never reruns private evaluation', async () => {
    const first = await install('private-publication-existing', true)
    await first.engine.submit({ beef: transaction.toBEEF(), topics: [topic] })
    expect(first.decide.mock.calls[0][2]).toBeUndefined()
    first.submit.mockClear()
    first.decide.mockClear()
    const result = await first.run()
    expect(result).toMatchObject({ status: 'admitted', context: 'public' })
    expect(first.submit).not.toHaveBeenCalled()
    expect(first.decide).not.toHaveBeenCalled()
    const withoutReuse = await install('private-publication-existing', false)
    expect(await withoutReuse.run()).toMatchObject({ status: 'unresolved' })
    expect(withoutReuse.submit).toHaveBeenCalledTimes(1)
    expect(withoutReuse.decide).not.toHaveBeenCalled()
  }, 30000)

  test('retained admission survives serving eviction and does not assert private lookup readiness', async () => {
    const first = await install('private-publication-evicted', false)
    const result = await first.run()
    const evicted = await replica.db
      .collection(MongoCollectionNames.appliedTransactions)
      .updateMany({ nodeId: 'private-publication-evicted' }, { $set: { state: 'evicted' } })
    expect(evicted.modifiedCount).toBe(1)
    const spent = await replica.db
      .collection(MongoCollectionNames.outputs)
      .updateMany({ nodeId: 'private-publication-evicted' }, { $set: { state: 'spent' } })
    expect(spent.modifiedCount).toBe(1)
    await first.storage.close()
    const restarted = await install('private-publication-evicted', false)
    expect(await restarted.run()).toEqual(result)
    expect(result).not.toHaveProperty('ready')
    expect(restarted.submit).not.toHaveBeenCalled()
  }, 30000)
})
