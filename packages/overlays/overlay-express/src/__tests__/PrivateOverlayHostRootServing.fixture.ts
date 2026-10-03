import express from 'express'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  AuthFetch,
  CompletedProtoWallet,
  PrivateKey,
  Transaction,
  Utils,
  OverlayAdminTokenTemplate,
  OutputLookupTransport,
  canonicalOutputJSON,
  outputPacketDigest,
  type OutputEvidence
} from '@bsv/sdk'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { Engine, type LookupService, type TopicManager } from '@bsv/overlay'
import { OverlayGASPStorage } from '@bsv/overlay/GASP/OverlayGASPStorage.ts'
import { MongoOverlayStorage } from '@bsv/overlay/storage/mongo/MongoOverlayStorage'
import { bootstrapMongoOverlay } from '@bsv/overlay/storage/mongo/MongoSchema'
import { createMongoReplicaFixture } from '../../../overlay/src/__tests/mongo/MongoReplicaFixture.js'
import { createOutputLookupRouter } from '../OutputLookupRoutes.js'
import { guardRootAdvertisementResponse } from '../RootEvictionResponseGuard.js'
import { SDKRootAdvertisementEvidence } from '../../../../application/output-knowledge/src/root-eviction/SDKRootAdvertisementEvidence.js'
import { SDKRootEvictionEvidence } from '../../../../application/output-knowledge/src/root-eviction/SDKRootEvictionEvidence.js'
import {
  RootAdvertisementServing,
  rootAdvertisementServingTarget
} from '../../../../application/output-knowledge/src/root-eviction/RootAdvertisementServing.js'
import { RootLookupServingDisclosure } from '../../../../application/output-knowledge/src/root-eviction/RootLookupServingDisclosure.js'
import { LookupResponseDisclosure } from '../../../../application/output-knowledge/src/lookup/LookupResponseDisclosure.js'
import { collectionOutputIndexKey } from '../../../../application/output-knowledge/src/lookup/CollectionOutputQueryPolicy.js'
import {
  fixture,
  clock
} from '../../../../application/output-knowledge/test/root-eviction-fixture.js'
import {
  rootAdvertisementFixture,
  signRootEvidence,
  advertiserKey,
  advertiser
} from '../../../../application/output-knowledge/test/root-advertisement-fixture.js'
import { providerFixture } from '../../../../application/output-knowledge/test/lookup-provider-fixture.js'
import {
  context,
  resolver
} from '../../../../application/output-knowledge/test/evidence-fixture.js'

