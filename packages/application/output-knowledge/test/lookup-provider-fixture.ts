import { asyncValues } from '../src/internal/asyncValues.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PrivateKey,
  OUTPUT_LOOKUP_PROFILE,
  outputPacketDigest,
  parseOutputCapabilities,
  signOutputPacket,
  type OutputCapabilities,
  type OutputSignedPacket,
  type OutputLookupBatch
} from '@bsv/sdk'
import {
  CollectionOutputQueryPolicy,
  collectionOutputIndexKey
} from '../src/lookup/CollectionOutputQueryPolicy.js'
import { LookupQueryRegistry } from '../src/lookup/LookupQueryRegistry.js'
import { LookupProviderContracts } from '../src/lookup/LookupProviderContracts.js'
import {
  LookupProviderService,
  type LookupAuthorizationContext,
  type LookupProviderOptions,
  type LookupProviderResponse
} from '../src/lookup/LookupProviderService.js'
import { LookupSessionCodec } from '../src/lookup/LookupSessionCodec.js'
import { SQLiteLookupIndex } from '../src/lookup/SQLiteLookupIndex.js'
import { SQLiteLookupSessions } from '../src/lookup/SQLiteLookupSessions.js'
import { lookupServingEpochExtension } from '../src/lookup/LookupServingEpoch.js'
import type { LookupSessionStorage } from '../src/lookup/LookupSessionStorage.js'
import type { LookupIndexStorage } from '../src/lookup/LookupIndexStorage.js'

// Exact captured root BEEF from fixtures/reconciliation-vectors.json. Keeping
// this small fixture independent of import.meta permits ESM and CJS HTTP tests.
const rootEvidence = {
  txid: 'f960d4b8db0fb91eea28e5d6f90c834d3896054b47f44d925b5f10ed3a2d9e3d',
  beef: 'AQEBAT2eLTrtEF9bkk30R0sFljhNgwz51uUo6h65D9u41GD5AQC+7wEAAQEAAj2eLTrtEF9bkk30R0sFljhNgwz51uUo6h65D9u41GD5AQEAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/////AwIBAf////8BQEIPAAAAAAAZdqkU28OWq1LUTIuQHDyOThXqHa8EhZeIrAAAAAABAA=='
}
const chain = {
  network: 'brc-reconciliation-fixture',
  genesisHash: '441bd5b216ffe8c20d9355885f00364c4c0a636ad852027ab816a8c0d1084628'
}

export function providerEntry(
  outputIndex: number,
  audience: 'public' | string[] = 'public',
  expiresAt: string | null = null
) {
  const evidence = {
    ...rootEvidence,
    outputIndex
  }
  return {
    key: collectionOutputIndexKey(evidence),
    previous: null,
    next: { data: { collection: 'records', audience, output: { evidence } }, expiresAt }
  }
}
export const providerBatch = (response: LookupProviderResponse): OutputLookupBatch =>
  JSON.parse(response.body) as OutputLookupBatch
export function providerRead(batch: OutputLookupBatch, waitMs = 0) {
  return {
    version: 1 as const,
    session: batch.session,
    cursor: batch.cursor,
    limits: { ...batch.limits, waitMs }
  }
}

export async function providerFixture(
  authentication: 'none' | 'brc103' = 'none',
  baseURL = 'https://lookup.example.test/api'
) {
  const directory = await mkdtemp(join(tmpdir(), 'lookup-provider-')),
    path = join(directory, 'index.db')
  const binding = { service: 'records', test: 'provider' }
  const index = SQLiteLookupIndex.create(path, 'records', binding),
    stores = [index]
  const clock = { now: '1000' }
  const source = {
    selection: {
      baseURL,
      identity: new PrivateKey(1).toPublicKey().toString(),
      chain,
      service: 'records',
      maximumAgeSeconds: '10000',
      clockSkewSeconds: '2',
      allowLocalHTTP: baseURL.startsWith('http://127.0.0.1:')
    },
    open: {
      version: 1 as const,
      service: 'records',
      requestId: 'provider-opening-00000000',
      query: { collection: 'records' },
      limits: { maxBytes: 4194304, maxObservations: 1024, waitMs: 0 }
    }
  }
  const queries = new LookupQueryRegistry([
    { policy: new CollectionOutputQueryPolicy(), parameters: {} }
  ])
  let manifest: OutputSignedPacket<OutputCapabilities>
  const contracts = new LookupProviderContracts(
    { ...source.selection, maximumAgeSeconds: '10000' },
    queries,
    () => manifest
  )
  const codec = new LookupSessionCodec(contracts.recoveryTrust())
  const sessions = SQLiteLookupSessions.create(index, codec, () => clock.now)
  const epoch = await sessions.createEpoch()
  await sessions.initializeGuard('serving')
  const describe = queries.describe()[0]
  const sign = (nextEpoch: string, issuedAt = '900', expiresAt = '1200') =>
    parseOutputCapabilities(
      signOutputPacket(
        'capabilities',
        {
          version: 1,
          identity: source.selection.identity,
          baseURL,
          chain,
          issuedAt,
          expiresAt,
          services: [
            {
              name: 'records',
              kind: 'lookup',
              ...describe,
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
          ],
          extensions: lookupServingEpochExtension([{ service: 'records', epoch: nextEpoch }])
        },
        new PrivateKey(1)
      ),
      baseURL.startsWith('http://127.0.0.1:')
    )
  manifest = sign(epoch)
  const caller = {
    principal: authentication === 'none' ? null : new PrivateKey(2).toPublicKey().toString(),
    capabilityDigest: outputPacketDigest('capabilities', manifest.body)
  }
  const hooks: { authorization?: (context: LookupAuthorizationContext) => Promise<void> } = {}
  const authorize: LookupProviderOptions['authorize'] = async context => {
    await hooks.authorization?.(context)
    return {
      access: context.principal ?? 'public',
      guards: [
        { id: 'serving', revision: await sessions.guard('serving'), failure: 'unauthorized' }
      ]
    }
  }
  function provider(
    selectedIndex: LookupIndexStorage = index,
    selectedSessions: LookupSessionStorage = sessions,
    options: Partial<LookupProviderOptions> = {}
  ) {
    return new LookupProviderService({
      index: selectedIndex,
      sessions: selectedSessions,
      contracts,
      now: () => clock.now,
      authorize,
      budgets: { pollMs: 5 },
      ...options
    })
  }
  const service = provider()
  return {
    directory,
    path,
    index,
    sessions,
    codec,
    clock,
    source,
    manifest: () => structuredClone(manifest),
    queries,
    contracts,
    epoch,
    caller,
    hooks,
    open: { ...source.open, requiredRulesDigest: describe.rulesDigest },
    service,
    provider,
    async rotate() {
      const next = await sessions.createEpoch()
      manifest = sign(next, clock.now, (BigInt(clock.now) + 1000n).toString())
      return { ...caller, capabilityDigest: outputPacketDigest('capabilities', manifest.body) }
    },
    peer() {
      const peerIndex = SQLiteLookupIndex.open(path, 'records', binding)
      stores.push(peerIndex)
      const peerSessions = SQLiteLookupSessions.open(peerIndex, codec, () => clock.now)
      return {
        index: peerIndex,
        sessions: peerSessions,
        service: provider(peerIndex, peerSessions)
      }
    },
    async cleanup() {
      for await (const store of asyncValues(stores)) await store.close()
      await rm(directory, { recursive: true, force: true })
    }
  }
}
