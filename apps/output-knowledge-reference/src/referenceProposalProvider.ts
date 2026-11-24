import {
  canonicalOutputJSON,
  OUTPUT_LOOKUP_PROFILE,
  OUTPUT_PROFILES,
  OutputProtocolError,
  outputPacketDigest,
  PrivateKey,
  signOutputPacket,
  Transaction,
  type OutputCapabilities,
  type OutputSignedProposal,
  type OutputSignedPacket
} from '@bsv/sdk'
import { Engine, type TopicManager } from '@bsv/overlay'
import { OverlayProposalAdmission } from '@bsv/overlay/proposal-admission'
import {
  AuthorDocumentPolicy,
  ProposalChannelHeadsQuery,
  ProposalJournalMaintenance,
  ProposalPolicyRegistry,
  ProposalResponseDisclosure,
  ProposalScheduler,
  ProposalService,
  ProposalTransitions,
  SDKProposalEvidence,
  type ProposalAction,
  type ProposalServiceOptions
} from '@bsv/output-knowledge/proposals'
import { SQLiteProposalChannelStore } from '@bsv/output-knowledge/proposals/channels-sqlite'
import {
  LookupProviderContracts,
  LookupProviderWork,
  LookupProviderService,
  LookupResponseDisclosure,
  LookupQueryRegistry,
  LookupSessionCodec,
  lookupServingEpochExtension
} from '@bsv/output-knowledge/lookup'
import { fixtureChain, referenceContext, referenceResolver } from './fixtureChain.js'

export const REFERENCE_PROPOSAL_SERVICE = 'tm_reference_documents'
export const referenceProposalClock = () => String(Math.floor(Date.now() / 1000))

/** Fixed synthetic PRP1 marker policy. Engine independently checks every Script and proof. */
function manager(): TopicManager {
  return {
    identifyAdmissibleOutputs(beef) {
      const output = Transaction.fromBEEF(beef).outputs[0]
      return Promise.resolve({
        outputsToAdmit:
          output?.satoshis === 1 &&
          /^006a045052503120[0-9a-f]{64}$/.test(output.lockingScript.toHex())
            ? [0]
            : [],
        coinsToRetain: []
      })
    },
    getDocumentation: () =>
      Promise.resolve('One-satoshi synthetic PRP1 author-document commitments.'),
    getMetaData: () =>
      Promise.resolve({
        name: 'Working documents',
        shortDescription: 'Private synthetic proposals'
      })
  }
}

