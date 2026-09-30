import {
  OUTPUT_LOOKUP_PROFILE,
  CompletedProtoWallet,
  PrivateKey,
  outputPacketDigest,
  Random,
  Utils,
  type OutputJSONObject,
  type OutputSignedPacket,
  type OutputCapabilities
} from '@bsv/sdk'
import {
  BitcoinKnowledge,
  KnowledgeStore,
  OutputKnowledge,
  SDKEvidenceVerifier,
  type JournalStorage,
  type SourceSubscription
} from '@bsv/output-knowledge'
import { CollectionOutputQueryPolicy, LookupQueryRegistry } from '@bsv/output-knowledge/lookup'
import type { OperationStateLimits, OperationStateStore } from '@bsv/output-knowledge/operations'
import {
  LiveLookupSource,
  liveLookupSourceBinding,
  prepareLiveLookupSource
} from '@bsv/output-knowledge/sources/live-lookup'
import { fixtureChain, referenceContext, referenceResolver } from './fixtureChain.js'

export interface ReferenceHost {
  id: string
  baseURL: string
  identity: string
}
export type ReferenceControlFactory = (
  namespace: string,
  binding: OutputJSONObject,
  initial?: { value: OutputJSONObject; limits: Partial<OperationStateLimits> }
) => Promise<OperationStateStore>

/** The host adapter provides persistence. The same client uses SQLite or native IndexedDB. */
export async function createReferenceClient(options: {
  journal: JournalStorage
  account: 'alice' | 'bob'
  controls: ReferenceControlFactory
}) {
  const partition = {
    application: 'output-knowledge-reference',
    account: options.account,
    access: 'public'
  }
  // Public fixture identities, never signing or spending a real wallet's funds.
  const wallet = new CompletedProtoWallet(new PrivateKey(options.account === 'alice' ? 91 : 92))
  const worker = new BitcoinKnowledge({
    journalId: options.journal.namespace,
    partition,
    nonFinal: false,
    verifier: new SDKEvidenceVerifier(referenceResolver)
  })
  const core = new KnowledgeStore(options.journal, worker, { partition })
  const runtime = new OutputKnowledge({ store: core, worker })
  const controls = new Map<string, OperationStateStore>()
  const active = new Map<string, SourceSubscription>()
  const queryPolicy = new CollectionOutputQueryPolicy()
  const description = new LookupQueryRegistry([
    { policy: queryPolicy, parameters: {} }
  ]).describe()[0]
  const query = { collection: 'records' }
  async function refreshContext() {
    await runtime.setContext({
      ...referenceContext(partition),
      id: 'reference-' + Utils.toHex(Random(16))
    })
    await runtime.flush()
  }
  try {
    await refreshContext()
  } catch (error) {
    await runtime.close()
    await core.close()
    throw error
  }
  async function disconnect() {
    const subscriptions = [...active.values()]
    active.clear()
    for (const subscription of subscriptions) subscription.close()
    await Promise.all(subscriptions.map(subscription => subscription.done.catch(() => {})))
    await runtime.flush()
  }
  return {
    core,
    connectedHosts: () => [...active.keys()],
    runtime,
    wallet,
    refreshContext,
    async connect(host: ReferenceHost, manifest?: OutputSignedPacket<OutputCapabilities>) {
      if (active.has(host.id)) throw new Error('Reference source is already connected')
      const configuration = {
        id: host.id,
        journalId: options.journal.namespace,
        partition,
        generation: '0',
        scope: {
          chain: { ...fixtureChain },
          provider: host.identity,
          service: 'reference-records',
          rulesDigest: description.rulesDigest,
          queryDigest: outputPacketDigest('lookup-query', { service: 'reference-records', query })
        }
      }
      const trust = {
        baseURL: host.baseURL,
        identity: host.identity,
        chain: { ...fixtureChain },
        kind: 'lookup' as const,
        service: 'reference-records',
        profile: OUTPUT_LOOKUP_PROFILE,
        maximumAgeSeconds: '86400',
        clockSkewSeconds: '2',
        allowLocalHTTP: true,
        rules: new Map([
          [
            queryPolicy.id,
            (parameters: unknown) => {
              queryPolicy.parameters(parameters)
            }
          ]
        ])
      }
      let control = controls.get(host.id)
      if (!control) {
        const prepared = manifest
          ? prepareLiveLookupSource({
              configuration,
              namespace: host.id,
              manifest,
              selection: { ...trust, now: String(Math.floor(Date.now() / 1000)) },
              query,
              limits: { maxBytes: 4194304, maxObservations: 2, waitMs: 1000 },
              minimumReceived: (await core.revision()).received
            })
          : undefined
        control = await options.controls(
          host.id,
          liveLookupSourceBinding(configuration),
          prepared ? { value: prepared.initial, limits: prepared.limits } : undefined
        )
        controls.set(host.id, control)
      }
      const source = new LiveLookupSource({ configuration, control, core, trust, wallet })
      const request = await source.connect()
      const subscription = runtime.attach(source, request)
      active.set(host.id, subscription)
      void subscription.done
        .finally(() => {
          if (active.get(host.id) === subscription) active.delete(host.id)
        })
        .catch(() => {})
    },
    disconnect,
    async close() {
      await disconnect()
      await runtime.close()
      for (const control of controls.values()) await control.close()
      await core.close()
    }
  }
}
