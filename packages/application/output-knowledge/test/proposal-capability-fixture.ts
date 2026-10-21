import {
  canonicalOutputJSON,
  OUTPUT_PROFILES,
  outputPacketDigest,
  signOutputPacket,
  type OutputCapabilities,
  type OutputCapabilityRequest
} from '@bsv/sdk'
import { ProposalTransitions } from '../src/proposals/index.js'
import { author, authorKey, scope, createRegistry } from './proposal-fixture.js'

export function proposalCapabilityFixture() {
  const registry = createRegistry()
  const lifecycle = new ProposalTransitions(registry, scope, {
    maxLifetimeSeconds: '100',
    futureSkewSeconds: '2'
  })
  const rules = { id: 'urn:test:proposal-service:1', parameters: {} }
  const manifest = signOutputPacket<OutputCapabilities>(
    'capabilities',
    {
      version: 1,
      identity: author,
      baseURL: 'https://provider.example/api',
      chain: scope.chain,
      issuedAt: '10',
      expiresAt: '100',
      services: [
        {
          name: scope.service,
          kind: 'topic',
          rules,
          rulesDigest: outputPacketDigest('service-rules', rules),
          profiles: [
            {
              id: OUTPUT_PROFILES.proposal,
              authentication: 'brc103',
              payment: 'none',
              maxRequestBytes: 1048576,
              maxResponseBytes: 4194304,
              parameters: {
                policies: registry
                  .describe()
                  .map(({ id, digest, parameters }) => ({ id, digest, parameters })),
                maxLifetimeSeconds: '100',
                retentionSeconds: '1000'
              }
            }
          ]
        }
      ]
    },
    authorKey
  )
  const request: OutputCapabilityRequest = {
    baseURL: manifest.body.baseURL,
    identity: author,
    authenticatedPeer: author,
    chain: scope.chain,
    kind: 'topic',
    service: scope.service,
    profile: OUTPUT_PROFILES.proposal,
    now: '99',
    maximumAgeSeconds: '100',
    clockSkewSeconds: '2',
    rules: new Map([
      [
        rules.id,
        parameters => {
          if (canonicalOutputJSON(parameters) !== '{}')
            throw new Error('Unsupported rules parameters')
        }
      ]
    ])
  }
  return { lifecycle, manifest, request }
}
