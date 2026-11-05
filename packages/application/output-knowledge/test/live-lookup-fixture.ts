import {
  PrivateKey,
  OUTPUT_LOOKUP_PROFILE,
  signOutputPacket,
  selectOutputCapability,
  outputPacketDigest,
  type OutputCapabilityRequest,
  type OutputLookupBatch,
  type OutputLookupOpen
} from '@bsv/sdk'
import {
  BitcoinKnowledge,
  KnowledgeStore,
  SDKEvidenceVerifier,
  knowledgeMutation
} from '../src/index.js'
import { SQLiteJournal } from '../src/storage/SQLiteJournal.js'
import { SQLiteOperationStateStore } from '../src/operations/SQLiteOperationStateStore.js'
import {
  prepareLiveLookupSource,
  type LiveLookupSourceConfiguration
} from '../src/sources/LiveLookupConfiguration.js'
import { chain, partition, context, resolver } from './evidence-fixture.js'

export function liveFixture(
  configuration: Partial<LiveLookupSourceConfiguration> = {},
  endpoint = 'https://lookup.example.test/api',
  authentication: 'none' | 'brc103' = 'none'
) {
  const key = new PrivateKey(1),
    identity = key.toPublicKey().toString()
  const baseURL = endpoint
  const rules = { id: 'https://example.test/lookup-rules/1', parameters: {} }
  const rulesDigest = outputPacketDigest('service-rules', rules)
  const query = { collection: 'records' }
  const manifest = signOutputPacket(
    'capabilities',
    {
      version: 1,
      identity,
      baseURL,
      chain,
      issuedAt: '900',
      expiresAt: '1200',
      services: [
        {
          name: 'records',
          kind: 'lookup',
          rules,
          rulesDigest,
          profiles: [
            {
              id: OUTPUT_LOOKUP_PROFILE,
              authentication,
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
      ]
    },
    key
  )
  const selection: OutputCapabilityRequest = {
    baseURL,
    identity,
    chain,
    kind: 'lookup',
    service: 'records',
    profile: OUTPUT_LOOKUP_PROFILE,
    now: '1000',
    maximumAgeSeconds: '200',
    clockSkewSeconds: '2',
    allowLocalHTTP: baseURL.startsWith('http://127.0.0.1:'),
    rules: new Map([[rules.id, () => {}]])
  }
  const scope = {
    chain,
    provider: authentication === 'brc103' ? identity : new URL(baseURL).origin,
    service: 'records',
    rulesDigest,
    queryDigest: outputPacketDigest('lookup-query', { service: 'records', query })
  }
  const config: LiveLookupSourceConfiguration = {
    id: 'catalogue',
    journalId: 'test',
    partition,
    generation: '3',
    scope,
    minimumPollMs: 1,
    ...configuration
  }
  const options = {
    configuration: config,
    namespace: 'lookup-job',
    manifest,
    selection,
    query,
    limits: { maxBytes: 4194304, maxObservations: 1024, waitMs: 0 },
    minimumReceived: '1'
  }
  const prepared = prepareLiveLookupSource(options)
  const open = (prepared.initial.original as unknown as { open: OutputLookupOpen }).open
  const packet: OutputLookupBatch = {
    version: 1,
    session: 'session',
    scope: { ...scope, access: 'public', epoch: 'epoch-1' },
    phase: 'snapshot',
    groups: [],
    cursor: 'cursor-1',
    snapshotComplete: true,
    through: '5',
    highWater: '5',
    expiresAt: '1300',
    replayUntil: '1900',
    limits: open.limits
  }
  const headers = selectOutputCapability(manifest, selection).headers
  const response = (value: unknown = packet): Response =>
    new Response(JSON.stringify(value), { headers })
  return { config, prepared, open, packet, options, response, selection }
}

export async function liveStores(path: string, fixture = liveFixture(), create = true) {
  const journal = new SQLiteJournal(`${path}/receipts.sqlite`, fixture.config.journalId)
  const worker = new BitcoinKnowledge({
    journalId: journal.namespace,
    partition,
    nonFinal: false,
    verifier: new SDKEvidenceVerifier(resolver)
  })
  const core = new KnowledgeStore(journal, worker, { partition })
  if (create) await core.commit('0', knowledgeMutation({ kind: 'context', context: context() }))
  const args = [
    `${path}/control.sqlite`,
    fixture.prepared.namespace,
    fixture.prepared.binding
  ] as const
  const control = create
    ? SQLiteOperationStateStore.create(...args, fixture.prepared.initial, fixture.prepared.limits)
    : SQLiteOperationStateStore.open(...args, fixture.prepared.limits)
  return { core, control, journal, worker }
}
