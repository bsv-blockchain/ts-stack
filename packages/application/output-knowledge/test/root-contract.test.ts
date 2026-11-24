import { describe, expect, it } from '@jest/globals'
import { OUTPUT_PROFILES, outputPacketDigest, PrivateKey, signOutputPacket } from '@bsv/sdk'
import { RootEvictionContracts } from '../src/root-eviction/RootEvictionContracts.js'
import {
  rootContractManifest,
  rootContractPacket,
  rootContractTrust,
  rootContractRules
} from './root-contract-fixture.js'

describe('RootEvictionContracts', () => {
  it('selects the exact root coordination service and retains its original initiation time', () => {
    const { packet, selector } = rootContractPacket()
    const contracts = new RootEvictionContracts(rootContractTrust())
    const retained = contracts.retain(packet, selector, '150')
    expect(retained.selection.service.name).toBe('root-advertisements')
    expect(retained.selection.service.kind).toBe('coordination')
    expect(retained.selection.profile.id).toBe(OUTPUT_PROFILES.eviction)
    expect(retained.selection.headers).toEqual({
      'x-bsv-overlay-capability': selector,
      'x-bsv-overlay-profile': OUTPUT_PROFILES.eviction
    })
    expect(retained.record.selectedAt).toBe('150')
    expect(retained.record.freshness).toEqual({ maximumAgeSeconds: '100', clockSkewSeconds: '5' })
    expect(retained.limits).toEqual({
      maximumTargets: 64,
      maximumLifetimeSeconds: '86400',
      maximumRequestBytes: 1048576,
      maximumResponseBytes: 1048576
    })
    expect(contracts.restore(retained.record, selector)).toEqual({
      selection: retained.selection,
      limits: retained.limits
    })
  })
  it('recovers an original contract while refusing new initiation at its signed expiry', () => {
    const contracts = new RootEvictionContracts(rootContractTrust())
    const { packet, selector } = rootContractPacket()
    const original = contracts.retain(packet, selector, '199')
    expect(() => contracts.retain(packet, selector, '200')).toThrow(
      expect.objectContaining({ code: 'expired' })
    )
    const recovered = contracts.restore(original.record, selector)
    expect(recovered.selection.manifest.body.expiresAt).toBe('200')
    expect(recovered.selection.digest).toBe(selector)
    const rotated = rootContractManifest()
    rotated.issuedAt = '200'
    rotated.expiresAt = '300'
    expect(() => contracts.restore(original.record, rootContractPacket(rotated).selector)).toThrow(
      expect.objectContaining({ code: 'context-changed' })
    )
  })
  it('owns trust configuration, rule registration and retained manifest bytes', () => {
    const trust = rootContractTrust()
    const extensions: string[] = []
    trust.supportedExtensions = extensions
    const contracts = new RootEvictionContracts(trust)
    trust.chain.network = 'changed'
    trust.baseURL = 'https://different.example.test'
    trust.identity = new PrivateKey(183).toPublicKey().toString()
    trust.maximumAgeSeconds = '1'
    trust.clockSkewSeconds = '0'
    ;(trust.rules as Map<string, unknown>).clear()
    extensions.push('changed')
    const { packet, selector } = rootContractPacket()
    const retained = contracts.retain(packet, selector, '150')
    packet.body.chain.network = 'changed'
    packet.body.services[0].profiles[0].parameters.maxTargets = 1
    retained.selection.manifest.body.chain.network = 'also-changed'
    expect(contracts.restore(retained.record, selector).selection.manifest.body.chain.network).toBe(
      'mock'
    )
    expect(contracts.restore(retained.record, selector).limits.maximumTargets).toBe(64)
  })
  it.each(['0', '-1', '18446744073709551616', '01'])(
    'rejects invalid freshness %s at installation',
    maximumAgeSeconds => {
      expect(
        () => new RootEvictionContracts({ ...rootContractTrust(), maximumAgeSeconds })
      ).toThrow()
    }
  )
  it('rejects malformed skew and an HTTP origin without inferring a local exception', () => {
    expect(
      () => new RootEvictionContracts({ ...rootContractTrust(), clockSkewSeconds: '-1' })
    ).toThrow()
    expect(
      () => new RootEvictionContracts({ ...rootContractTrust(), baseURL: 'http://localhost:3000' })
    ).toThrow()
  })
  it('requires the selected digest before both intake and recovery', () => {
    const contracts = new RootEvictionContracts(rootContractTrust())
    const { packet, selector } = rootContractPacket()
    const retained = contracts.retain(packet, selector, '150')
    for (const wrong of ['ff'.repeat(32), 'not-a-digest']) {
      expect(() => contracts.retain(packet, wrong, '150')).toThrow()
      expect(() => contracts.restore(retained.record, wrong)).toThrow()
    }
  })
  it('rejects changed retained selection metadata or a forged manifest', () => {
    const contracts = new RootEvictionContracts(rootContractTrust())
    const { packet, selector } = rootContractPacket()
    const retained = contracts.retain(packet, selector, '150')
    expect(() => contracts.restore({ ...retained.record, selectedAt: '200' }, selector)).toThrow()
    expect(() =>
      contracts.restore({ ...retained.record, digest: 'ff'.repeat(32) }, selector)
    ).toThrow()
    const forged = signOutputPacket('capabilities', packet.body, new PrivateKey(184))
    expect(() => contracts.retain(forged, selector, '150')).toThrow(
      expect.objectContaining({ code: 'unauthorized' })
    )
  })
  it('does not infer installation or compatible parameters from the rule IRI', () => {
    const trust = rootContractTrust()
    const { packet, selector } = rootContractPacket()
    expect(() =>
      new RootEvictionContracts({ ...trust, rules: new Map() }).retain(packet, selector, '150')
    ).toThrow(expect.objectContaining({ code: 'unsupported' }))
    const body = rootContractManifest()
    body.services[0].rules = { ...rootContractRules, parameters: { mode: 'automatic' } }
    body.services[0].rulesDigest = outputPacketDigest('service-rules', body.services[0].rules)
    const changed = rootContractPacket(body)
    expect(() =>
      new RootEvictionContracts(trust).retain(changed.packet, changed.selector, '150')
    ).toThrow(expect.objectContaining({ code: 'unsupported' }))
  })
  it('honors narrower advertised byte, target and lifetime limits', () => {
    const body = rootContractManifest()
    Object.assign(body.services[0].profiles[0], {
      maxRequestBytes: 2048,
      maxResponseBytes: 4096,
      parameters: { maxTargets: 3, maxLifetimeSeconds: '60' }
    })
    const { packet, selector } = rootContractPacket(body)
    expect(
      new RootEvictionContracts(rootContractTrust()).retain(packet, selector, '150').limits
    ).toEqual({
      maximumTargets: 3,
      maximumLifetimeSeconds: '60',
      maximumRequestBytes: 2048,
      maximumResponseBytes: 4096
    })
  })
  it('caps larger advertised limits at the fixed BRC-199 profile bounds', () => {
    const body = rootContractManifest()
    Object.assign(body.services[0].profiles[0], {
      maxRequestBytes: 1048577,
      maxResponseBytes: 4294967295,
      parameters: { maxTargets: 4294967295, maxLifetimeSeconds: '18446744073709551615' }
    })
    const { packet, selector } = rootContractPacket(body)
    expect(
      new RootEvictionContracts(rootContractTrust()).retain(packet, selector, '150').limits
    ).toEqual({
      maximumTargets: 64,
      maximumLifetimeSeconds: '86400',
      maximumRequestBytes: 1048576,
      maximumResponseBytes: 1048576
    })
  })
  it('preserves explicitly installed critical extensions through original-contract recovery', () => {
    const extension = 'https://root.example.test/extensions/fixture-v1'
    const supportedExtensions = [extension]
    const trust = { ...rootContractTrust(), supportedExtensions }
    const contracts = new RootEvictionContracts(trust)
    supportedExtensions.length = 0
    const body = rootContractManifest()
    body.extensions = { [extension]: { fixture: true } }
    body.critical = [extension]
    const { packet, selector } = rootContractPacket(body)
    const retained = contracts.retain(packet, selector, '150')
    expect(contracts.restore(retained.record, selector).selection.manifest.body.critical).toEqual([
      extension
    ])
    expect(() =>
      new RootEvictionContracts(rootContractTrust()).restore(retained.record, selector)
    ).toThrow(expect.objectContaining({ code: 'unsupported' }))
  })
  it('returns a usable diagnostic with the stable error code on installation and selector refusal', () => {
    const contracts = new RootEvictionContracts(rootContractTrust())
    const { packet } = rootContractPacket()
    expect(
      () => new RootEvictionContracts({ ...rootContractTrust(), maximumAgeSeconds: '0' })
    ).toThrow(expect.objectContaining({ code: 'invalid', message: expect.stringMatching(/\S/) }))
    expect(() => contracts.retain(packet, 'ff'.repeat(32), '150')).toThrow(
      expect.objectContaining({ code: 'context-changed', message: expect.stringMatching(/\S/) })
    )
  })
})
