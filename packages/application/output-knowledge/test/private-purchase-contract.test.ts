import { expect, it } from '@jest/globals'
import { canonicalOutputJSON, outputPacketDigest, PrivateKey, signOutputPacket } from '@bsv/sdk'
import { PrivatePurchaseContracts } from '../src/private/PrivatePurchaseContracts.js'
import { purchaseContractFixture } from './private-purchase-contract.fixture.js'

it('freezes exact seller, topic, original request, domain, release and recovery terms', () => {
  const f = purchaseContractFixture(),
    selected = f.prepared(),
    original = f.original()
  expect(original.terms.body).toEqual(selected.body)
  expect(selected.body.acquisitionId).toBe(
    outputPacketDigest('purchase', {
      chain: f.chain,
      seller: f.installation.seller,
      recipient: f.request.recipient,
      topic: f.request.topic,
      requestId: f.request.requestId
    })
  )
  expect(selected.body.requestDigest).toBe(outputPacketDigest('purchase-request', f.request))
  expect(selected.body).toMatchObject({
    purchaseUntil: '100',
    recoveryUntil: '86500',
    releasePolicy: { kind: 'local-admission' }
  })
  expect(f.contracts.restore(original.capability).profile.payment).toBe('covenant')
  expect(() => f.contracts.retain(f.manifest(), '102')).toThrow()
  // Original authenticated obligations restore even when the current catalogue expires.
  expect(f.contracts.original(original)).toEqual(original)
  f.request.requestId = 'later-caller-change'
  f.terms.domainEvidence.bytes = 'AQ=='
  f.installation.topic = 'changed-topic'
  f.body.services[0].profiles[0].parameters = {
    recoverySeconds: '172800',
    releasePolicies: [],
    domainProfiles: []
  }
  expect(original.request.requestId).toBe('original-purchase')
  expect(f.contracts.configuration().topic).toBe('tm_private_purchase')
  expect(f.contracts.original(original)).toEqual(original)
})

it.each(['0', '86400', '172800'])(
  'retains the larger domain/advertised obligation %s',
  minimumRecoverySeconds => {
    const f = purchaseContractFixture(),
      selected = f.contracts.prepare(
        f.request,
        f.manifest(),
        { ...f.terms, minimumRecoverySeconds },
        '20'
      )
    expect(selected.body.recoveryUntil).toBe(
      (
        100n + (BigInt(minimumRecoverySeconds) > 86400n ? BigInt(minimumRecoverySeconds) : 86400n)
      ).toString()
    )
  }
)

it.each([
  { purchaseUntil: '20', creationCutoff: '100' },
  { purchaseUntil: '101', creationCutoff: '100' },
  { purchaseUntil: '121', creationCutoff: '121' }
])('rejects expired or unreserved construction interval %j', terms => {
  const f = purchaseContractFixture()
  expect(() =>
    f.contracts.prepare(f.request, f.manifest(), { ...f.terms, ...terms }, '20')
  ).toThrow(expect.objectContaining({ code: 'expired' }))
})

it('allows the exact cutoff and capacity boundary but refuses a longer obligation', () => {
  const f = purchaseContractFixture({ maximumPurchaseSeconds: '80' })
  expect(f.prepared().body.purchaseUntil).toBe('100')
  expect(() =>
    f.contracts.prepare(
      f.request,
      f.manifest(),
      { ...f.terms, minimumRecoverySeconds: '172801' },
      '20'
    )
  ).toThrow(expect.objectContaining({ code: 'limited' }))
})

it.each(['topic', 'chain', 'schema', 'bytes'])(
  'rejects a substituted %s before preparation can be retained',
  field => {
    const f = purchaseContractFixture()
    if (field === 'topic') f.request.topic = 'another-topic'
    if (field === 'chain') f.request.listing.chain.network = 'another-chain'
    if (field === 'schema') f.terms.domainEvidence.schema = 'urn:other:schema'
    if (field === 'bytes') f.terms.domainEvidence.bytes = 'not base64'
    expect(() => f.prepared()).toThrow()
  }
)

it.each(['rules', 'domain', 'policy', 'request', 'response', 'recovery'])(
  'refuses a capability exceeding or changing installed %s',
  field => {
    const f = purchaseContractFixture(),
      service = f.body.services[0],
      profile = service.profiles[0],
      parameters = profile.parameters as Record<string, unknown>
    if (field === 'rules') {
      service.rules.parameters = { version: 2 }
      service.rulesDigest = outputPacketDigest('service-rules', service.rules)
    }
    if (field === 'domain') parameters.domainProfiles = ['urn:unsupported:domain']
    if (field === 'policy') parameters.releasePolicies = [{ kind: 'mined', confirmations: 1 }]
    if (field === 'request') profile.maxRequestBytes++
    if (field === 'response') profile.maxResponseBytes++
    if (field === 'recovery') parameters.recoverySeconds = '172801'
    expect(() => f.prepared()).toThrow(
      expect.objectContaining({
        code: ['request', 'response', 'recovery'].includes(field) ? 'limited' : 'context-changed'
      })
    )
  }
)

it('rejects a validly signed replacement body returned by the configured signer', () => {
  const f = purchaseContractFixture(),
    selected = f.prepared(),
    replacement = signOutputPacket(
      'purchase-terms',
      { ...selected.body, purchaseUntil: '99', recoveryUntil: '86499' },
      f.key
    )
  expect(() => f.contracts.authenticate(selected, replacement)).toThrow(
    expect.objectContaining({ code: 'conflict' })
  )
})

it('rejects a signature from another seller and restores only complete original records', () => {
  const f = purchaseContractFixture(),
    selected = f.prepared()
  expect(() =>
    f.contracts.authenticate(
      selected,
      signOutputPacket('purchase-terms', selected.body, new PrivateKey(45))
    )
  ).toThrow(expect.objectContaining({ code: 'unauthorized' }))
  const original = f.original()
  expect(() => f.contracts.original({ ...original, createdAt: '100' })).toThrow(
    expect.objectContaining({ code: 'context-changed' })
  )
  expect(() => f.contracts.original({ ...original, createdAt: '0' })).not.toThrow()
  expect(() => f.contracts.original({ ...original, format: 'another-format' })).toThrow(
    expect.objectContaining({ code: 'unsupported' })
  )
  expect(() => f.contracts.original({ ...original, unknown: true })).toThrow()
  expect(() => f.contracts.authenticate({ ...selected, unknown: true }, original.terms)).toThrow()
  expect(canonicalOutputJSON(f.contracts.original(original))).toBe(canonicalOutputJSON(original))
})

it('bounds complete signed terms and request envelopes before any durable promise', () => {
  const f = purchaseContractFixture(),
    p = f.body.services[0].profiles[0]
  p.maxRequestBytes = 64
  expect(() => f.prepared()).toThrow(expect.objectContaining({ code: 'limited' }))
  p.maxRequestBytes = 65536
  p.maxResponseBytes = 64
  expect(() => f.prepared()).toThrow(expect.objectContaining({ code: 'limited' }))
})

it.each([
  { maximumPurchaseSeconds: '0' },
  { maximumRecoverySeconds: '86399' },
  { maximumRequestBytes: 0 },
  { maximumResponseBytes: 4194305 },
  { domainProfile: 'relative' },
  { domainSchema: 'relative' }
])('refuses invalid installation %j', change => {
  const f = purchaseContractFixture()
  expect(() => new PrivatePurchaseContracts({ ...f.installation, ...change }, f.trust)).toThrow()
})
