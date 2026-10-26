import { expect, it, vi } from 'vitest'
import express from 'express'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, rateLimit } from 'express-rate-limit'
import {
  CompletedProtoWallet,
  OUTPUT_LOOKUP_PROFILE,
  OutputProtocolError,
  PrivateKey,
  outputPacketDigest,
  signOutputPacket,
  type OutputCapabilities,
  type OutputSignedPacket,
  type OutputSignedProposal
} from '@bsv/sdk'
import {
  BitcoinKnowledge,
  KnowledgeStore,
  OutputKnowledge,
  SDKEvidenceVerifier,
  knowledgeMutation
} from '@bsv/output-knowledge'
import { SQLiteJournal } from '@bsv/output-knowledge/sqlite'
import { SQLiteOperationStateStore } from '@bsv/output-knowledge/operations/sqlite'
import {
  AuthorDocumentPolicy,
  ProposalPolicyRegistry,
  ProposalChannelHeadsQuery,
  ProposalChannelHeadsSource,
  ProposalCurrentChannels,
  ProposalSourcePolicy,
  ProposalTransitions,
  proposalChannelKey
} from '@bsv/output-knowledge/proposals'
import {
  LookupProviderContracts,
  LookupProviderService,
  LookupQueryRegistry,
  LookupResponseDisclosure,
  LookupSessionCodec,
  lookupServingEpochExtension,
  type LookupProviderOptions
} from '@bsv/output-knowledge/lookup'
import { SQLiteProposalChannelStore } from '@bsv/output-knowledge/proposals/channels-sqlite'
import {
  LiveLookupSource,
  prepareLiveLookupSource,
  type LiveLookupSourceConfiguration
} from '@bsv/output-knowledge/sources/live-lookup'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { createOutputLookupRouter } from '@bsv/overlay-express/output-lookup'
import {
  author,
  recipient,
  reference,
  signed,
  scope as proposalScope
} from '../../../packages/application/output-knowledge/test/proposal-client-fixture.js'
import {
  chain,
  partition,
  context,
  resolver
} from '../../../packages/application/output-knowledge/test/evidence-fixture.js'

