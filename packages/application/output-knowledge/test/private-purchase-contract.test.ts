import { expect, it } from '@jest/globals'
import {
  canonicalOutputJSON,
  outputPacketDigest,
  PrivateKey,
  signOutputPacket,
  type OutputPurchasePrepare,
  type OutputPurchaseTerms
} from '@bsv/sdk'
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
    if (field === 'chain') {
      f.request.listing.chain = { ...f.chain, network: 'another-chain' }
    }
    if (field === 'schema') f.terms.domainEvidence.schema = 'urn:other:schema'
    if (field === 'bytes') f.terms.domainEvidence.bytes = 'not base64'
    expect(() => f.prepared()).toThrow(
      expect.objectContaining({ code: field === 'bytes' ? 'invalid' : 'context-changed' })
    )
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

it.each(['maximumRequestBytes', 'maximumResponseBytes'] as const)(
  'accepts the exact maximum %s and rejects noninteger, nonnumeric and out-of-range allowances',
  field => {
    const f = purchaseContractFixture()
    expect(
      new PrivatePurchaseContracts(
        { ...f.installation, [field]: 4194304 },
        f.trust
      ).configuration()[field]
    ).toBe(4194304)
    expect(
      () => new PrivatePurchaseContracts({ ...f.installation, [field]: 0.5 }, f.trust)
    ).toThrow('Protocol numbers must be safe integers')
    for (const value of ['1', -1, 0, 4194305]) {
      expect(
        () => new PrivatePurchaseContracts({ ...f.installation, [field]: value }, f.trust)
      ).toThrow('Invalid installed purchase envelope allowance')
    }
  }
)

it.each(['domainProfile', 'domainSchema'] as const)(
  'requires %s to begin with its IRI scheme',
  field => {
    const f = purchaseContractFixture()
    expect(
      () => new PrivatePurchaseContracts({ ...f.installation, [field]: '1urn:test:value' }, f.trust)
    ).toThrow('Purchase installation requires an absolute IRI')
  }
)

it('accepts the minimum retention and rejects a zero freshness promise before discovery', () => {
  const f = purchaseContractFixture({ maximumRecoverySeconds: '86400' })
  expect(f.prepared().body.recoveryUntil).toBe('86500')
  expect(
    () => new PrivatePurchaseContracts(f.installation, { ...f.trust, maximumAgeSeconds: '0' })
  ).toThrow('Invalid installed purchase retention or freshness interval')
})

it('owns supported critical extensions and accepts an installed policy among several advertised policies', () => {
  const f = purchaseContractFixture(),
    extension = 'urn:test:purchase-critical',
    supportedExtensions = [extension],
    contracts = new PrivatePurchaseContracts(f.installation, {
      ...f.trust,
      supportedExtensions
    })
  f.body.extensions = { [extension]: { version: 1 } }
  f.body.critical = [extension]
  const parameters = f.body.services[0].profiles[0].parameters
  parameters.releasePolicies = [{ kind: 'mined', confirmations: 1 }, { kind: 'local-admission' }]
  supportedExtensions.length = 0
  const prepared = contracts.prepare(f.request, f.manifest(), f.terms, '20')
  expect(contracts.restore(prepared.capability).profile.parameters.releasePolicies).toEqual(
    parameters.releasePolicies
  )
  expect(() => f.prepared()).toThrow()
})

it('accepts the advertised recovery capacity exactly and diagnoses an excess', () => {
  const f = purchaseContractFixture()
  f.body.services[0].profiles[0].parameters.recoverySeconds = '172800'
  expect(f.prepared().body.recoveryUntil).toBe('172900')
  f.body.services[0].profiles[0].parameters.recoverySeconds = '172801'
  expect(() => f.prepared()).toThrow('Purchase profile exceeds installed capacity')
})

it('checks the entire installation representation before parsing individual fields', () => {
  const f = purchaseContractFixture(),
    oversized = { ...f.installation, topic: 't'.repeat(16384) }
  expect(() => new PrivatePurchaseContracts(oversized, f.trust)).toThrow(
    expect.objectContaining({ code: 'limited' })
  )
})

