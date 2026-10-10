import {
  CompletedProtoWallet,
  OutputProtocolError,
  PrivateKey,
  Random,
  Utils,
  outputPacketDigest,
  type OutputCapabilities,
  type OutputSignedPacket
} from '@bsv/sdk'
import {
  BitcoinKnowledge,
  KnowledgeStore,
  OutputKnowledge,
  SDKEvidenceVerifier,
  type JournalStorage,
  type SourceSubscription
} from '@bsv/output-knowledge'
import {
  AuthorDocumentPolicy,
  ProposalChannelHeadsQuery,
  ProposalChannelHeadsSource,
  ProposalCurrentChannels,
  ProposalPolicyRegistry,
  ProposalSourcePolicy
} from '@bsv/output-knowledge/proposals'
import { LookupProviderContracts, LookupQueryRegistry } from '@bsv/output-knowledge/lookup'
import {
  LiveLookupSource,
  liveLookupSourceBinding,
  prepareLiveLookupSource
} from '@bsv/output-knowledge/sources/live-lookup'
import type { OperationStateStore } from '@bsv/output-knowledge/operations'
import type { ReferenceControlFactory, ReferenceHost } from './referenceClient.js'
import { fixtureChain, referenceContext, referenceResolver } from './fixtureChain.js'

/** Explicit workbench installation; the ordinary final-output client remains unchanged. */
export async function createReferenceProposalClient(options: {
  journal: JournalStorage
  controls: ReferenceControlFactory
  /** Version one uses the signed proposal service name for its lookup scope too. */
  host: ReferenceHost & { service: string }
  /** Public synthetic identity only, never a production funding/signing key. */
  identityKey: PrivateKey
  maxTextBytes?: number
  maxLifetimeSeconds?: string
  now?: () => number
  fetch?: typeof fetch
}) {
  const host = { ...options.host },
    createControl = options.controls,
    fetch = options.fetch,
    now = options.now ?? Date.now,
    clock = () => String(Math.floor(now() / 1000)),
    reader = options.identityKey.toPublicKey().toString(),
    wallet = new CompletedProtoWallet(options.identityKey),
    policies = new ProposalPolicyRegistry([
      {
        policy: new AuthorDocumentPolicy(),
        parameters: { maxTextBytes: options.maxTextBytes ?? 128 }
      }
    ]),
    description = policies.describe()[0],
    policy = { id: description.id, digest: description.digest },
    parameters = { policy },
    query = {},
    queries = new LookupQueryRegistry([
      { policy: new ProposalChannelHeadsQuery(policies), parameters }
    ]),
    partition = { application: 'reference-proposals', account: reader, access: 'private' },
    scope = {
      chain: { ...fixtureChain },
      provider: host.identity,
      service: host.service,
      rulesDigest: queries.describe()[0].rulesDigest,
      queryDigest: outputPacketDigest('lookup-query', { service: host.service, query })
    },
    selected = { ...scope, access: reader },
    contracts = new LookupProviderContracts(
      {
        baseURL: host.baseURL,
        identity: host.identity,
        chain: fixtureChain,
        service: host.service,
        maximumAgeSeconds: '100',
        clockSkewSeconds: '2',
        allowLocalHTTP: true
      },
      queries,
      () => {
        throw new Error('Recovered subscriptions do not discover a replacement capability')
      }
    ),
    trust = contracts.recoveryTrust(),
    configuration = {
      id: host.id,
      journalId: options.journal.namespace,
      partition,
      generation: '0',
      scope,
      minimumPollMs: 10,
      operationTimeoutMs: 5000
    },
    sourcePolicy = new ProposalSourcePolicy(policies, reader, [
      {
        source: selected,
        proposalService: host.service,
        policy,
        maxLifetimeSeconds: options.maxLifetimeSeconds ?? '100',
        futureSkewSeconds: '2'
      }
    ]),
    projection = new ProposalCurrentChannels(policies, reader, [
      { source: selected, parameters, query }
    ]),
    worker = new BitcoinKnowledge({
      journalId: options.journal.namespace,
      partition,
      nonFinal: true,
      proposals: sourcePolicy,
      verifier: new SDKEvidenceVerifier(referenceResolver),
      now
    }),
    core = new KnowledgeStore(options.journal, worker, { partition, now }),
    runtime = new OutputKnowledge({ store: core, worker })
  let control: OperationStateStore | undefined,
    subscription: SourceSubscription | undefined,
    live: LiveLookupSource | undefined,
    connecting: Promise<SourceSubscription> | undefined
  const failures: unknown[] = []
  try {
    const context = referenceContext(partition)
    context.id = 'reference-proposals-' + Utils.toHex(Random(16))
    context.now = clock()
    context.limits.deadline = String(BigInt(clock()) + 60n)
    await runtime.setContext(context)
    await runtime.flush()
  } catch (error) {
    await runtime.close()
    await core.close()
    throw error
  }
  const disconnect = async () => {
    await Promise.allSettled(connecting ? [connecting] : [])
    subscription?.close()
    await subscription?.done.catch(() => {})
    subscription = undefined
    await runtime.flush()
  }
  return {
    core,
    runtime,
    failures: () => [...failures],
    async connect(manifest?: OutputSignedPacket<OutputCapabilities>) {
      if (connecting) return connecting
      if (subscription) throw new Error('Reference proposal source is already connected')
      const attempt = (async () => {
        if (!control) {
          const prepared = manifest
            ? prepareLiveLookupSource({
                configuration,
                namespace: host.id,
                manifest,
                selection: {
                  ...trust,
                  now: clock(),
                  maximumAgeSeconds: '100',
                  clockSkewSeconds: '2'
                },
                query,
                limits: { maxBytes: 4194304, maxObservations: 4, waitMs: 1000 },
                minimumReceived: (await core.revision()).received
              })
            : undefined
          // No manifest means open existing custody. The factory must fail if it is
          // absent; it must never create a new Open as a recovery fallback.
          control = await createControl(
            host.id,
            liveLookupSourceBinding(configuration),
            prepared ? { value: prepared.initial, limits: prepared.limits } : undefined
          )
        }
        live ??= new LiveLookupSource({
          configuration,
          control,
          core,
          trust,
          wallet,
          now,
          fetch
        })
        const request = await live.connect()
        const source = new ProposalChannelHeadsSource(live, policies, parameters, query)
        subscription = runtime.attach(source, request)
        void subscription.done.catch(error => {
          if (!(error instanceof OutputProtocolError) || error.code !== 'cancelled')
            failures.push(error)
        })
        return subscription
      })()
      connecting = attempt
      try {
        return await attempt
      } finally {
        if (connecting === attempt) connecting = undefined
      }
    },
    async readCurrent() {
      await runtime.flush()
      const view = await core.read()
      if (!view.proposals) throw new Error('Non-final proposal publication is unavailable')
      return projection.project(view.proposals)
    },
    disconnect,
    async close() {
      await disconnect()
      await runtime.close()
      await control?.close()
      await core.close()
    }
  }
}
