import { jest } from '@jest/globals'
import {
  CompletedProtoWallet,
  OUTPUT_PROFILES,
  outputPacketDigest,
  retainOutputCapability,
  signOutputPacket,
  type OutputCapabilityRequest,
  type OutputCapabilities
} from '../../../mod.js'
import {
  OutputRootEvictionTransport,
  type OutputRootEvictionTransportOptions
} from '../OutputRootEvictionTransport.js'
import {
  rootKey,
  requesterKey,
  rootChain,
  rootPolicy,
  signedRootRequest,
  rootResultBody
} from './OutputRootEvictionProtocol.fixture.js'

export function rootTransportFixture(
  overrides: Partial<OutputRootEvictionTransportOptions> = {},
  change?: (manifest: OutputCapabilities) => void,
  trustOverrides: Partial<OutputCapabilityRequest> = {}
) {
  const rules = { id: 'urn:test:root:manual:1', parameters: { mode: 'manual' } }
  const trust: OutputCapabilityRequest = {
    baseURL: 'https://root.example.test/api',
    identity: rootKey.toPublicKey().toString(),
    chain: rootChain,
    kind: 'coordination',
    service: 'root-advertisements',
    profile: OUTPUT_PROFILES.eviction,
    now: '100',
    maximumAgeSeconds: '100',
    clockSkewSeconds: '0',
    rules: new Map([[rules.id, () => {}]]),
    ...trustOverrides
  }
  const manifest: OutputCapabilities = {
    version: 1,
    baseURL: trust.baseURL,
    identity: trust.identity,
    chain: rootChain,
    issuedAt: '99',
    expiresAt: '101',
    services: [
      {
        kind: 'coordination',
        name: 'root-advertisements',
        rules,
        rulesDigest: outputPacketDigest('service-rules', rules),
        profiles: [
          {
            id: OUTPUT_PROFILES.eviction,
            authentication: 'brc103',
            payment: 'none',
            maxRequestBytes: 1048576,
            maxResponseBytes: 1048576,
            parameters: { maxTargets: 64, maxLifetimeSeconds: '86400' }
          }
        ]
      }
    ]
  }
  change?.(manifest)
  const { record, selection } = retainOutputCapability(
    signOutputPacket('capabilities', manifest, rootKey),
    trust
  )
  const request = signedRootRequest()
  const result = signOutputPacket('root-eviction-result', rootResultBody(request.body), rootKey)
  const response = (value: unknown = result, status = 200, headers: Record<string, string> = {}) =>
    new Response(typeof value === 'string' ? value : JSON.stringify(value), {
      status,
      headers: { ...selection.headers, ...headers }
    })
  const fetchClient = jest.fn<typeof fetch>()
  const options: OutputRootEvictionTransportOptions = {
    contract: record,
    trust,
    request,
    policyDigest: rootPolicy,
    wallet: new CompletedProtoWallet(requesterKey),
    fetch: fetchClient,
    ...overrides
  }
  return {
    client: new OutputRootEvictionTransport(options),
    options,
    record,
    selection,
    request,
    result,
    response,
    fetchClient
  }
}
