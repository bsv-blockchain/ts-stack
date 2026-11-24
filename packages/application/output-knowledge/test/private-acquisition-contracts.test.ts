import { beforeAll, describe, expect, it } from '@jest/globals'
import {
  OUTPUT_PROFILES,
  PrivateKey,
  outputPacketDigest,
  signOutputPacket,
  type OutputCapabilities
} from '@bsv/sdk'
import {
  PrivateAcquisitionContracts,
  type PrivateAcquisitionInstallation
} from '../src/private/PrivateAcquisitionContracts.js'
import { acquisitionFixture } from './private-acquisition.fixture.js'

describe('original paid lookup capability and quote contract', () => {
  let f: Awaited<ReturnType<typeof acquisitionFixture>>
  beforeAll(async () => {
    f = await acquisitionFixture()
  })
  function setup(overrides: Partial<PrivateAcquisitionInstallation> = {}) {
    const key = new PrivateKey(83),
      rules = { id: 'urn:test:paid-lookup-rules', parameters: { version: 1 } }
    const installation: PrivateAcquisitionInstallation = {
      chain: f.chain,
      seller: f.seller,
      baseURL: 'https://seller.example/api',
      service: f.request.service,
      rulesDigest: outputPacketDigest('service-rules', rules),
      acceptancePolicy: { kind: 'local-admission' },
      maximumRequestBytes: 65536,
      maximumResponseBytes: 1048576,
      maximumQuoteSeconds: '100',
      maximumRecoverySeconds: '172800',
      ...overrides
    }
    const trust = {
      maximumAgeSeconds: '100',
      clockSkewSeconds: '1',
      rules: new Map([[rules.id, () => {}]])
    }
    const contracts = new PrivateAcquisitionContracts(installation, trust)
    const body: OutputCapabilities = {
      version: 1,
      identity: f.seller,
      baseURL: installation.baseURL,
      chain: f.chain,
      issuedAt: '10',
      expiresAt: '100',
      services: [
        {
          name: f.request.service,
          kind: 'lookup',
          rules,
          rulesDigest: installation.rulesDigest,
          profiles: [
            {
              id: OUTPUT_PROFILES.acquisition,
              authentication: 'brc103',
              payment: 'brc105',
              maxRequestBytes: 65536,
              maxResponseBytes: 1048576,
              parameters: {
                recoverySeconds: '86400',
                acceptancePolicy: { kind: 'local-admission' }
              }
            }
          ]
        }
      ]
    }
    const terms = {
      satoshis: '100',
      derivationPrefix: f.challenge.derivationPrefix,
      payableUntil: '100',
      creationCutoff: '100',
      minimumRecoverySeconds: '0'
    }
    const manifest = () => signOutputPacket('capabilities', body, key)
    return { key, installation, trust, contracts, body, terms, manifest }
  }
  it('freezes selected request, exact amount, prefix, policy and recovery terms', () => {
    const s = setup(),
      quoted = s.contracts.prepare(f.request, s.manifest(), s.terms, '20')
    expect(quoted.challenge).toMatchObject({
      acquisitionId: f.challenge.acquisitionId,
      requestDigest: f.challenge.requestDigest,
      seller: f.seller,
      buyer: f.buyer,
      satoshis: '100',
      derivationPrefix: s.terms.derivationPrefix,
      payableUntil: '100',
      recoveryUntil: '86500',
      acceptancePolicy: { kind: 'local-admission' }
    })
    expect(s.contracts.restore(quoted.capability)).toEqual(quoted.selection)
    expect(() => s.contracts.retain(s.manifest(), '102')).toThrow()
    expect(s.contracts.restore(quoted.capability)).toEqual(quoted.selection)
  })
  it.each(['0', '86400', '172800'])(
    'preserves the greater advertised/domain obligation %s',
    minimumRecoverySeconds => {
      const s = setup(),
        q = s.contracts.prepare(
          f.request,
          s.manifest(),
          { ...s.terms, minimumRecoverySeconds },
          '20'
        )
      expect(q.challenge.recoveryUntil).toBe(
        (
          100n + (BigInt(minimumRecoverySeconds) > 86400n ? BigInt(minimumRecoverySeconds) : 86400n)
        ).toString()
      )
    }
  )
  it('rejects a domain recovery promise exceeding installed capacity', () => {
    const s = setup()
    expect(() =>
      s.contracts.prepare(
        f.request,
        s.manifest(),
        { ...s.terms, minimumRecoverySeconds: '172801' },
        '20'
      )
    ).toThrow(expect.objectContaining({ code: 'limited' }))
  })
  it.each([
    { payableUntil: '20', creationCutoff: '100' },
    { payableUntil: '101', creationCutoff: '100' },
    { payableUntil: '121', creationCutoff: '121' }
  ])('rejects expired/domain-ineligible/unreserved construction interval %j', change => {
    const s = setup()
    expect(() =>
      s.contracts.prepare(f.request, s.manifest(), { ...s.terms, ...change }, '20')
    ).toThrow(expect.objectContaining({ code: 'expired' }))
  })
  it('accepts exact quote duration and creation cutoff ceilings', () => {
    const s = setup({ maximumQuoteSeconds: '80' })
    expect(s.contracts.prepare(f.request, s.manifest(), s.terms, '20').challenge.payableUntil).toBe(
      '100'
    )
    expect(s.contracts.prepare(f.request, s.manifest(), s.terms, '99').challenge.payableUntil).toBe(
      '100'
    )
  })
  it.each(['policy', 'rules', 'request', 'response', 'recovery'] as const)(
    'checks every signed profile against installed %s',
    changed => {
      const s = setup(),
        p = s.body.services[0].profiles[0]
      if (changed === 'policy') p.parameters.acceptancePolicy = { kind: 'mined', confirmations: 1 }
      if (changed === 'rules') {
        s.body.services[0].rules.parameters.version = 2
        s.body.services[0].rulesDigest = outputPacketDigest(
          'service-rules',
          s.body.services[0].rules
        )
      }
      if (changed === 'request') p.maxRequestBytes++
      if (changed === 'response') p.maxResponseBytes++
      if (changed === 'recovery') p.parameters.recoverySeconds = '172801'
      expect(() => s.contracts.retain(s.manifest(), '20')).toThrow(
        expect.objectContaining({
          code: ['policy', 'rules'].includes(changed) ? 'context-changed' : 'limited'
        })
      )
    }
  )
  it('owns installation and trust collections, and refuses modified retained signatures', () => {
    const s = setup(),
      q = s.contracts.prepare(f.request, s.manifest(), s.terms, '20')
    s.installation.service = 'changed'
    s.trust.rules.clear()
    const exposed = s.contracts.configuration()
    exposed.chain.network = 'changed'
    expect(s.contracts.restore(q.capability)).toEqual(q.selection)
    q.capability.manifest.body.expiresAt = '200'
    expect(() => s.contracts.restore(q.capability)).toThrow()
  })
  it('rejects another service or chain and bounds the complete request', () => {
    const s = setup()
    expect(() =>
      s.contracts.prepare({ ...f.request, service: 'another' }, s.manifest(), s.terms, '20')
    ).toThrow(expect.objectContaining({ code: 'context-changed' }))
    expect(() =>
      s.contracts.prepare(
        {
          ...f.request,
          listing: { ...f.request.listing, chain: { ...f.chain, network: 'another' } }
        },
        s.manifest(),
        s.terms,
        '20'
      )
    ).toThrow(expect.objectContaining({ code: 'context-changed' }))
    expect(() =>
      s.contracts.prepare(
        { ...f.request, request: Buffer.alloc(65536).toString('base64') },
        s.manifest(),
        s.terms,
        '20'
      )
    ).toThrow(expect.objectContaining({ code: 'limited' }))
  })
  it('requires positive exact money and a valid bounded BRC-29 prefix', () => {
    const s = setup()
    for (const satoshis of ['0', '2100000000000001'])
      expect(() =>
        s.contracts.prepare(f.request, s.manifest(), { ...s.terms, satoshis }, '20')
      ).toThrow()
    for (const derivationPrefix of ['', 'é', 'x'.repeat(129)])
      expect(() =>
        s.contracts.prepare(f.request, s.manifest(), { ...s.terms, derivationPrefix }, '20')
      ).toThrow()
  })
  it.each([0, 4194305, 1.5])(
    'requires bounded positive envelope capacities %s',
    maximumRequestBytes => {
      expect(() => setup({ maximumRequestBytes })).toThrow()
      expect(() => setup({ maximumResponseBytes: maximumRequestBytes })).toThrow()
    }
  )
  it('requires positive quote/freshness periods and at least a day of recovery capacity', () => {
    expect(() => setup({ maximumQuoteSeconds: '0' })).toThrow()
    expect(() => setup({ maximumRecoverySeconds: '86399' })).toThrow()
    const s = setup()
    expect(
      () => new PrivateAcquisitionContracts(s.installation, { ...s.trust, maximumAgeSeconds: '0' })
    ).toThrow()
  })
  it('checks recovery arithmetic at the uint64 ceiling before any quote is issued', () => {
    const s = setup(),
      max = 18446744073709551615n
    s.body.issuedAt = (max - 2n).toString()
    s.body.expiresAt = max.toString()
    expect(() =>
      s.contracts.prepare(
        f.request,
        s.manifest(),
        { ...s.terms, payableUntil: max.toString(), creationCutoff: max.toString() },
        (max - 1n).toString()
      )
    ).toThrow(expect.objectContaining({ code: 'limited' }))
  })
})