/** Separate optional host composition; existing public workbench behavior is unchanged. */
export async function createReferenceProposalProvider(options: {
  path: string
  create: boolean
  baseURL: string
  identityKey: PrivateKey
  admissionEngine: Engine
  onFailure?(error: unknown): void
}) {
  const identity = options.identityKey.toPublicKey().toString(),
    policies = new ProposalPolicyRegistry([
      { policy: new AuthorDocumentPolicy(), parameters: { maxTextBytes: 128 } }
    ]),
    description = policies.describe()[0],
    policy = { id: description.id, digest: description.digest },
    rules = { id: 'urn:reference:proposal-records:1', parameters: {} },
    rulesDigest = outputPacketDigest('service-rules', rules),
    queries = new LookupQueryRegistry([
      { policy: new ProposalChannelHeadsQuery(policies), parameters: { policy } }
    ]),
    lifecycle = new ProposalTransitions(
      policies,
      { chain: fixtureChain, service: REFERENCE_PROPOSAL_SERVICE },
      { maxLifetimeSeconds: '100', futureSkewSeconds: '2' }
    )
  let manifest: OutputSignedPacket<OutputCapabilities>
  const contracts = new LookupProviderContracts(
    {
      baseURL: options.baseURL,
      identity,
      chain: fixtureChain,
      service: REFERENCE_PROPOSAL_SERVICE,
      maximumAgeSeconds: '100',
      clockSkewSeconds: '2'
    },
    queries,
    () => manifest
  )
  const configuration = {
    path: options.path,
    namespace: 'reference-working-documents',
    identity,
    lifecycle,
    policies,
    sessionCodec: new LookupSessionCodec(contracts.recoveryTrust()),
    now: referenceProposalClock
  }
  const owner = options.create
    ? SQLiteProposalChannelStore.create(configuration)
    : SQLiteProposalChannelStore.open(configuration)
  let scheduler: ProposalScheduler | undefined,
    loop: Promise<void> | undefined,
    healthy = true,
    closed = false,
    closing: Promise<void> | undefined
  try {
    const epoch = await owner.sessions.createEpoch()
    if (options.create) await owner.sessions.initializeGuard('reference-proposal-serving')
    const now = referenceProposalClock()
    manifest = signOutputPacket<OutputCapabilities>(
      'capabilities',
      {
        version: 1,
        identity,
        baseURL: options.baseURL,
        chain: fixtureChain,
        issuedAt: now,
        expiresAt: String(BigInt(now) + 100n),
        services: [
          {
            name: REFERENCE_PROPOSAL_SERVICE,
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
                  policies: [{ ...description }],
                  maxLifetimeSeconds: '100',
                  retentionSeconds: '7200'
                }
              }
            ]
          },
          {
            name: REFERENCE_PROPOSAL_SERVICE,
            kind: 'lookup',
            ...queries.describe()[0],
            profiles: [
              {
                id: OUTPUT_LOOKUP_PROFILE,
                authentication: 'brc103',
                payment: 'none',
                maxRequestBytes: 1048576,
                maxResponseBytes: 4194304,
                parameters: {
                  sessionSeconds: '3600',
                  replaySeconds: '7200',
                  maxObservations: 1024,
                  maxWaitMs: 25000
                }
              }
            ]
          }
        ],
        extensions: lookupServingEpochExtension([{ service: REFERENCE_PROPOSAL_SERVICE, epoch }])
      },
      options.identityKey
    )
    const writers = new Set([91, 92].map(key => new PrivateKey(key).toPublicKey().toString()))
    const current = (caller: string) => healthy && !closed && writers.has(caller)
    const trust = {
      baseURL: options.baseURL,
      identity,
      maximumAgeSeconds: '100',
      clockSkewSeconds: '2',
      rules: new Map([
        [
          rules.id,
          (parameters: unknown) => {
            if (canonicalOutputJSON(parameters) !== '{}')
              throw new OutputProtocolError('unsupported', 'Unexpected reference service rules')
          }
        ]
      ])
    }
    // Own only the additional topic policy. The installer retains Mongo/tracker lifetime.
    const engine = new Engine(
      { [REFERENCE_PROPOSAL_SERVICE]: manager() },
      {},
      options.admissionEngine.storage,
      options.admissionEngine.chainTracker
    )
    const admission = new OverlayProposalAdmission({
      engine,
      identity,
      service: REFERENCE_PROPOSAL_SERVICE,
      topic: REFERENCE_PROPOSAL_SERVICE,
      rulesDigest,
      maximumOutcomeBytes: 4096
    })
    const access = (_action: ProposalAction, _proposal: OutputSignedProposal, caller: string) =>
      current(caller)
    const serviceOptions: ProposalServiceOptions = {
      lifecycle,
      storage: owner.journal,
      trust,
      manifest: () => manifest,
      now: referenceProposalClock,
      access,
      evidence: new SDKProposalEvidence(referenceResolver, () =>
        referenceContext({
          application: 'reference-working-documents',
          account: 'fixture',
          access: 'private'
        })
      ),
      admission
    }
    const service = new ProposalService(serviceOptions),
      disclosure = new ProposalResponseDisclosure({ ...serviceOptions, access })
    const authorize = async (input: { principal: string | null }) => {
      if (!input.principal || !current(input.principal))
        throw new OutputProtocolError('unauthorized', 'Current reference participant required')
      const result = await owner.authorizeLookup(policy, {
        principal: input.principal,
        access: input.principal,
        guards: [
          {
            id: 'reference-proposal-serving',
            revision: await owner.sessions.guard('reference-proposal-serving'),
            failure: 'unauthorized'
          }
        ]
      })
      return { access: result.access, guards: result.guards }
    }
    const work = new LookupProviderWork(),
      lookup = new LookupProviderService({
        index: owner.feed,
        sessions: owner.sessions,
        contracts,
        work,
        authorize,
        now: referenceProposalClock,
        budgets: { pollMs: 25 }
      }),
      nativeDisclosure = new LookupResponseDisclosure({
        sessions: owner.sessions,
        contracts,
        work,
        authorize,
        authorizeControl: principal => principal !== null && current(principal)
      })
    const lookupDisclosure = {
      bind(...args: Parameters<LookupResponseDisclosure['bind']>) {
        const binding = nativeDisclosure.bind(...args)
        return {
          enqueue(...args: Parameters<typeof binding.enqueue>) {
            const [bytes, who, send, signal] = args
            return binding.enqueue(
              bytes,
              who,
              owned => {
                if (!current(who))
                  throw new OutputProtocolError('unavailable', 'Proposal host is stopped')
                return send(owned)
              },
              signal
            )
          }
        }
      },
      control: nativeDisclosure.control.bind(nativeDisclosure)
    }
    scheduler = new ProposalScheduler({
      source: new ProposalJournalMaintenance(owner.journal),
      service,
      intervalMs: 250,
      maximumRecoveries: 2,
      pageSize: 32
    })
    const first = await scheduler.runOnce()
    if (first.failures.length)
      throw new AggregateError(
        first.failures.map(item => item.error),
        'Proposal startup recovery failed'
      )
    loop = scheduler
      .start(report => {
        if (report.failures.length)
          throw new AggregateError(
            report.failures.map(item => item.error),
            'Proposal maintenance failed'
          )
      })
      .catch(error => {
        healthy = false
        options.onFailure?.(error)
      })
    return {
      owner,
      engine,
      service,
      disclosure,
      lookup,
      lookupDisclosure,
      policy,
      current,
      manifest: () => {
        if (!healthy || closed)
          throw new OutputProtocolError('unavailable', 'Proposal host is stopped')
        return structuredClone(manifest)
      },
      refreshManifest() {
        if (!healthy || closed)
          throw new OutputProtocolError('unavailable', 'Proposal host is stopped')
        const now = referenceProposalClock()
        manifest = signOutputPacket(
          'capabilities',
          { ...manifest.body, issuedAt: now, expiresAt: String(BigInt(now) + 100n) },
          options.identityKey
        )
        return structuredClone(manifest)
      },
      close() {
        closing ??= (async () => {
          closed = true
          try {
            await scheduler!.stop()
            await loop
          } finally {
            await owner.close()
          }
        })()
        return closing
      }
    }
  } catch (error) {
    healthy = false
    try {
      await scheduler?.stop()
      await loop
    } finally {
      await owner.close()
    }
    throw error
  }
}
