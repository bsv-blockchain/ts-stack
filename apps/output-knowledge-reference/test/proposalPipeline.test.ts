import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import express from 'express'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, rateLimit } from 'express-rate-limit'
import {
  canonicalOutputJSON,
  CompletedProtoWallet,
  LockingScript,
  OUTPUT_PROFILES,
  OutputProposalTransport,
  OutputProtocolError,
  outputPacketDigest,
  P2PKH,
  PrivateKey,
  retainOutputCapability,
  signOutputPacket,
  Transaction,
  Utils,
  type OutputCapabilities,
  type OutputCapabilityRequest,
  type OutputProposalBody,
  type OutputProposalFinalize,
  type OutputProposalTransportOptions
} from '@bsv/sdk'
import {
  AuthorDocumentPolicy,
  ProposalJournalMaintenance,
  ProposalChannelHeadsQuery,
  ProposalPolicyRegistry,
  ProposalResponseDisclosure,
  ProposalScheduler,
  ProposalService,
  ProposalTransitions,
  SDKProposalEvidence,
  type ProposalAdmissionOutcome,
  type ProposalServiceOptions
} from '@bsv/output-knowledge/proposals'
import { SQLiteProposalJournal } from '@bsv/output-knowledge/proposals/sqlite'
import { SQLiteProposalChannelStore } from '@bsv/output-knowledge/proposals/channels-sqlite'
import {
  LookupProviderContracts,
  LookupQueryRegistry,
  LookupSessionCodec,
  type LookupIndexFeed
} from '@bsv/output-knowledge/lookup'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { createProposalRouter } from '@bsv/overlay-express/proposals'
import { Engine, type TopicManager } from '@bsv/overlay'
import { OverlayProposalAdmission } from '@bsv/overlay/proposal-admission'
import { MongoOverlayStorage } from '@bsv/overlay/storage/mongo/MongoOverlayStorage'
import { bootstrapMongoOverlay } from '@bsv/overlay/storage/mongo/MongoSchema'
import {
  fixtureChain,
  referenceContext,
  referenceEvidence,
  referenceResolver
} from '../src/fixtureChain.js'
import {
  createMongoReplicaFixture,
  type MongoReplicaFixture
} from '../../../packages/overlays/overlay/src/__tests/mongo/MongoReplicaFixture.js'

// All keys, coins, headers and services are isolated synthetic fixtures. The
// complete signing/Script/SPV/admission/storage/authentication implementations
// run; only an explicit loss boundary interrupts receipt delivery after commit.
const providerKey = new PrivateKey(71),
  authorKey = new PrivateKey(72)
const provider = providerKey.toPublicKey().toString(),
  author = authorKey.toPublicKey().toString()
const serviceName = 'tm_reference_documents',
  baseURL = 'https://proposal.example.test/api'
const policies = new ProposalPolicyRegistry([
  { policy: new AuthorDocumentPolicy(), parameters: { maxTextBytes: 128 } }
])
const { parameters: policyParameters, ...policy } = policies.describe()[0]
const lifecycle = new ProposalTransitions(
  policies,
  { chain: fixtureChain, service: serviceName },
  { maxLifetimeSeconds: '100', futureSkewSeconds: '2' }
)
const rules = { id: 'urn:reference:proposal-records:1', parameters: {} }
const rulesDigest = outputPacketDigest('service-rules', rules)
const manifest = signOutputPacket<OutputCapabilities>(
  'capabilities',
  {
    version: 1,
    identity: provider,
    baseURL,
    chain: fixtureChain,
    issuedAt: '10',
    expiresAt: '100',
    services: [
      {
        name: serviceName,
        kind: 'topic',
        rules,
        rulesDigest,
        profiles: [
          {
            id: OUTPUT_PROFILES.proposal,
            authentication: 'brc103',
            payment: 'none',
            maxRequestBytes: 1048576,
            maxResponseBytes: 4194304,
            parameters: {
              policies: [{ ...policy, parameters: policyParameters }],
              maxLifetimeSeconds: '100',
              retentionSeconds: '1000'
            }
          }
        ]
      }
    ]
  },
  providerKey
)
const trust: OutputCapabilityRequest = {
  baseURL,
  identity: provider,
  authenticatedPeer: provider,
  chain: fixtureChain,
  kind: 'topic',
  service: serviceName,
  profile: OUTPUT_PROFILES.proposal,
  now: '11',
  maximumAgeSeconds: '100',
  clockSkewSeconds: '2',
  rules: new Map([
    [
      rules.id,
      parameters => {
        if (canonicalOutputJSON(parameters) !== '{}') throw new Error('Unexpected reference rules')
      }
    ]
  ])
}
const selected = retainOutputCapability(manifest, trust).record
let replica: MongoReplicaFixture
beforeAll(async () => {
  replica = await createMongoReplicaFixture()
}, 120000)
afterAll(async () => {
  await replica?.close()
}, 60000)

