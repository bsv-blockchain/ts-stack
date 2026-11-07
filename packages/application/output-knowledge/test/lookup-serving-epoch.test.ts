import { describe, expect, it } from '@jest/globals'
import {
  PrivateKey,
  selectOutputCapability,
  signOutputPacket,
  type OutputCapabilities
} from '@bsv/sdk'
import {
  LOOKUP_STORAGE_EPOCH_EXTENSION,
  lookupServingEpoch,
  lookupServingEpochExtension
} from '../src/lookup/LookupServingEpoch.js'
import { prepareLiveLookupSource } from '../src/sources/LiveLookupConfiguration.js'
import { liveFixture } from './live-lookup-fixture.js'

const epoch = '0a'.repeat(32)
function capabilityBody(): OutputCapabilities {
  const fixture = liveFixture()
  return selectOutputCapability(fixture.options.manifest, fixture.selection).manifest.body
}

describe('reference-provider storage epoch binding', () => {
  it('binds a distinct signed selector while requiring no new behavior from a base client', () => {
    const fixture = liveFixture()
    const manifest = signOutputPacket(
      'capabilities',
      {
        ...fixture.options.manifest.body,
        extensions: lookupServingEpochExtension([{ service: 'records', epoch }])
      },
      new PrivateKey(1)
    )
    const selected = selectOutputCapability(manifest, fixture.selection)
    expect(lookupServingEpoch(selected.manifest.body, 'records')).toBe(epoch)
    expect(selected.digest).not.toBe(
      selectOutputCapability(fixture.options.manifest, fixture.selection).digest
    )
    expect(() => prepareLiveLookupSource({ ...fixture.options, manifest })).not.toThrow()
    const replaced = signOutputPacket(
      'capabilities',
      {
        ...manifest.body,
        extensions: lookupServingEpochExtension([{ service: 'records', epoch: '0b'.repeat(32) }])
      },
      new PrivateKey(1)
    )
    expect(selectOutputCapability(replaced, fixture.selection).digest).not.toBe(selected.digest)
    expect(
      lookupServingEpoch(
        selectOutputCapability(manifest, fixture.selection).manifest.body,
        'records'
      )
    ).toBe(epoch)
  })

  it('supports independently retained services in the same signed manifest', () => {
    const body = capabilityBody()
    body.extensions = lookupServingEpochExtension([
      { service: 'records', epoch },
      { service: 'other', epoch: '0b'.repeat(32) }
    ])
    expect(lookupServingEpoch(body, 'records')).toBe(epoch)
    expect(lookupServingEpoch(body, 'other')).toBe('0b'.repeat(32))
    expect(() => lookupServingEpoch(body, 'absent')).toThrow(
      'Selected lookup has no retained storage epoch'
    )
  })

  it.each([
    { version: 2, services: [{ service: 'records', epoch }] },
    { version: 1, services: [] },
    { version: 1, services: 'not an array' },
    { version: 1, services: [{ service: 'records', epoch: 'bad' }] },
    {
      version: 1,
      services: [
        { service: 'records', epoch },
        { service: 'records', epoch }
      ]
    },
    {
      version: 1,
      services: Array.from({ length: 257 }, (_, index) => ({ service: String(index), epoch }))
    },
    { version: 1, services: [{ service: 'records', epoch, extra: true }] }
  ])('rejects malformed or ambiguous epoch bindings (%#)', value => {
    const body = capabilityBody()
    const changed = {
      ...body,
      extensions: { [LOOKUP_STORAGE_EPOCH_EXTENSION]: value }
    } as OutputCapabilities
    expect(() => lookupServingEpoch(changed, 'records')).toThrow()
  })

  it('requires an explicit reference-provider epoch and leaves unrelated extensions intact', () => {
    const body = capabilityBody()
    expect(() => lookupServingEpoch(body, 'records')).toThrow(
      'requires a signed storage epoch binding'
    )
    const existing = { 'urn:example:display': { label: 'Catalogue' } }
    const extensions = {
      ...existing,
      ...lookupServingEpochExtension([{ service: 'records', epoch }])
    }
    expect(extensions['urn:example:display']).toEqual(existing['urn:example:display'])
    expect(lookupServingEpoch({ ...body, extensions }, 'records')).toBe(epoch)
  })
})

describe('epoch writer limits and failure classification', () => {
  it('accepts exactly 256 bindings and rejects empty or oversized inventories at creation', () => {
    const services = Array.from({ length: 256 }, (_, i) => ({ service: String(i), epoch }))
    expect(lookupServingEpochExtension(services)[LOOKUP_STORAGE_EPOCH_EXTENSION]).toEqual({
      version: 1,
      services
    })
    for (const selected of [[], [...services, { service: 'extra', epoch }]])
      expect(() => lookupServingEpochExtension(selected)).toThrow(
        expect.objectContaining({
          code: 'invalid',
          message: 'Invalid lookup serving epoch binding'
        })
      )
    expect(() => lookupServingEpochExtension([services[0], services[0]])).toThrow(
      expect.objectContaining({
        code: 'invalid',
        message: 'Duplicate lookup serving epoch binding'
      })
    )
  })

  it('distinguishes an unsupported provider contract from lost service continuity', () => {
    const body = capabilityBody()
    expect(() => lookupServingEpoch(body, 'records')).toThrow(
      expect.objectContaining({ code: 'unsupported' })
    )
    body.extensions = lookupServingEpochExtension([{ service: 'other', epoch }])
    expect(() => lookupServingEpoch(body, 'records')).toThrow(
      expect.objectContaining({ code: 'reset-required' })
    )
  })
})
