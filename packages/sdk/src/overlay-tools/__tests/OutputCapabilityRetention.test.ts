import {
  canonicalOutputJSON,
  OUTPUT_PROFILES,
  outputPacketDigest,
  PrivateKey,
  retainOutputCapability,
  restoreOutputCapability,
  selectOutputCapability,
  signOutputPacket,
  type OutputCapabilities,
  type OutputCapabilityRequest,
  type OutputCapabilityRecoveryRequest
} from '../../../mod.js'

const key = new PrivateKey(71)
const identity = key.toPublicKey().toString()
const chain = { network: 'test', genesisHash: '01'.repeat(32) }
const rules = { id: 'urn:test:document-service:1', parameters: { visibility: 'recipients' } }
const policy = {
  id: 'https://bsv.brc.dev/overlays/0194#author-document-v1',
  parameters: { maxTextBytes: 32 }
}
function manifest() {
  return signOutputPacket<OutputCapabilities>(
    'capabilities',
    {
      version: 1,
      identity,
      chain,
      baseURL: 'https://provider.example/api',
      issuedAt: '100',
      expiresAt: '200',
      services: [
        {
          name: 'tm_documents',
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
                policies: [{ ...policy, digest: outputPacketDigest('proposal-policy', policy) }],
                maxLifetimeSeconds: '100',
                retentionSeconds: '1000'
              }
            }
          ]
        }
      ]
    },
    key
  )
}
function request(): OutputCapabilityRequest {
  return {
    baseURL: 'https://provider.example/api',
    identity,
    authenticatedPeer: identity,
    chain,
    kind: 'topic',
    service: 'tm_documents',
    profile: OUTPUT_PROFILES.proposal,
    now: '110',
    maximumAgeSeconds: '20',
    clockSkewSeconds: '1',
    rules: new Map([
      [
        rules.id,
        parameters => {
          if (canonicalOutputJSON(parameters) !== canonicalOutputJSON(rules.parameters))
            throw new Error('Uninstalled service rules')
        }
      ]
    ])
  }
}

describe('local retained capability contracts', () => {
  it('revalidates a saved contract at its original selection time after manifest expiry', () => {
    const input = manifest()
    const { record, selection } = retainOutputCapability(input, request())
    const saved = canonicalOutputJSON(record)
    expect(record.format).toBe('output-capability-retention/1')
    expect(record.selectedAt).toBe('110')
    expect(record.freshness).toEqual({ maximumAgeSeconds: '20', clockSkewSeconds: '1' })
    expect(() => selectOutputCapability(input, { ...request(), now: '500' })).toThrow('expired')
    // Extra fields on a caller-owned object cannot replace recorded freshness.
    const recovery = { ...request(), now: '500', maximumAgeSeconds: '1' }
    expect(restoreOutputCapability(saved, recovery)).toEqual(selection)
    input.body.expiresAt = '111'
    selection.manifest.body.expiresAt = '112'
    expect(canonicalOutputJSON(record)).toBe(saved)
    const recovered = restoreOutputCapability(saved, request())
    recovered.service.name = 'changed'
    expect(restoreOutputCapability(saved, request()).service.name).toBe('tm_documents')
  })

  it('requires the original endpoint, provider identity, chain, installed rules and explicit selector', () => {
    const { record } = retainOutputCapability(manifest(), request())
    const changes: Partial<OutputCapabilityRecoveryRequest>[] = [
      { baseURL: 'https://redirect.example/api' },
      { identity: new PrivateKey(72).toPublicKey().toString() },
      { authenticatedPeer: new PrivateKey(73).toPublicKey().toString() },
      { chain: { ...chain, genesisHash: 'ff'.repeat(32) } },
      { rules: new Map() },
      {
        rules: new Map([
          [
            rules.id,
            () => {
              throw new Error('Removed validator')
            }
          ]
        ])
      },
      { kind: 'lookup' },
      { service: 'other' },
      { profile: OUTPUT_PROFILES.purchase }
    ]
    for (const change of changes)
      expect(() => restoreOutputCapability(record, { ...request(), ...change })).toThrow()
  })

  it('rejects changed signed material, mismatched digest and invalid historical selection time', () => {
    const { record } = retainOutputCapability(manifest(), request())
    const altered = JSON.parse(canonicalOutputJSON(record))
    altered.manifest.body.expiresAt = '300'
    const replacement = manifest()
    replacement.body.expiresAt = '300'
    for (const invalid of [
      altered,
      { ...record, digest: 'ff'.repeat(32) },
      { ...record, manifest: signOutputPacket('capabilities', replacement.body, key) },
      { ...record, selectedAt: '200' },
      { ...record, selectedAt: '98' },
      { ...record, selectedAt: '121' },
      { ...record, freshness: { ...record.freshness, maximumAgeSeconds: '0' } }
    ])
      expect(() => restoreOutputCapability(invalid, request())).toThrow()
    expect(() => retainOutputCapability(manifest(), { ...request(), now: '200' })).toThrow(
      'expired'
    )
  })

  it('bounds and closes the local record and never accepts an unknown replay format', () => {
    const { record } = retainOutputCapability(manifest(), request())
    const { digest: _digest, ...incomplete } = record
    for (const invalid of [
      null,
      incomplete,
      { ...record, format: 'output-capability-retention/2' },
      { ...record, extra: true },
      { ...record, freshness: { ...record.freshness, extra: true } },
      { ...record, selectedAt: '0110' },
      { ...record, padding: 'x'.repeat(524288) }
    ])
      expect(() => restoreOutputCapability(invalid, request())).toThrow()
  })

  it('preserves an explicitly permitted local HTTP lookup contract without weakening private profiles', () => {
    const body = manifest().body
    body.baseURL = 'http://localhost:8080'
    body.services[0].kind = 'lookup'
    body.services[0].profiles = [
      {
        id: OUTPUT_PROFILES.lookup,
        authentication: 'none',
        payment: 'none',
        maxRequestBytes: 1048576,
        maxResponseBytes: 65536,
        parameters: {
          replaySeconds: '100',
          sessionSeconds: '100',
          maxObservations: 10,
          maxWaitMs: 500
        }
      }
    ]
    const local = {
      ...request(),
      kind: 'lookup' as const,
      profile: OUTPUT_PROFILES.lookup,
      baseURL: body.baseURL,
      allowLocalHTTP: true
    }
    const packet = signOutputPacket('capabilities', body, key)
    const { record, selection } = retainOutputCapability(packet, local)
    expect(restoreOutputCapability(record, local)).toEqual(selection)
    expect(() => restoreOutputCapability(record, { ...local, allowLocalHTTP: false })).toThrow()
    const privateBody = manifest().body
    privateBody.baseURL = body.baseURL
    expect(() =>
      retainOutputCapability(signOutputPacket('capabilities', privateBody, key), {
        ...request(),
        baseURL: body.baseURL,
        allowLocalHTTP: true
      })
    ).toThrow('HTTPS')
  })
})