/** Public synthetic chain and keys; real Script, Mongo, SQLite, authentication and response enqueue. */
export async function nativeRootServingFixture(protocol: 'SHIP' | 'SLAP') {
  const ad = await rootAdvertisementFixture(protocol, 2),
    chain = ad.body.chain,
    service = ad.body.targets[0].service,
    replica = await createMongoReplicaFixture(),
    topic = protocol === 'SHIP' ? 'tm_ship_reference' : 'tm_slap_reference',
    verifier = new SDKRootAdvertisementEvidence(resolver),
    requestVerifier = new SDKRootEvictionEvidence(resolver),
    view = await resolver.resolve(context().view, new AbortController().signal),
    server = createServer(express())
  const roots: { close(): Promise<void> }[] = []
  let serial = 0,
    armed = false
  let onSign: (() => Promise<void>) | undefined
  const rootKey = new PrivateKey(82),
    rootIdentity = rootKey.toPublicKey().toString()
  const app = express()
  server.removeAllListeners('request')
  server.on('request', app)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
  async function install(key: PrivateKey, name: string, url: string) {
    const root = await fixture({ root: key.toPublicKey().toString(), chain }),
      feed = await providerFixture('brc103', url, {
        service,
        chain,
        identityKey: key,
        principal: advertiser
      }),
      scope = { ...chain, nodeId: name }
    await bootstrapMongoOverlay(replica.db, scope)
    const storage = new MongoOverlayStorage(replica.db, scope, {
      retainAdmissionHistory: true,
      retainedBEEF: { maximumBytes: 4194304 }
    })
    const manager: TopicManager = {
      async identifyAdmissibleOutputs(beef) {
        const tx = Transaction.fromBEEF(beef),
          outputsToAdmit: number[] = []
        for (let index = 0; index < tx.outputs.length; index++) {
          try {
            await OverlayAdminTokenTemplate.decodeAndVerify(
              tx.outputs[index].lockingScript,
              protocol
            )
          } catch {
            continue
          }
          const evidence = { txid: tx.id('hex'), outputIndex: index, beef: Utils.toBase64(beef) },
            target = rootAdvertisementServingTarget(service, chain, evidence)
          await verifier.verify({ target, advertisement: evidence }, context())
          outputsToAdmit.push(index)
        }
        return { outputsToAdmit, coinsToRetain: [] }
      },
      getDocumentation: async () =>
        'Authenticated current-format root advertisements on a synthetic local-admission chain.',
      getMetaData: async () => ({
        name: 'Root advertisements',
        shortDescription: 'Native guarded discovery reference'
      })
    }
    const lookup: LookupService = {
      admissionMode: 'locking-script',
      spendNotificationMode: 'none',
      outputAdmittedByTopic() {},
      outputEvicted() {},
      async lookup() {
        const outputs = await storage.findUTXOsForTopic(topic, undefined, 64, true),
          retained = []
        for (const output of outputs) {
          const evidence = {
              txid: output.txid,
              outputIndex: output.outputIndex,
              beef: Utils.toBase64(output.beef!)
            },
            target = rootAdvertisementServingTarget(service, chain, evidence)
          if ((await root.store.serving(target)).state === 'eligible')
            retained.push({ txid: output.txid, outputIndex: output.outputIndex })
        }
        return retained
      },
      getDocumentation: manager.getDocumentation,
      getMetaData: manager.getMetaData
    }
    const engine = new Engine({ [topic]: manager }, { [service]: lookup }, storage, view.tracker),
      serving = new RootAdvertisementServing(root.store)
    async function evidence(index: number): Promise<OutputEvidence> {
      const output = await storage.findHistoricalOutput(
        ad.transaction.id('hex'),
        index,
        topic,
        true
      )
      if (!output?.beef) throw new Error('Original advertisement evidence unavailable')
      return { txid: output.txid, outputIndex: index, beef: Utils.toBase64(output.beef) }
    }
    async function assess(index: number, expectedRevision = serving.capture().revision) {
      const material = await evidence(index),
        target = rootAdvertisementServingTarget(service, chain, material),
        checked = await verifier.verify({ target, advertisement: material }, context()),
        unspent = await storage.findOutput(material.txid, index, topic, false)
      return await root.store.assess({
        operationId: `native_root_assessment_${++serial}`,
        expectedRevision,
        target: checked.target,
        eligible: unspent !== null,
        evidenceDigest: outputPacketDigest('service-rules', checked),
        reasonCode: 'verified-local-admission-currentness'
      })
    }
    async function project() {
      for (const intent of await root.store.projections(64)) {
        const head = await feed.index.head(),
          key = collectionOutputIndexKey(intent.target.outpoint),
          row = await feed.index.row(key, head.sequence),
          material = await evidence(intent.target.outpoint.outputIndex)
        if (intent.membership === 'include' || row !== null)
          await feed.index.commit({
            base: head.sequence,
            evaluatedAt: feed.clock.now,
            edits: [
              {
                key,
                previous: row?.revision ?? null,
                next:
                  intent.membership === 'include'
                    ? {
                        data: {
                          collection: 'records',
                          audience: 'public',
                          output: {
                            evidence: {
                              txid: material.txid,
                              outputIndex: material.outputIndex,
                              beef: material.beef
                            }
                          }
                        },
                        expiresAt: null
                      }
                    : null
              }
            ],
            event: {
              kind: 'root-membership-projection',
              root: root.configuration.root,
              revision: intent.revision
            }
          })
        if (!(await root.store.projected(intent)))
          throw new Error('Stale native root projection acknowledgement')
      }
    }
    async function request(action: 'suppress' | 'restore', basis?: string, index = 0) {
      const material = await evidence(index),
        target = rootAdvertisementServingTarget(service, chain, material),
        body = {
          ...ad.body,
          recipient: root.configuration.root,
          requestId: `native_root_request_${++serial}`,
          action,
          targets: [
            {
              ...target,
              advertisement: material,
              evidence: { kind: 'owner-withdrawal' as const, advertisement: material },
              ...(action === 'restore' ? { restores: basis } : {})
            }
          ]
        },
        signed = signRootEvidence(body),
        head = await root.store.head(),
        checked = await requestVerifier.verify(signed, 0, context())
      if (checked.proof.kind !== 'owner-withdrawal' || checked.proof.advertiser !== advertiser)
        throw new Error('Unapproved root owner request')
      const retained = await root.store.retain(signed, advertiser, clock),
        unspent = await storage.findOutput(material.txid, index, topic, false)
      await root.store.evaluate({
        requestDigest: retained.digest,
        expectedRevision: head.revision,
        now: clock.now,
        targets: [
          {
            index: 0,
            disposition: 'accept',
            reasonCode: 'authenticated-owner-local-policy',
            eligible: unspent !== null
          }
        ]
      })
      return await root.store.result(advertiser, body.requestId, clock.now)
    }
    async function admit() {
      const head = serving.capture()
      await engine.submit(
        { beef: ad.transaction.toAtomicBEEF(), topics: [topic] },
        undefined,
        'historical-tx'
      )
      await assess(0, head.revision)
      await assess(1)
      await project()
    }
    async function submitPublicHistory(
      beef: number[],
      affected: readonly number[],
      beforeEffect?: () => Promise<void>
    ) {
      // Every writer in this installed root profile fences current serving
      // before a Mongo admission/spend/replay can change its source knowledge.
      // Failure leaves conservative ineligibility until explicit reconciliation.
      for (const index of affected) {
        const head = serving.capture(),
          material = await evidence(index),
          target = rootAdvertisementServingTarget(service, chain, material)
        await root.store.assess({
          operationId: `native_root_writer_fence_${++serial}`,
          expectedRevision: head.revision,
          target,
          eligible: false,
          evidenceDigest: outputPacketDigest('service-rules', { target, reason: 'writer-fence' }),
          reasonCode: 'source-effect-pending'
        })
      }
      await beforeEffect?.()
      await engine.submit({ beef, topics: [topic] }, undefined, 'historical-tx')
      for (const index of affected) await assess(index)
      await project()
    }
    async function finite() {
      const head = serving.capture(),
        answer = await engine.lookup({ service, query: {} }),
        inventory = answer.outputs!.map(output =>
          rootAdvertisementServingTarget(service, chain, {
            txid: Transaction.fromBEEF(output.beef).id('hex'),
            outputIndex: output.outputIndex,
            beef: Utils.toBase64(output.beef)
          })
        )
      return {
        head,
        answer,
        inventory,
        bytes: new TextEncoder().encode(canonicalOutputJSON(answer))
      }
    }
    const value = {
      ...root,
      feed,
      storage,
      engine,
      serving,
      evidence,
      assess,
      project,
      request,
      admit,
      submitPublicHistory,
      finite,
      gasp: new OverlayGASPStorage(topic, engine, undefined, undefined, {
        historicalOutputs: true
      }),
      async close() {
        await feed.cleanup()
        await storage.close()
        await root.cleanup()
      }
    }
    roots.push(value)
    return value
  }
  try {
    const a = await install(rootKey, 'root-a', baseURL),
      b = await install(new PrivateKey(83), 'root-b', 'https://independent-root.example/api'),
      disclosure = new LookupResponseDisclosure({
        sessions: a.feed.sessions,
        contracts: a.feed.contracts,
        authorize: async auth => ({
          access: auth.principal!,
          guards: [
            {
              id: 'serving',
              revision: await a.feed.sessions.guard('serving'),
              failure: 'unauthorized'
            }
          ]
        }),
        authorizeControl: principal => principal === advertiser
      }),
      compound = new RootLookupServingDisclosure({
        disclosure,
        serving: a.serving,
        authorize: identity => identity === advertiser
      }),
      wallet = new CompletedProtoWallet(rootKey),
      sign = wallet.createSignature.bind(wallet)
    wallet.createSignature = async (...args) => {
      const result = await sign(...args)
      if (armed) await onSign?.()
      return result
    }
    const auth = createAuthMiddleware({
      wallet,
      allowUnauthenticated: true,
      transportLimits: { requestTimeoutMs: 3000 }
    })
    app.use(
      createOutputLookupRouter({
        service,
        baseURL,
        identity: rootIdentity,
        chain,
        authentication: 'brc103',
        authenticate: auth,
        companion: {
          open: async (...args) => {
            const response = await a.feed.service.open(...args)
            armed = true
            return response
          },
          read: async (...args) => {
            const response = await a.feed.service.read(...args)
            armed = true
            return response
          },
          close: a.feed.service.close.bind(a.feed.service)
        },
        disclosure: compound,
        manifest: a.feed.manifest,
        now: () => a.feed.clock.now,
        allowedOrigins: [],
        allowLocalHTTP: true
      })
    )
    app.post('/finite/lookup', express.json({ limit: 65536 }), auth, async (_req, res) => {
      try {
        const candidate = await a.finite()
        guardRootAdvertisementResponse(res, {
          journal: a.store,
          revision: candidate.head.revision,
          targets: candidate.inventory,
          authorize: identity => identity === advertiser,
          controlHeaders: {}
        })
        armed = true
        res.status(200).set('cache-control', 'private, no-store').json(candidate.answer)
      } catch {
        res.destroy()
      }
    })
    const responses: { status: number; body: string; headers: Headers }[] = [],
      client = new OutputLookupTransport({
        contract: a.feed.contracts.fresh(a.feed.caller.capabilityDigest, '1000').record,
        trust: a.feed.contracts.recoveryTrust(),
        wallet: new CompletedProtoWallet(advertiserKey),
        now: () => a.feed.clock.now,
        requestTimeoutMs: 3000,
        fetch: async (input, init) => {
          const response = await fetch(input, init)
          responses.push({
            status: response.status,
            body: await response.clone().text(),
            headers: response.headers
          })
          return response
        }
      }),
      finiteClient = new AuthFetch(new CompletedProtoWallet(advertiserKey))
    return {
      ad,
      a,
      b,
      service,
      client,
      responses,
      compound,
      onSign(callback?: () => Promise<void>) {
        onSign = callback
        armed = false
      },
      async finiteHTTP() {
        return await finiteClient.fetch(baseURL.replace('/api', '/finite/lookup'), {
          method: 'POST',
          body: '{}',
          headers: { 'content-type': 'application/json' },
          allowPayments: false,
          requireMutualAuth: true,
          expectedIdentityKey: rootIdentity
        })
      },
      async close() {
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) =>
          server.close(error => (error ? reject(error) : resolve()))
        )
        for (const root of roots) await root.close()
        await replica.close()
      }
    }
  } catch (error) {
    server.closeAllConnections()
    server.close()
    for (const root of roots) await root.close()
    await replica.close()
    throw error
  }
}
