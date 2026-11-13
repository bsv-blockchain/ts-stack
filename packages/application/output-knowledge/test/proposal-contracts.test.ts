import { describe, expect, it } from '@jest/globals'
import { outputPacketDigest, signOutputPacket, type OutputJSONObject } from '@bsv/sdk'
import {
  AuthorDocumentPolicy,
  ProposalCapabilityContracts,
  ProposalPolicyRegistry,
  ProposalTransitions,
  type ProposalPolicy
} from '../src/proposals/index.js'
import { authorKey, scope, reference } from './proposal-fixture.js'
import { proposalCapabilityFixture } from './proposal-capability-fixture.js'

describe('installed proposal capability contract binding', () => {
  it('retains an exact installed selection, restores it offline and owns its trust configuration', () => {
    const { lifecycle, manifest, request } = proposalCapabilityFixture()
    const contracts = new ProposalCapabilityContracts(lifecycle, request)
    const captured = contracts.retain(manifest, '99')
    expect(contracts.restore(captured.record)).toEqual(captured.selection)
    expect(contracts.requirePolicy(captured.record, reference)).toEqual(captured.selection)
    request.baseURL = 'https://changed.example'
    ;(request.rules as Map<string, (parameters: OutputJSONObject) => void>).clear()
    expect(contracts.restore(captured.record)).toEqual(captured.selection)
    expect(() => contracts.retain(manifest, '100')).toThrow('expired')
    expect(() => contracts.requirePolicy(captured.record, { ...reference, extra: true })).toThrow()
    expect(() =>
      contracts.requirePolicy(captured.record, { ...reference, digest: '00'.repeat(32) })
    ).toThrow('not enabled')
  })

  it('rejects a validly signed advertisement with uninstalled policy parameters, identity or lifetime', () => {
    const { lifecycle, manifest, request } = proposalCapabilityFixture()
    const contracts = new ProposalCapabilityContracts(lifecycle, request)
    for (const change of ['lifetime', 'parameters', 'policy'] as const) {
      const body = structuredClone(manifest.body)
      const parameters = body.services[0].profiles[0].parameters
      const policies = parameters.policies as Array<{
        id: string
        parameters: OutputJSONObject
        digest: string
      }>
      if (change === 'lifetime') parameters.maxLifetimeSeconds = '99'
      if (change === 'parameters') policies[0].parameters = { maxTextBytes: 16 }
      if (change === 'policy') policies[0].id = 'urn:test:unknown-policy:1'
      policies[0].digest = outputPacketDigest('proposal-policy', {
        id: policies[0].id,
        parameters: policies[0].parameters
      })
      expect(() =>
        contracts.retain(signOutputPacket('capabilities', body, authorKey), '99')
      ).toThrow(change === 'lifetime' ? 'lifetime differs' : 'not installed exactly')
    }
  })

  it('supports an advertised subset but does not enable another installed policy implicitly', () => {
    const { manifest, request } = proposalCapabilityFixture()
    const base = new AuthorDocumentPolicy()
    const extra: ProposalPolicy = {
      id: 'urn:test:other-document:1',
      parameters: value => base.parameters(value),
      validate: (body, parameters) => base.validate(body, parameters),
      permits: (action, body, caller) => base.permits(action, body, caller),
      successor: (previous, next) => base.successor(previous, next),
      finalization: (body, id, tx) => base.finalization(body, id, tx)
    }
    const registry = new ProposalPolicyRegistry([
      { policy: base, parameters: { maxTextBytes: 32 } },
      { policy: extra, parameters: { maxTextBytes: 32 } }
    ])
    const lifecycle = new ProposalTransitions(registry, scope, {
      maxLifetimeSeconds: '100',
      futureSkewSeconds: '2'
    })
    const contracts = new ProposalCapabilityContracts(lifecycle, request)
    const saved = contracts.retain(manifest, '99')
    expect(contracts.requirePolicy(saved.record, reference)).toEqual(saved.selection)
    const other = registry.describe()[1]
    expect(() =>
      contracts.requirePolicy(saved.record, { id: other.id, digest: other.digest })
    ).toThrow('not enabled')
  })

  it('refuses invalid local freshness and identity configuration before serving a profile', () => {
    const { lifecycle, request } = proposalCapabilityFixture()
    for (const change of [
      { maximumAgeSeconds: '0' },
      { maximumAgeSeconds: '01' },
      { clockSkewSeconds: '-1' },
      { baseURL: 'http://localhost:8080' },
      { identity: 'invalid' }
    ])
      expect(() => new ProposalCapabilityContracts(lifecycle, { ...request, ...change })).toThrow()
  })
})
