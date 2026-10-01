import {
  PrivateKey,
  OUTPUT_LOOKUP_PROFILE,
  signOutputPacket,
  selectOutputCapability,
  outputPacketDigest,
  OutputProtocolError,
  type OutputCapabilityRequest,
  type OutputJSONObject
} from '@bsv/sdk'
import {
  BitcoinKnowledge,
  IndexedDBJournal,
  KnowledgeStore,
  knowledgeMutation,
  type SourceBatch
} from '@bsv/output-knowledge'
import { IndexedDBOperationStateStore } from '@bsv/output-knowledge/operations'
import { proposalBrowser } from './proposals.js'
import {
  LiveLookupSource,
  prepareLiveLookupSource,
  liveLookupSourceBinding,
  type LiveLookupSourceConfiguration
} from '@bsv/output-knowledge/sources/live-lookup'

// Public synthetic fixture. This harness qualifies native storage and source
// recovery, not HTTP authentication, chain verification or provider durability.
const chain = { network: 'browser-storage-fixture', genesisHash: '01'.repeat(32) }
const partition = { application: 'browser-storage-fixture', account: 'alice', access: 'public' }
const key = new PrivateKey(1)
const identity = key.toPublicKey().toString()
const rules = { id: 'https://example.test/browser-storage-rules/1', parameters: {} }
const rulesDigest = outputPacketDigest('service-rules', rules)
const query = { collection: 'records' }
const manifest = signOutputPacket(
  'capabilities',
  {
    version: 1,
    identity,
    baseURL: location.origin,
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
            authentication: 'none',
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
  baseURL: location.origin,
  identity,
  chain,
  kind: 'lookup',
  service: 'records',
  profile: OUTPUT_LOOKUP_PROFILE,
  now: '1000',
  maximumAgeSeconds: '200',
  clockSkewSeconds: '2',
  allowLocalHTTP: true,
  rules: new Map([[rules.id, () => {}]])
}
const scope = {
  chain,
  provider: location.origin,
  service: 'records',
  rulesDigest,
  queryDigest: outputPacketDigest('lookup-query', { service: 'records', query })
}
const configuration: LiveLookupSourceConfiguration = {
  id: 'catalogue',
  journalId: 'browser-core',
  partition,
  generation: '0',
  scope,
  minimumPollMs: 1
}
let core: KnowledgeStore, control: IndexedDBOperationStateStore, source: LiveLookupSource
let iterator: AsyncIterator<SourceBatch>, previous: SourceBatch | undefined
const requests: OutputJSONObject[] = []
const headers = selectOutputCapability(manifest, selection).headers

async function initialize(create: boolean) {
  const journal = await IndexedDBJournal.open('browser-receipts', configuration.journalId)
  const worker = new BitcoinKnowledge({
    journalId: configuration.journalId,
    partition,
    nonFinal: false,
    verifier: {
      verify: () => Promise.reject(new Error('Storage-only fixture must not verify evidence'))
    }
  })
  core = new KnowledgeStore(journal, worker, { partition })
  if (create) {
    await core.commit(
      '0',
      knowledgeMutation({
        kind: 'context',
        context: {
          id: 'browser-context',
          partition,
          generation: '0',
          view: {
            id: 'browser-view',
            chain,
            tipHash: '02'.repeat(32),
            tipHeight: '0',
            medianTimePast: '900',
            chainPolicyDigest: '03'.repeat(32)
          },
          policyDigest: '04'.repeat(32),
          now: '1000',
          limits: { bytes: 4194304, transactions: 4096, dependencies: 16384, deadline: '2000' }
        }
      })
    )
    const prepared = prepareLiveLookupSource({
      configuration,
      namespace: 'browser-lookup',
      manifest,
      selection,
      query,
      limits: { maxBytes: 4194304, maxObservations: 1024, waitMs: 0 },
      minimumReceived: '1'
    })
    control = await IndexedDBOperationStateStore.create(
      'browser-control',
      prepared.namespace,
      prepared.binding,
      prepared.initial
    )
  } else
    control = await IndexedDBOperationStateStore.open(
      'browser-control',
      'browser-lookup',
      liveLookupSourceBinding(configuration)
    )
  source = new LiveLookupSource({
    configuration,
    core,
    control,
    trust: selection,
    now: () => 1000000,
    fetch: (_url, init) =>
      Promise.resolve().then(() => {
        const request = JSON.parse(String(init?.body)) as OutputJSONObject
        requests.push(request)
        return new Response(
          JSON.stringify({
            version: 1,
            session: 'browser-session',
            scope: { ...scope, access: 'public', epoch: 'epoch' },
            phase: request.requestId ? 'snapshot' : 'live',
            groups: [],
            cursor: request.requestId ? 'snapshot-cursor' : 'live-cursor',
            snapshotComplete: true,
            through: '5',
            highWater: '5',
            expiresAt: '1300',
            replayUntil: '1900',
            limits: request.limits
          }),
          { headers }
        )
      })
  })
  const request = await source.connect()
  iterator = source.open(request, new AbortController().signal)[Symbol.asyncIterator]()
  return inspect()
}
async function inspect() {
  return { saved: await control.read(), revision: await core.revision(), requests: [...requests] }
}
async function pull() {
  const result = await iterator.next()
  if (result.done) throw new Error('Unexpected source completion')
  previous = result.value
  return previous
}
async function receive() {
  if (!previous) throw new Error('Pull a source batch before receiving it')
  const revision = await core.revision()
  return core.commit(revision.received, knowledgeMutation({ kind: 'receive', batch: previous }))
}
async function cas(create: boolean, revision?: string, candidate?: string) {
  const store = create
    ? await IndexedDBOperationStateStore.create('browser-cas', 'race', { profile: 'fixture/1' }, {})
    : await IndexedDBOperationStateStore.open('browser-cas', 'race', { profile: 'fixture/1' })
  try {
    if (revision === undefined) return await store.read()
    if (candidate === undefined) throw new Error('CAS candidate is required')
    return await store.compareAndSwap(revision, { candidate })
  } finally {
    await store.close()
  }
}
async function missing() {
  try {
    const store = await IndexedDBOperationStateStore.open('missing-control', 'absent', {})
    await store.close()
    throw new Error('Unexpected initialization during recovery')
  } catch (error) {
    if (!(error instanceof OutputProtocolError) || error.code !== 'unavailable') throw error
    return { code: error.code, databases: (await indexedDB.databases()).map(db => db.name) }
  }
}
async function loseCore() {
  await iterator.return?.()
  await core.close()
  await control.close()
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('browser-receipts')
    request.onblocked = () => reject(new Error('Unexpected remaining core database owner'))
    request.onerror = () => reject(request.error ?? new Error('Core database deletion failed'))
    request.onsuccess = () => resolve()
  })
  requests.length = 0
  try {
    await initialize(false)
    throw new Error('Lost core unexpectedly authorized cursor recovery')
  } catch (error) {
    if (!(error instanceof OutputProtocolError) || error.code !== 'reset-required') throw error
    return { code: error.code, requests: [...requests] }
  }
}
const api = {
  initialize,
  inspect,
  pull,
  receive,
  cas,
  missing,
  loseCore,
  proposals: proposalBrowser
}
declare global {
  interface Window {
    outputKnowledgeBrowser: typeof api
  }
}
window.outputKnowledgeBrowser = api