// The producer commits through one private journal/index/session owner. Actual
// authenticated transport and durable client receipts resume after both owners
// restart, preserving complete current-channel projection and atomic replacements.
it('keeps authenticated current-channel snapshot/live receipts resumable across native restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'proposal-current-http-')),
    app = express(),
    server = createServer({ maxHeaderSize: 65536 }, app),
    rateStore = new MemoryStore(),
    registry = new ProposalPolicyRegistry([
      { policy: new AuthorDocumentPolicy(), parameters: { maxTextBytes: 32 } }
    ]),
    parameters = { policy: reference },
    query = {},
    service = proposalScope.service
  let owner: SQLiteProposalChannelStore | undefined,
    runtime: OutputKnowledge | undefined,
    control: SQLiteOperationStateStore | undefined
  const errors: unknown[] = [],
    requests: string[] = []
  let now = 10000,
    activeRequests = 0
  const clock = () => String(Math.floor(now / 1000))
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
    const queries = new LookupQueryRegistry([
      { policy: new ProposalChannelHeadsQuery(registry), parameters }
    ])
    let manifest: OutputSignedPacket<OutputCapabilities>
    const contracts = new LookupProviderContracts(
      {
        baseURL,
        identity: author,
        chain,
        service,
        maximumAgeSeconds: '100',
        clockSkewSeconds: '2',
        allowLocalHTTP: true
      },
      queries,
      () => manifest
    )
    const lifecycle = new ProposalTransitions(
      registry,
      { chain, service },
      {
        maxLifetimeSeconds: '90',
        futureSkewSeconds: '2'
      }
    )
    const providerStorage = {
      path: join(directory, 'provider.sqlite'),
      namespace: 'private-heads',
      identity: author,
      lifecycle,
      policies: registry,
      sessionCodec: new LookupSessionCodec(contracts.recoveryTrust()),
      now: clock
    }
    owner = SQLiteProposalChannelStore.create(providerStorage)
    const sessions = owner.sessions
    const epoch = await sessions.createEpoch()
    await sessions.initializeGuard('serving')
    const describe = queries.describe()[0]
    manifest = signOutputPacket(
      'capabilities',
      {
        version: 1,
        identity: author,
        baseURL,
        chain,
        issuedAt: '10',
        expiresAt: '100',
        services: [
          {
            name: service,
            kind: 'lookup',
            ...describe,
            profiles: [
              {
                id: OUTPUT_LOOKUP_PROFILE,
                authentication: 'brc103',
                payment: 'none',
                maxRequestBytes: 1048576,
                maxResponseBytes: 4194304,
                parameters: {
                  sessionSeconds: '300',
                  replaySeconds: '600',
                  maxObservations: 1024,
                  maxWaitMs: 25000
                }
              }
            ]
          }
        ],
        extensions: lookupServingEpochExtension([{ service, epoch }])
      },
      new PrivateKey(1)
    )
    const authorize: LookupProviderOptions['authorize'] = async input => {
      if (input.principal !== recipient)
        throw new OutputProtocolError('unauthorized', 'Private reader required')
      const authorization = await owner!.authorizeLookup(reference, {
        principal: input.principal,
        access: recipient,
        guards: [
          {
            id: 'serving',
            revision: await owner!.sessions.guard('serving'),
            failure: 'unauthorized'
          }
        ]
      })
      return { access: authorization.access, guards: authorization.guards }
    }
    const createProvider = () =>
      new LookupProviderService({
        index: owner!.feed,
        sessions: owner!.sessions,
        contracts,
        authorize,
        now: clock,
        budgets: { pollMs: 5 }
      })
    const createDisclosure = () =>
      new LookupResponseDisclosure({
        sessions: owner!.sessions,
        contracts,
        authorize,
        authorizeControl: () => true
      })
    let provider = createProvider(),
      disclosure = createDisclosure()
    const authenticate = createAuthMiddleware({
      wallet: new CompletedProtoWallet(new PrivateKey(1)),
      allowUnauthenticated: true,
      transportLimits: { requestTimeoutMs: 2000 }
    })
    app.use(rateLimit({ windowMs: 60000, limit: 2000, store: rateStore }))
    app.use((request, response, next) => {
      requests.push(request.path)
      activeRequests++
      let settled = false
      const settle = () => {
        if (!settled) {
          settled = true
          activeRequests--
        }
      }
      response.once('finish', settle)
      response.once('close', settle)
      next()
    })
    app.use(
      createOutputLookupRouter({
        companion: {
          open: (...args) => provider.open(...args),
          read: (...args) => provider.read(...args),
          close: (...args) => provider.close(...args)
        },
        disclosure: {
          bind: (...args) => disclosure.bind(...args),
          control: (...args) => disclosure.control(...args)
        },
        service,
        baseURL,
        identity: author,
        chain,
        authentication: 'brc103',
        authenticate,
        manifest: () => manifest,
        now: clock,
        allowLocalHTTP: true,
        allowedOrigins: []
      })
    )
    const write = async (proposal: OutputSignedProposal) => {
      const current = await owner!.journal.getChannel(proposalChannelKey(proposal.body))
      const transition = lifecycle.put(current, proposal, author, clock())
      expect((await owner!.journal.commit(transition)).status).toBe('committed')
    }
    const first = signed({ chain, channel: '11'.repeat(32) })
    await write(first)
    await write(signed({ chain, channel: '22'.repeat(32) }))
    await write(signed({ chain, channel: '33'.repeat(32) }))
    const scope = {
      chain,
      provider: author,
      service,
      rulesDigest: describe.rulesDigest,
      queryDigest: outputPacketDigest('lookup-query', { service, query })
    }
    const selected = { ...scope, access: recipient }
    const configuration: LiveLookupSourceConfiguration = {
      id: 'current-channels',
      journalId: 'private-core',
      partition,
      generation: '0',
      scope,
      minimumPollMs: 10,
      operationTimeoutMs: 5000
    }
    const trust = contracts.recoveryTrust()
    const prepared = prepareLiveLookupSource({
      configuration,
      namespace: 'live-control',
      manifest,
      selection: { ...trust, now: clock(), maximumAgeSeconds: '100', clockSkewSeconds: '2' },
      query,
      limits: { maxBytes: 4194304, maxObservations: 4, waitMs: 0 },
      minimumReceived: '1'
    })
    const policy = new ProposalSourcePolicy(registry, recipient, [
      {
        source: selected,
        proposalService: service,
        policy: reference,
        maxLifetimeSeconds: '90',
        futureSkewSeconds: '2'
      }
    ])
    const projection = new ProposalCurrentChannels(registry, recipient, [
      { source: selected, parameters, query }
    ])
    const start = async (create: boolean) => {
      const journal = new SQLiteJournal(join(directory, 'client.sqlite'), configuration.journalId)
      const worker = new BitcoinKnowledge({
        journalId: journal.namespace,
        partition,
        nonFinal: true,
        proposals: policy,
        verifier: new SDKEvidenceVerifier(resolver),
        now: () => now
      })
      const core = new KnowledgeStore(journal, worker, { partition, now: () => now })
      if (create) await core.commit('0', knowledgeMutation({ kind: 'context', context: context() }))
      const args = [
        join(directory, 'control.sqlite'),
        prepared.namespace,
        prepared.binding
      ] as const
      control = create
        ? SQLiteOperationStateStore.create(...args, prepared.initial, prepared.limits)
        : SQLiteOperationStateStore.open(...args, prepared.limits)
      const live = new LiveLookupSource({
        configuration,
        control,
        core,
        trust,
        wallet: new CompletedProtoWallet(new PrivateKey(2)),
        now: () => now
      })
      const request = await live.connect()
      const source = new ProposalChannelHeadsSource(live, registry, parameters, query)
      runtime = new OutputKnowledge({ store: core, worker })
      const subscription = runtime.attach(source, request)
      void subscription.done.catch(error => {
        if (!(error instanceof OutputProtocolError) || error.code !== 'cancelled')
          errors.push(error)
      })
      return {
        core,
        subscription,
        read: async () => projection.project((await core.read()).proposals!)
      }
    }
    const firstClient = await start(true)
    await vi.waitFor(
      async () => {
        await runtime!.flush()
        expect(errors).toEqual([])
        expect((await firstClient.read()).sources[0]).toMatchObject({
          complete: true,
          consistent: true,
          channels: [
            { proposal: first },
            { channel: '22'.repeat(32) },
            { channel: '33'.repeat(32) }
          ]
        })
      },
      { timeout: 10000, interval: 25 }
    )
    const received = (await firstClient.core.inspect()).entries.filter(
      row => row.body.kind === 'receive'
    )
    expect(
      received.filter(
        row => row.body.kind === 'receive' && row.body.batch.coverage.phase === 'snapshot'
      ).length
    ).toBeGreaterThanOrEqual(2)
    for (const row of received)
      if (row.body.kind === 'receive') {
        expect(row.body.batch.provenance.authentication).toBe('brc103')
        expect(row.body.batch.provenance.peer).toBe(author)
      }
    firstClient.subscription.close()
    await firstClient.subscription.done.catch(() => {})
    await runtime!.close()
    runtime = undefined
    await control!.close()
    control = undefined
    await vi.waitFor(() => expect(activeRequests).toBe(0), { timeout: 5000 })
    const retained = await owner.feed.head()
    await owner.close()
    owner = undefined
    owner = SQLiteProposalChannelStore.open(providerStorage)
    expect(await owner.feed.head()).toEqual(retained)
    provider = createProvider()
    disclosure = createDisclosure()
    const successor = signed({
      chain,
      channel: first.body.channel,
      revision: '1',
      previous: outputPacketDigest('proposal', first.body)
    })
    await write(successor)
    const opens = requests.filter(path => path.endsWith('/lookup/open')).length
    const resumed = await start(false)
    await vi.waitFor(
      async () => {
        await runtime!.flush()
        expect(errors).toEqual([])
        expect((await resumed.read()).sources[0]).toMatchObject({
          consistent: true,
          channels: [{ proposal: successor, activeIntent: true, history: 'genesis-linked' }, {}, {}]
        })
      },
      { timeout: 10000, interval: 25 }
    )
    expect(requests.filter(path => path.endsWith('/lookup/open'))).toHaveLength(opens)
    expect(
      (await resumed.core.inspect()).entries.some(
        row =>
          row.body.kind === 'receive' &&
          row.body.batch.groups.some(
            group =>
              group.observations.map(item => item.kind).join(',') ===
              'proposal-remove,proposal,proposal-state'
          )
      )
    ).toBe(true)
    resumed.subscription.close()
    await resumed.subscription.done.catch(() => {})
    now = 100000
    await runtime!.flush()
    expect((await resumed.read()).sources[0].channels.every(channel => !channel.activeIntent)).toBe(
      true
    )
    expect(errors).toEqual([])
  } finally {
    await runtime?.close()
    await control?.close()
    server.closeAllConnections()
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      )
    rateStore.shutdown()
    await owner?.close()
    rmSync(directory, { recursive: true, force: true })
  }
}, 30000)