it('preserves U64 recovery arithmetic at the last representable deadline and rejects overflow', () => {
  const f = purchaseContractFixture({ maximumRecoverySeconds: '18446744073709551615' }),
    exact = { ...f.terms, minimumRecoverySeconds: '18446744073709551515' },
    prepared = f.contracts.prepare(f.request, f.manifest(), exact, '20')
  expect(prepared.body.recoveryUntil).toBe('18446744073709551615')
  expect(() =>
    f.contracts.prepare(
      f.request,
      f.manifest(),
      { ...exact, minimumRecoverySeconds: '18446744073709551516' },
      '20'
    )
  ).toThrow(
    expect.objectContaining({ code: 'limited', message: 'Purchase recovery deadline exhausted' })
  )
})

/** Sign a complete alternative, so restoration must check local installation semantics too. */
function resignOriginal(
  change: (request: OutputPurchasePrepare, body: OutputPurchaseTerms) => void,
  advertisedRecovery = '86400'
) {
  const f = purchaseContractFixture()
  f.body.services[0].profiles[0].parameters.recoverySeconds = advertisedRecovery
  const original = f.original(),
    request = structuredClone(original.request),
    body = structuredClone(original.terms.body)
  change(request, body)
  Object.assign(body, {
    topic: request.topic,
    listing: request.listing,
    acquisitionId: outputPacketDigest('purchase', {
      chain: request.listing.chain,
      seller: f.installation.seller,
      recipient: request.recipient,
      topic: request.topic,
      requestId: request.requestId
    }),
    requestDigest: outputPacketDigest('purchase-request', request)
  })
  return {
    f,
    original: { ...original, request, terms: signOutputPacket('purchase-terms', body, f.key) }
  }
}

it.each(['topic', 'chain', 'domain', 'schema', 'release'])(
  'refuses a valid seller-signed original with a different installed %s',
  field => {
    const { f, original } = resignOriginal((request, body) => {
      if (field === 'topic') request.topic = 'tm_another_topic'
      if (field === 'chain') request.listing.chain.network = 'another-chain'
      if (field === 'domain') body.domainProfile = 'urn:test:another-domain'
      if (field === 'schema') body.domainEvidence.schema = 'urn:test:another-schema'
      if (field === 'release') body.releasePolicy = { kind: 'mined', confirmations: 1 }
    })
    expect(() => f.contracts.original(original)).toThrow(
      expect.objectContaining({
        code: 'context-changed',
        message: 'Original purchase installation differs'
      })
    )
  }
)

it.each(['construction', 'short-recovery', 'long-recovery'])(
  'refuses a complete seller-signed original exceeding the reserved %s interval',
  field => {
    const { f, original } = resignOriginal(
      (_request, body) => {
        if (field === 'construction') {
          body.purchaseUntil = '121'
          body.recoveryUntil = '86521'
        }
        if (field === 'short-recovery') body.recoveryUntil = '86500'
        if (field === 'long-recovery') body.recoveryUntil = '172901'
      },
      field === 'short-recovery' ? '172800' : '86400'
    )
    expect(() => f.contracts.original(original)).toThrow(
      expect.objectContaining({
        code: 'context-changed',
        message: 'Original purchase deadlines exceed its reservation'
      })
    )
  }
)

it('reserves signature framing and rechecks request and signed-original capacity on restoration', () => {
  const f = purchaseContractFixture(),
    original = f.original(),
    prepared = f.prepared(),
    requestBytes = new TextEncoder().encode(canonicalOutputJSON(prepared.request)).length,
    reservedBytes = new TextEncoder().encode(
      canonicalOutputJSON({ body: prepared.body, signature: 'A'.repeat(232) })
    ).length,
    signedBytes = new TextEncoder().encode(canonicalOutputJSON(original.terms)).length,
    profile = f.body.services[0].profiles[0]
  profile.maxRequestBytes = requestBytes
  profile.maxResponseBytes = reservedBytes
  expect(f.prepared().body).toEqual(prepared.body)
  profile.maxResponseBytes = reservedBytes - 1
  expect(() => f.prepared()).toThrow(expect.objectContaining({ code: 'limited' }))
  for (const field of ['request', 'response']) {
    profile.maxRequestBytes = field === 'request' ? requestBytes - 1 : requestBytes
    profile.maxResponseBytes = field === 'response' ? signedBytes - 1 : reservedBytes
    const retained = f.contracts.retain(f.manifest(), '20')
    expect(() => f.contracts.original({ ...original, capability: retained.record })).toThrow(
      expect.objectContaining({ code: 'limited' })
    )
  }
})