it.each(['standalone', 'compound'] as const)(
  'recovers one real Engine admission through original SDK/HTTP state after both service stores reopen (%s)',
  async storageKind => {
    const directory = mkdtempSync(join(tmpdir(), 'proposal-pipeline-')),
      path = join(directory, 'proposals.sqlite')
    const scope = {
      network: fixtureChain.network,
      genesisHash: fixtureChain.genesisHash,
      nodeId: 'reference-proposal-pipeline-' + storageKind
    }
    await bootstrapMongoOverlay(replica.db, scope)
    const state = {
      now: '11',
      allowed: true,
      discovery: true,
      evidence: true,
      loseReceipt: true
    }
    let committedOutcome: ProposalAdmissionOutcome | undefined
    const decided = vi.fn<TopicManager['identifyAdmissibleOutputs']>(async beef => {
      const tx = Transaction.fromBEEF(beef),
        output = tx.outputs[0]
      const selected =
        output?.satoshis === 1 &&
        /^006a045052503120[0-9a-f]{64}$/.test(output.lockingScript.toHex())
      return { outputsToAdmit: selected ? [0] : [], coinsToRetain: [] }
    })
    const manager: TopicManager = {
      identifyAdmissibleOutputs: decided,
      getDocumentation: async () => 'One-satoshi PRP1 records on a pinned synthetic chain',
      getMetaData: async () => ({
        name: 'Reference records',
        shortDescription: 'Synthetic committed proposal markers'
      })
    }
    const context = () =>
      referenceContext({
        application: 'reference-proposals',
        account: author,
        access: 'private'
      })
    const tracker = (await referenceResolver.resolve(context().view, new AbortController().signal))
      .tracker
    const closes: (() => Promise<void>)[] = []
    async function install(create: boolean) {
      const owned: (() => void | Promise<void>)[] = []
      let closed = false
      const close = async () => {
        if (closed) return
        closed = true
        const failures: unknown[] = []
        for (const release of owned.reverse()) {
          try {
            await release()
          } catch (error) {
            failures.push(error)
          }
        }
        if (failures.length) throw new AggregateError(failures, 'Reference proposal cleanup failed')
      }
      closes.push(close)
      const lookupContracts = new LookupProviderContracts(
        {
          baseURL,
          identity: provider,
          chain: fixtureChain,
          service: serviceName,
          maximumAgeSeconds: '100',
          clockSkewSeconds: '2'
        },
        new LookupQueryRegistry([
          { policy: new ProposalChannelHeadsQuery(policies), parameters: { policy } }
        ]),
        () => {
          throw new Error('This producer integration does not advertise lookup sessions')
        }
      )
      const storageOptions = {
        path,
        namespace: 'proposal-pipeline',
        identity: provider,
        lifecycle,
        policies,
        sessionCodec: new LookupSessionCodec(lookupContracts.recoveryTrust()),
        now: () => state.now
      }
      const compound =
        storageKind === 'compound'
          ? create
            ? SQLiteProposalChannelStore.create(storageOptions)
            : SQLiteProposalChannelStore.open(storageOptions)
          : undefined
      const journal =
        compound?.journal ??
        (create
          ? SQLiteProposalJournal.create(path, 'proposal-pipeline', provider, lifecycle)
          : SQLiteProposalJournal.open(path, 'proposal-pipeline', provider, lifecycle))
      owned.push(() => (compound ? compound.close() : journal.close()))
      const overlay = new MongoOverlayStorage(replica.db, scope, {
        retainAdmissionHistory: true
      })
      owned.push(() => overlay.close())
      // Deliberately no external broadcaster or advertiser. No live transaction or GASP propagation.
      const engine = new Engine({ [serviceName]: manager }, {}, overlay, tracker)
      const bridge = new OverlayProposalAdmission({
        engine,
        identity: provider,
        service: serviceName,
        topic: serviceName,
        rulesDigest,
        maximumOutcomeBytes: 4096
      })
      const evidence = new SDKProposalEvidence(
        {
          resolve: (view, signal) => {
            if (!state.evidence) throw new Error('Evidence resolver is offline')
            return referenceResolver.resolve(view, signal)
          }
        },
        context
      )
      const verify = vi.spyOn(evidence, 'verifyWithContext')
      const options: ProposalServiceOptions = {
        lifecycle,
        storage: journal,
        trust,
        now: () => state.now,
        manifest: () => {
          if (!state.discovery) throw new Error('Capability discovery is offline')
          return manifest
        },
        access: () => state.allowed,
        evidence,
        admission: {
          maximumOutcomeBytes: bridge.maximumOutcomeBytes,
          requiresVerificationContext: true,
          recover: async (job, proposal, selection, verificationContext) => {
            const outcome = await bridge.recover(job, proposal, selection, verificationContext)
            if (outcome.status === 'admitted' && state.loseReceipt) {
              committedOutcome = outcome
              throw new OutputProtocolError(
                'unavailable',
                'Synthetic loss after durable Engine commit'
              )
            }
            return outcome
          }
        }
      }
      const service = new ProposalService(options),
        disclosure = new ProposalResponseDisclosure({
          ...options,
          access: () => state.allowed
        })
      const rateStore = new MemoryStore(),
        app = express()
      owned.push(() => rateStore.shutdown())
      app.use(rateLimit({ windowMs: 60000, limit: 2000, store: rateStore }))
      app.use(
        createProposalRouter({
          service,
          disclosure,
          journal,
          baseURL,
          authenticate: createAuthMiddleware({
            wallet: new CompletedProtoWallet(providerKey),
            allowUnauthenticated: true,
            transportLimits: { requestTimeoutMs: 3000 }
          }),
          authorizeControl: () => true
        })
      )
      const server = createServer({ maxHeaderSize: 65536 }, app)
      owned.push(async () => {
        server.closeAllConnections()
        if (server.listening)
          await new Promise<void>((resolve, reject) =>
            server.close(error => (error ? reject(error) : resolve()))
          )
      })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      return {
        journal,
        feed: compound?.feed,
        overlay,
        engine,
        bridge,
        service,
        verify,
        origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close
      }
    }
    try {
      const parent = Transaction.fromAtomicBEEF(
        Utils.toArray(referenceEvidence('A').evidence.beef, 'base64')
      )
      const proposal = signOutputPacket<OutputProposalBody>(
        'proposal',
        {
          version: 1,
          chain: fixtureChain,
          service: serviceName,
          policy,
          channel: '11'.repeat(32),
          revision: '0',
          previous: null,
          author,
          recipients: [author],
          anchors: [{ chain: fixtureChain, txid: parent.id('hex'), outputIndex: 0 }],
          issuedAt: '10',
          expiresAt: '100',
          operation: 'update',
          payload: Utils.toBase64(
            Utils.toArray(
              canonicalOutputJSON({
                text: 'A private collaboratively prepared record'
              }),
              'utf8'
            )
          )
        },
        authorKey
      )
      const proposalId = outputPacketDigest('proposal', proposal.body)
      const tx = new Transaction(
        1,
        [
          {
            sourceTXID: parent.id('hex'),
            sourceTransaction: parent,
            sourceOutputIndex: 0,
            sequence: 0xffffffff,
            unlockingScriptTemplate: new P2PKH().unlock(new PrivateKey(63))
          }
        ],
        [
          {
            satoshis: 1,
            lockingScript: LockingScript.fromHex('006a045052503120' + proposalId)
          }
        ],
        0
      )
      await tx.sign()
      const request: OutputProposalFinalize = {
        version: 1,
        service: serviceName,
        proposalId,
        operationId: 'original-pipeline-finalization',
        txid: tx.id('hex'),
        beef: Utils.toBase64(tx.toAtomicBEEF())
      }
      let host = await install(true)
      const common = () => ({
        contract: selected,
        trust,
        wallet: new CompletedProtoWallet(authorKey),
        now: () => state.now,
        requestTimeoutMs: 5000,
        fetch: (async (input, init) => {
          const url = new URL(String(input))
          expect(url.origin).toBe('https://proposal.example.test')
          const response = await fetch(host.origin + url.pathname, init)
          return new Response(response.body, {
            status: response.status,
            headers: response.headers
          })
        }) as typeof fetch
      })
      const original = JSON.parse(JSON.stringify({ contract: selected, request })) as Pick<
        OutputProposalTransportOptions<'finalize'>,
        'contract' | 'request'
      >
      const acknowledgement = await new OutputProposalTransport({
        ...common(),
        operation: 'put',
        request: { version: 1, proposal }
      }).send()
      expect(acknowledgement.proposalId).toBe(proposalId)
      await assertFeed(host.feed, proposal, 'active', '1')
      expect(decided).not.toHaveBeenCalled()
      expect(await host.overlay.findOutput(request.txid, 0, serviceName)).toBeNull()
      expect(host.verify).not.toHaveBeenCalled()
      const read = await new OutputProposalTransport({
        ...common(),
        operation: 'get',
        request: {
          version: 1,
          service: serviceName,
          policy,
          channel: proposal.body.channel
        }
      }).send()
      expect(read.proposal).toEqual(proposal)
      await expect(
        new OutputProposalTransport({
          ...common(),
          wallet: new CompletedProtoWallet(new PrivateKey(73)),
          operation: 'get',
          request: {
            version: 1,
            service: serviceName,
            policy,
            channel: proposal.body.channel
          }
        }).send()
      ).rejects.toMatchObject({
        name: 'OutputProposalServiceError',
        code: 'not-found'
      })
      const invalid = new Transaction(tx.version, tx.inputs, tx.outputs, 1)
      const badRequest = {
        ...request,
        operationId: 'rejected-invalid-evidence',
        txid: invalid.id('hex'),
        beef: Utils.toBase64(invalid.toAtomicBEEF())
      }
      await expect(
        new OutputProposalTransport({
          ...common(),
          operation: 'finalize',
          request: badRequest
        }).send()
      ).rejects.toMatchObject({
        name: 'OutputProposalServiceError',
        code: 'invalid'
      })
      expect(decided).not.toHaveBeenCalled()
      expect(
        await host.journal.getOperation(author, serviceName, badRequest.operationId)
      ).toBeUndefined()
      expect((await host.journal.getProposal(proposalId))?.record.state.status).toBe('active')
      expect(host.verify).toHaveBeenCalledTimes(1)
      await assertFeed(host.feed, proposal, 'active', '1')
      await expect(
        new OutputProposalTransport({
          ...common(),
          ...original,
          operation: 'finalize'
        }).send()
      ).rejects.toMatchObject({
        name: 'OutputProposalServiceError',
        code: 'unavailable'
      })
      expect(host.verify).toHaveBeenCalledTimes(2)
      expect(committedOutcome?.status).toBe('admitted')
      expect((await host.journal.getProposal(proposalId))?.record.state.status).toBe('finalizing')
      await assertFeed(host.feed, proposal, 'finalizing', '2')
      expect(await host.overlay.findOutput(request.txid, 0, serviceName)).toMatchObject({
        txid: request.txid,
        outputIndex: 0,
        topic: serviceName,
        satoshis: 1
      })
      const reserved = (await host.journal.getProposalEntry!(proposalId))!
      expect(reserved.local?.format).toBe('proposal-service/2')
      expect(reserved.local?.verificationContext).toMatchObject({
        id: context().id,
        view: { chain: fixtureChain }
      })
      await host.close()
      Object.assign(state, {
        now: '1200',
        allowed: false,
        discovery: false,
        evidence: false,
        loseReceipt: false
      })
      host = await install(false)
      await assertFeed(host.feed, proposal, 'finalizing', '2')
      const submit = vi.spyOn(host.engine, 'submit'),
        before = decided.mock.calls.length
      const worker = new ProposalScheduler({
        source: new ProposalJournalMaintenance(host.journal),
        service: host.service
      })
      const pass = await worker.runOnce(),
        drained = await worker.stop()
      expect([...pass.failures, ...drained.failures]).toEqual([])
      expect(submit).not.toHaveBeenCalled()
      expect(host.verify).not.toHaveBeenCalled()
      expect(decided).toHaveBeenCalledTimes(before)
      const saved = (await host.journal.getProposal(proposalId))!.record
      expect(saved.state.status).toBe('finalized')
      await assertFeed(host.feed, proposal, 'finalized', '3')
      expect(saved.admission).toEqual(reserved.transition.next.admission)
      expect(saved.state).toMatchObject({
        assessmentContextId:
          committedOutcome?.status === 'admitted' ? committedOutcome.assessmentContextId : undefined
      })
      state.allowed = true
      const recovered = await new OutputProposalTransport({
        ...common(),
        ...original,
        operation: 'finalize'
      }).send()
      expect(recovered.matchesRequest).toBe(true)
      expect(recovered.response.state).toEqual(saved.state)
      await assertFeed(host.feed, proposal, 'finalized', '3')
      expect(
        (await host.journal.getOperation(author, serviceName, request.operationId))?.state
      ).toEqual(saved.state)
      expect(submit).not.toHaveBeenCalled()
    } finally {
      for (const close of closes.reverse()) await close()
      rmSync(directory, { recursive: true, force: true })
    }
  },
  60000
)

async function assertFeed(
  feed: LookupIndexFeed | undefined,
  proposal: unknown,
  status: string,
  sequence: string
) {
  if (!feed) return
  expect((await feed.head()).sequence).toBe(sequence)
  const snapshot = await feed.snapshot(sequence, null, { records: 10, bytes: 4194304 })
  expect(snapshot.complete).toBe(true)
  expect(snapshot.rows).toHaveLength(1)
  expect(snapshot.rows[0].value).toMatchObject({
    data: { version: 1, proposal, state: { status } },
    expiresAt: null
  })
  const group = await feed.group(sequence)
  expect(group.changes).toHaveLength(1)
  expect(group.changes[0].after?.value.data).toMatchObject({ proposal, state: { status } })
}
