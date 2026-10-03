import { expect, it } from '@jest/globals'
import { canonicalOutputJSON, type OutputSignedRootEvictionRequest } from '@bsv/sdk'
import {
  rootConfiguration,
  rootDecimal,
  rootTarget,
  reserveRootResult
} from '../src/root-eviction/RootEvictionCodec.js'
import { chain, root, policy, request, selected } from './root-eviction-fixture.js'

const error = (code = 'invalid') => ({ code, message: expect.stringMatching(/\S/) })
it('rejects noncanonical retained revisions rather than silently normalizing damaged counters', () => {
  for (const value of [
    null,
    0,
    '',
    '0'.repeat(15),
    '0'.repeat(17),
    'x' + '0'.repeat(16),
    '0'.repeat(16) + 'x',
    'A'.repeat(16),
    'g'.repeat(16)
  ]) {
    expect(() => rootDecimal(value)).toThrow(expect.objectContaining(error('unavailable')))
  }
  expect(rootDecimal('0123456789abcdef')).toBe('81985529216486895')
})
it('seals the storage format and complete owned configuration and refuses unrecognized or fractional capacity', () => {
  const input = { root, chain: structuredClone(chain) }
  const configured = rootConfiguration(input)
  expect(JSON.parse(configured.seal)).toEqual({
    format: 'root-eviction/1',
    root,
    chain,
    capacity: {
      requests: 4096,
      requestBytes: 67108864,
      targets: 65536,
      blockers: 64,
      assessments: 4096
    }
  })
  input.chain.network = 'changed'
  expect(configured.chain).toEqual(chain)
  expect(Object.isFrozen(configured.capacity)).toBe(true)
  for (const capacity of [
    { requests: 0 },
    { targets: -1 },
    { assessments: 0.5 },
    { blockers: 65 },
    { requestBytes: 67108865 },
    { unknown: 1 }
  ]) {
    expect(() => rootConfiguration({ root, chain, capacity })).toThrow(
      expect.objectContaining(error())
    )
  }
  for (const input of [
    { root, chain, extra: true },
    { root, chain: { ...chain, extra: true } }
  ]) {
    expect(() => rootConfiguration(input)).toThrow(expect.objectContaining(error()))
  }
})
it('accepts both root services and closed selectors while owning every returned field', () => {
  for (const service of ['ls_ship', 'ls_slap'] as const) {
    const target = { ...selected(), service }
    const parsed = rootTarget(target)
    expect(parsed).toEqual(target)
    expect(parsed).not.toBe(target)
    expect(parsed.outpoint).not.toBe(target.outpoint)
    expect(parsed.outpoint.chain).not.toBe(target.outpoint.chain)
  }
  const target = selected()
  for (const value of [
    { ...target, service: 'other' },
    { ...target, extra: 1 },
    { ...target, outpoint: { ...target.outpoint, extra: 1 } },
    { ...target, outpoint: { ...target.outpoint, chain: { ...chain, extra: 1 } } }
  ]) {
    expect(() => rootTarget(value as typeof target)).toThrow(expect.objectContaining(error()))
  }
})

// Construct a maximal permitted result independently of the reservation helper.
// One target's U32 digit width lets the fixture sit exactly on the byte limit.
function maximumResult(packet: OutputSignedRootEvictionRequest) {
  return {
    body: {
      version: 1,
      root,
      requestDigest: 'f'.repeat(64),
      policyDigest: policy,
      issuedAt: '18446744073709551615',
      outcomes: packet.body.targets.map(target => ({
        service: target.service,
        outpoint: target.outpoint,
        actionStatus: 'applied',
        reasonCode: '\0'.repeat(1024),
        decisionId: 'f'.repeat(64),
        affectedDecisionIds: ['f'.repeat(64)],
        revision: '18446744073709551615',
        serving: {
          state: 'suppressed',
          revision: '18446744073709551615',
          blockers: Array.from({ length: 64 }, (_, i) => ({
            decisionId: i.toString(16).padStart(64, '0'),
            policyDigest: policy
          }))
        }
      }))
    },
    signature: Buffer.alloc(174).toString('base64')
  }
}
it('reserves every field of a maximum-size auditable result at the exact 1 MiB boundary', () => {
  const limit = 1048576
  let packet: OutputSignedRootEvictionRequest | undefined
  // All target chains agree. Vary a shared bounded network name, then U32 widths.
  for (let count = 1; count <= 64; count++) {
    const body = request()
    body.targets = Array.from({ length: count }, (_, index) => {
      const target = structuredClone(body.targets[0])
      target.outpoint.txid = index.toString(16).padStart(64, '0')
      target.advertisement.txid = target.outpoint.txid
      return target
    })
    const candidate = { body, signature: 'AA==' }
    const bytes = Buffer.byteLength(JSON.stringify(maximumResult(candidate)))
    const deficit = limit - bytes
    if (deficit < 0 || deficit > count * 1000) continue
    const extension = Math.floor(deficit / count)
    body.chain = { ...chain, network: chain.network + 'n'.repeat(extension) }
    for (const target of body.targets) target.outpoint.chain = body.chain
    let remaining = deficit - extension * count
    for (const target of body.targets) {
      const digits = Math.min(remaining, 8)
      target.outpoint.outputIndex = 10 ** digits
      target.advertisement.outputIndex = target.outpoint.outputIndex
      remaining -= digits
    }
    expect(remaining).toBe(0)
    packet = candidate
    break
  }
  expect(packet).toBeDefined()
  const bound = packet!
  expect(Buffer.byteLength(canonicalOutputJSON(maximumResult(bound), { bytes: limit }))).toBe(limit)
  expect(() => reserveRootResult(bound, policy, 64)).not.toThrow()
  // Increase a one-digit output index to two digits without changing its identity shape.
  const index = bound.body.targets.find(target => target.outpoint.outputIndex === 1)!
  expect(index).toBeDefined()
  index.outpoint.outputIndex = 10
  index.advertisement.outputIndex = 10
  expect(Buffer.byteLength(JSON.stringify(maximumResult(bound)))).toBe(limit + 1)
  expect(() => reserveRootResult(bound, policy, 64)).toThrow(
    expect.objectContaining(error('limited'))
  )
})
