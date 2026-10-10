import {
  OUTPUT_LOOKUP_PROFILE,
  PrivateKey,
  parseOutputCapabilities,
  signOutputPacket,
  type OutputCapabilities,
  type OutputSignedPacket
} from '@bsv/sdk'
import { SDKEvidenceVerifier } from '@bsv/output-knowledge'
import {
  CollectionOutputQueryPolicy,
  collectionOutputIndexKey,
  LookupProviderContracts,
  LookupProviderService,
  LookupResponseDisclosure,
  LookupProviderWork,
  type LookupAuthorizationContext,
  LookupQueryRegistry,
  LookupSessionCodec,
  lookupServingEpochExtension,
  type LookupIndexEdit
} from '@bsv/output-knowledge/lookup'
import { SQLiteLookupIndex, SQLiteLookupSessions } from '@bsv/output-knowledge/lookup/sqlite'
import {
  fixtureChain,
  referenceContext,
  referenceEvidence,
  referenceResolver,
  type FixtureRecord
} from './fixtureChain.js'

export const REFERENCE_SERVICE = 'reference-records'
export const referenceNow = () => String(Math.floor(Date.now() / 1000))
const binding = { application: 'output-knowledge-reference', version: 1 }

export interface ReferenceProducerContext {
  path: string
  create: boolean
  identity: string
  index: SQLiteLookupIndex
}
export interface ReferenceProducer {
  publish(): Promise<string>
  replace(): Promise<string>
  withdraw(): Promise<string>
  reintroduce(): Promise<string>
  recover(): Promise<string>
  close(): Promise<void>
}
export type ReferenceProducerFactory = (
  context: ReferenceProducerContext
) => ReferenceProducer | Promise<ReferenceProducer>

/** Loopback workbench. Admission and fixture producers are explicit installations. */
export async function createReferenceProvider(options: {
  path: string
  create: boolean
  baseURL: string
  identityKey: PrivateKey
  producer?: ReferenceProducerFactory
}) {
  const index = options.create
    ? SQLiteLookupIndex.create(options.path, REFERENCE_SERVICE, binding)
    : SQLiteLookupIndex.open(options.path, REFERENCE_SERVICE, binding)
  try {
    const queries = new LookupQueryRegistry([
      { policy: new CollectionOutputQueryPolicy(), parameters: {} }
    ])
    const trust = {
      baseURL: options.baseURL,
      identity: options.identityKey.toPublicKey().toString(),
      chain: { ...fixtureChain },
      service: REFERENCE_SERVICE,
      maximumAgeSeconds: '86400',
      clockSkewSeconds: '2',
      allowLocalHTTP: true
    }
    let manifest: OutputSignedPacket<OutputCapabilities>
    const contracts = new LookupProviderContracts(trust, queries, () => manifest)
    const codec = new LookupSessionCodec(contracts.recoveryTrust())
    const sessions = options.create
      ? SQLiteLookupSessions.create(index, codec, referenceNow)
      : SQLiteLookupSessions.open(index, codec, referenceNow)
    const epoch = await sessions.createEpoch()
    if (options.create) await sessions.initializeGuard('reference-serving')
    const now = referenceNow()
    manifest = parseOutputCapabilities(
      signOutputPacket(
        'capabilities',
        {
          version: 1,
          identity: trust.identity,
          baseURL: options.baseURL,
          chain: fixtureChain,
          issuedAt: now,
          expiresAt: String(BigInt(now) + 86400n),
          services: [
            {
              name: REFERENCE_SERVICE,
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
          extensions: lookupServingEpochExtension([{ service: REFERENCE_SERVICE, epoch }])
        },
        options.identityKey
      ),
      true
    )
    const authorize = async (context: LookupAuthorizationContext) => ({
      access: context.principal ?? 'unverified',
      guards: [
        {
          id: 'reference-serving',
          revision: await sessions.guard('reference-serving'),
          failure: 'unauthorized' as const
        }
      ]
    })
    const work = new LookupProviderWork()
    const disclosure = new LookupResponseDisclosure({
      sessions,
      contracts,
      authorize,
      work,
      authorizeControl: principal => principal !== null
    })
    const service = new LookupProviderService({
      index,
      sessions,
      contracts,
      now: referenceNow,
      authorize,
      work,
      budgets: { pollMs: 50 }
    })
    const verifier = new SDKEvidenceVerifier(referenceResolver)
    async function update(publish: FixtureRecord[], withdraw: FixtureRecord[]) {
      await Promise.all(
        publish.map(async name => {
          const result = await verifier.verify(
            referenceEvidence(name),
            referenceContext({
              application: 'reference-publisher',
              account: trust.identity,
              access: 'public'
            }),
            new AbortController().signal
          )
          if (result.status !== 'verified')
            throw new Error(
              'Reference publication failed Script/SPV verification: ' + result.status
            )
        })
      )
      const head = await index.head()
      const candidates = await Promise.all(
        [...publish, ...withdraw].map(async name => {
          const evidence = referenceEvidence(name).evidence
          const key = collectionOutputIndexKey(evidence)
          const row = await index.row(key, head.sequence)
          if (!publish.includes(name) && row === null) return undefined
          return {
            key,
            previous: row?.revision ?? null,
            next: publish.includes(name)
              ? {
                  expiresAt: null,
                  data: {
                    collection: 'records',
                    audience: 'public',
                    output: { evidence: { ...evidence } }
                  }
                }
              : null
          } satisfies LookupIndexEdit
        })
      )
      const edits = candidates.filter(
        (edit): edit is NonNullable<typeof edit> => edit !== undefined
      )
      if (edits.length === 0) return head.sequence
      const group = await index.commit({
        base: head.sequence,
        evaluatedAt: referenceNow(),
        edits,
        event: { type: 'reference-explicit-producer-command/1' }
      })
      return group.sequence
    }
    const producer: ReferenceProducer = options.producer
      ? await options.producer({
          path: options.path,
          create: options.create,
          identity: trust.identity,
          index
        })
      : {
          publish: async () => {
            await update(['A', 'Q'], [])
            return update(['X'], [])
          },
          replace: () => update(['AC'], ['A']),
          withdraw: () => update([], ['Q']),
          reintroduce: () => update(['A'], []),
          recover: async () => (await index.head()).sequence,
          close: () => Promise.resolve()
        }
    return {
      index,
      sessions,
      service,
      disclosure,
      contracts,
      trust,
      manifest: () => structuredClone(manifest),
      producerKind: options.producer ? ('admission' as const) : ('fixture' as const),
      publish: () => producer.publish(),
      replace: () => producer.replace(),
      withdraw: () => producer.withdraw(),
      reintroduce: () => producer.reintroduce(),
      recover: () => producer.recover(),
      close: async () => {
        try {
          await producer.close()
        } finally {
          await index.close()
        }
      }
    }
  } catch (error) {
    await index.close()
    throw error
  }
}
