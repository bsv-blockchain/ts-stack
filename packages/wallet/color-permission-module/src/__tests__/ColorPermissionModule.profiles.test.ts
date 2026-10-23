import { beforeEach, describe, expect, it } from '@jest/globals'
import type { StrictCborValue } from '@bsv/templates'
import { ColorPermissionModule } from '../ColorPermissionModule.js'
import { ProfileParamsError } from '../errors.js'
import type { RequiredProfileHandler } from '../profiles.js'
import { createModule, FakeProvider, FakeWallet } from './fixtures.js'
import { exampleProfile, FakeStore } from './profileFixtures.js'

describe('profile registry construction', () => {
  let wallet: ReturnType<FakeWallet['asWallet']>
  let provider: FakeProvider
  let store: FakeStore
  let ex: RequiredProfileHandler
  const requestTokenAccess = async (): Promise<boolean> => true

  beforeEach(() => {
    wallet = new FakeWallet().asWallet()
    provider = new FakeProvider()
    store = new FakeStore()
    ex = exampleProfile()
  })

  it('requires a store when profiles are registered', () => {
    expect(
      () =>
        new ColorPermissionModule({
          wallet,
          provider,
          requestTokenAccess,
          profiles: { [ex.id]: ex }
        })
    ).toThrow(new TypeError('BRC-207: a store is required when profiles are registered'))
    expect(
      () =>
        new ColorPermissionModule({
          wallet,
          provider,
          requestTokenAccess,
          profiles: { [ex.id]: ex }
        })
    ).toThrow(TypeError)
  })

  it('accepts registered profiles with a store, and an empty registry without one', () => {
    expect(
      () =>
        new ColorPermissionModule({
          wallet,
          provider,
          requestTokenAccess,
          store,
          profiles: { [ex.id]: ex }
        })
    ).not.toThrow()
    expect(
      () => new ColorPermissionModule({ wallet, provider, requestTokenAccess, profiles: {} })
    ).not.toThrow()
    expect(store.writes).toEqual([])
  })

  it('requires a store that implements the store contract', () => {
    for (const method of ['get', 'set', 'delete', 'keys'] as const) {
      const partial = { ...store, [method]: undefined } as unknown as FakeStore
      expect(
        () =>
          new ColorPermissionModule({
            wallet,
            provider,
            requestTokenAccess,
            store: partial,
            profiles: { [ex.id]: ex }
          })
      ).toThrow(new TypeError('BRC-207: the store must implement get, set, delete and keys'))
    }
  })

  it('requires each profiles key to equal its handler id', () => {
    expect(
      () =>
        new ColorPermissionModule({
          wallet,
          provider,
          requestTokenAccess,
          store,
          profiles: { 'urn:example:other': ex }
        })
    ).toThrow(new TypeError('BRC-207: profiles key must equal its handler id'))
  })

  it('rejects an invalid handler id or version list', () => {
    const invalid: RequiredProfileHandler[] = [
      { ...ex, id: 'Not-A-URI' },
      { ...ex, id: `urn:${'x'.repeat(197)}` },
      { ...ex, versions: [] },
      { ...ex, versions: [0] },
      { ...ex, versions: [2 ** 32] },
      { ...ex, versions: [1.5] },
      { ...ex, versions: 1 as unknown as number[] },
      { ...ex, checkDescriptor: undefined as unknown as RequiredProfileHandler['checkDescriptor'] }
    ]
    for (const handler of invalid) {
      expect(
        () =>
          new ColorPermissionModule({
            wallet,
            provider,
            requestTokenAccess,
            store,
            profiles: { [handler.id]: handler }
          })
      ).toThrow(/^BRC-207: invalid profile handler/)
      expect(
        () =>
          new ColorPermissionModule({
            wallet,
            provider,
            requestTokenAccess,
            store,
            profiles: { [handler.id]: handler }
          })
      ).toThrow(TypeError)
    }
    expect(
      () =>
        new ColorPermissionModule({
          wallet,
          provider,
          requestTokenAccess,
          store,
          profiles: { [ex.id]: null as unknown as RequiredProfileHandler }
        })
    ).toThrow(/^BRC-207: invalid profile handler/)
    // The largest uint32 version is valid.
    expect(
      () =>
        new ColorPermissionModule({
          wallet,
          provider,
          requestTokenAccess,
          store,
          profiles: { [ex.id]: { ...ex, versions: [1, 2 ** 32 - 1] } }
        })
    ).not.toThrow()
  })

  it('rejects malformed optional handler members and registries', () => {
    const construct = (profiles: unknown) => () =>
      new ColorPermissionModule({
        wallet,
        provider,
        requestTokenAccess,
        store,
        profiles: profiles as Record<string, RequiredProfileHandler>
      })
    const malformed: Array<Record<string, unknown>> = [
      { provider: 'x' },
      { deployProviders: {} },
      { checkPlanData: 1 },
      { submissionData: true },
      { admitReceipt: [] },
      { checkExt: 'x' },
      { sendPolicy: 'broadcast' },
      { operations: 'transfer' },
      { operations: ['transfer', 'teleport'] }
    ]
    for (const member of malformed)
      expect(construct({ [ex.id]: { ...ex, ...member } })).toThrow(
        /^BRC-207: invalid profile handler/
      )
    for (const registry of [null, 'x', [ex]])
      expect(construct(registry)).toThrow(/^BRC-207: invalid profile handler/)
    expect(
      construct({
        [ex.id]: {
          ...ex,
          provider: () => provider,
          deployProviders: () => [provider],
          sendPolicy: 'plain-nosend',
          operations: ['transfer'],
          admitReceipt: async () => ({ credit: 'settled' })
        }
      })
    ).not.toThrow()
  })

  it('snapshots the registry at construction', async () => {
    const profiles: Record<string, RequiredProfileHandler> = { [ex.id]: ex }
    const module = new ColorPermissionModule({
      wallet,
      provider,
      requestTokenAccess,
      store,
      profiles
    })
    profiles['urn:example:late'] = { ...ex, id: 'urn:example:late' }
    expect([...(module as unknown as { profiles: Map<string, unknown> }).profiles.keys()]).toEqual([
      ex.id
    ])
  })

  it('advertises the same capabilities with or without profiles', () => {
    expect(createModule(new FakeWallet(), new FakeProvider()).capabilities).toEqual({
      'brc207-color': '4'
    })
    expect(
      new ColorPermissionModule({
        wallet,
        provider,
        requestTokenAccess,
        store,
        profiles: { [ex.id]: ex }
      }).capabilities
    ).toEqual({ 'brc207-color': '4' })
  })

  it('exampleProfile checks its params and ext entry', () => {
    expect(() => ex.checkDescriptor({ version: 1, params: null }, new Map())).not.toThrow()
    expect(() => ex.checkDescriptor({ version: 1, params: 0 }, new Map())).toThrow(
      ProfileParamsError
    )
    expect(() => ex.checkExt!(undefined)).not.toThrow()
    expect(() => ex.checkExt!({ revision: 0 })).not.toThrow()
    expect(() => ex.checkExt!({ revision: 3n })).not.toThrow()
    const bad: StrictCborValue[] = [
      null,
      0,
      [],
      new Uint8Array([0]),
      {},
      { revision: -1 },
      { revision: 'x' },
      { revision: 0, x: 1 }
    ]
    for (const value of bad) expect(() => ex.checkExt!(value)).toThrow(ProfileParamsError)
  })
})
