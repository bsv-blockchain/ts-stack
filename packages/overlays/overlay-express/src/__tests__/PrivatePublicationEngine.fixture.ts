import { Engine, type TopicManager } from '@bsv/overlay'
import { OverlayPrivatePublicationAdmission } from '@bsv/overlay/private-publication-admission'
import { MongoOverlayStorage } from '@bsv/overlay/storage/mongo/MongoOverlayStorage'
import { bootstrapMongoOverlay } from '@bsv/overlay/storage/mongo/MongoSchema'
import { createMongoReplicaFixture } from '../../../overlay/src/__tests/mongo/MongoReplicaFixture.js'
import { coordinatorFixture } from '../../../../application/output-knowledge/test/private-publication-coordinator-fixture.js'
import {
  resolver,
  context
} from '../../../../application/output-knowledge/test/evidence-fixture.js'

/** Native replica fixture shared by Engine and authenticated HTTP composition tests. */
export async function privatePublicationEngineFixture() {
  const replica = await createMongoReplicaFixture()
  const owners: MongoOverlayStorage[] = []
  return {
    async install(f: ReturnType<typeof coordinatorFixture>, name: string, loseReply = false) {
      const cfg = f.contract.installation,
        scope = { ...cfg.chain, nodeId: name }
      await bootstrapMongoOverlay(replica.db, scope)
      const storage = new MongoOverlayStorage(replica.db, scope, { retainAdmissionHistory: true })
      owners.push(storage)
      const calls: { beef: number[]; prior: number[]; privateValues?: number[] }[] = []
      const manager: TopicManager = {
        async identifyAdmissibleOutputs(beef, prior, privateValues) {
          calls.push({ beef, prior, privateValues })
          return { outputsToAdmit: [0], coinsToRetain: [] }
        },
        async getDocumentation() {
          return 'Synthetic private publication integration'
        },
        async getMetaData() {
          return { name: 'Private publication', shortDescription: 'Synthetic private material' }
        }
      }
      const view = await resolver.resolve(context().view, new AbortController().signal)
      const engine = new Engine({ [cfg.topic]: manager }, {}, storage, view.tracker)
      const submit = engine.submit.bind(engine)
      let submissions = 0
      engine.submit = async (...args) => {
        submissions++
        const result = await submit(...args)
        if (loseReply) throw new Error('Lost Engine reply after durable admission')
        return result
      }
      const bridge = new OverlayPrivatePublicationAdmission({
        engine,
        identity: cfg.seller,
        topic: cfg.topic,
        service: cfg.service,
        rulesDigest: cfg.rulesDigest,
        maximumPrivateBytes: 100000,
        maximumOutcomeBytes: 4096,
        isCurrent: reference => f.leases.isCurrent(reference),
        publicAdmissionReuse: 'disabled'
      })
      return {
        bridge,
        storage,
        calls,
        get submissions() {
          return submissions
        }
      }
    },
    async close() {
      try {
        for (const owner of owners) await owner.close()
      } finally {
        await replica.close()
      }
    }
  }
}
