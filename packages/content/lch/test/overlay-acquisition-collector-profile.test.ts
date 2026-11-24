import { expect, it } from '@jest/globals'
import { PrivateKey, Utils } from '@bsv/sdk'
import { decodeDeterministicCbor, encodeDeterministicCbor, type LCHValue } from '../src/index.js'
import {
  bindLCHCollectorRevenueProfile,
  decodeLCHCollectorRevenueProfile,
  validateLCHCollectorPreparation
} from '../src/overlayCovenant.js'
import { decodeLCHCollectorRevenue } from '../src/overlayAcquisition.js'
import { collectorFixture } from './overlay-acquisition-collector-profile.fixture.js'

it('owns exact current CBOR terms and binds every recipient, family and expiry to the descriptor', () => {
  const f = collectorFixture(),
    encoded = encodeDeterministicCbor(f.collector as unknown as LCHValue),
    input = decodeDeterministicCbor(encoded),
    bound = bindLCHCollectorRevenueProfile(input, f.descriptor)
  expect(bound.collector.initialRevenue).toEqual(f.descriptor.initialRevenue)
  expect(bound.collector.expiryHeight).toBe(101)
  bound.descriptor.initialRevenue.recipients[0].weight = 8
  bound.collector.initialRevenue.recipients[0].weight = 9
  f.identity.fill(0)
  expect(f.descriptor.initialRevenue.recipients[0].weight).toBe(3)
  expect(() =>
    bindLCHCollectorRevenueProfile(input, { ...f.descriptor, expiryHeight: 102 })
  ).toThrow('differs')
  expect(() =>
    bindLCHCollectorRevenueProfile(input, {
      ...f.descriptor,
      initialRevenue: { recipients: [{ identity: f.seller, weight: 4 }] }
    })
  ).toThrow('differs')
})
it('rejects old terms, revisions, aliases and unsupported rule labels before interpreting a schedule', () => {
  const { collector, identity } = collectorFixture()
  for (const input of [
    { ...collector, amendment: 'unanimous-current-recipients' },
    { ...collector, familyIRI: collector.family },
    { ...collector, initialRevenue: { ...collector.initialRevenue, revision: 0 } },
    { ...collector, schedule: 'mutable' },
    { ...collector, derivation: 'root-key' },
    { ...collector, withdrawal: 'seller-only' },
    { ...collector, remainders: 'round' },
    { ...collector, retirement: 'externally-funded-exact-top-up' },
    { ...collector, family: 'https://example.invalid/family' },
    { ...collector, version: 2 },
    { ...collector, initialRevenue: { recipients: [{ identity: new Uint8Array(33), weight: 3 }] } },
    { ...collector, initialRevenue: { recipients: [{ identity, weight: 3, extra: true }] } }
  ])
    expect(() => decodeLCHCollectorRevenueProfile(input)).toThrow()
  expect(() => decodeLCHCollectorRevenue(collector)).toThrow('unknown fields')
})
it('requires positive exact CBOR bounds, valid identities and the complete sorted quantum schedule', () => {
  const { collector, identity } = collectorFixture()
  expect(
    decodeLCHCollectorRevenueProfile({ ...collector, expiryHeight: 499999999n }).expiryHeight
  ).toBe(499999999)
  for (const expiryHeight of [0, -1, 500000000, 1.1, '101', null])
    expect(() => decodeLCHCollectorRevenueProfile({ ...collector, expiryHeight })).toThrow()
  for (const weight of [0, -1, 10001, 1.1, '3'])
    expect(() =>
      decodeLCHCollectorRevenueProfile({
        ...collector,
        initialRevenue: { recipients: [{ identity, weight }] }
      })
    ).toThrow()
  for (const recipients of [
    [],
    Array(9).fill({ identity, weight: 1 }),
    [
      { identity, weight: 3 },
      { identity, weight: 3 }
    ],
    [{ identity: '00'.repeat(33), weight: 3 }]
  ])
    expect(() =>
      decodeLCHCollectorRevenueProfile({ ...collector, initialRevenue: { recipients } })
    ).toThrow()
  expect(() => decodeLCHCollectorRevenueProfile(null)).toThrow()
})
it('checks active-stage new preparations strictly below expiry without revoking retained obligations', () => {
  const { descriptor } = collectorFixture()
  expect(() => validateLCHCollectorPreparation(descriptor, 'active', '100')).not.toThrow()
  for (const [stage, height] of [
    ['active', '101'],
    ['active', '102'],
    ['activation', '100'],
    ['unknown', '0']
  ])
    expect(() => validateLCHCollectorPreparation(descriptor, stage, height)).toThrow(
      'New preparation'
    )
  for (const height of [-1, '1.1', undefined])
    expect(() => validateLCHCollectorPreparation(descriptor, 'active', height)).toThrow()
  // Recovery owners deliberately use frozen accepted terms, not this new-work predicate.
  expect(descriptor.expiryHeight).toBe(101)
})

it('binds all eight valid sorted recipient slots and refuses a changed last share or excessive quantum', () => {
  const f = collectorFixture(),
    recipients = Array.from({ length: 8 }, (_, i) => ({
      identity: new PrivateKey(100 + i).toPublicKey().toString(),
      weight: i + 1
    })).sort((a, b) => (a.identity < b.identity ? -1 : 1)),
    descriptor = { ...f.descriptor, initialRevenue: { recipients } },
    collector = {
      ...f.collector,
      initialRevenue: {
        recipients: recipients.map(r => ({
          ...r,
          identity: new Uint8Array(Utils.toArray(r.identity, 'hex'))
        }))
      }
    }
  expect(
    bindLCHCollectorRevenueProfile(collector, descriptor).collector.initialRevenue.recipients
  ).toEqual(recipients)
  const changed = recipients.map(r => ({ ...r }))
  changed[7].weight++
  expect(() =>
    bindLCHCollectorRevenueProfile(collector, {
      ...descriptor,
      initialRevenue: { recipients: changed }
    })
  ).toThrow('differs')
  expect(() =>
    decodeLCHCollectorRevenueProfile({
      ...collector,
      initialRevenue: {
        recipients: collector.initialRevenue.recipients.map(r => ({ ...r, weight: 1251 }))
      }
    })
  ).toThrow('quantum')
})
