import { expect, it } from '@jest/globals'
import { canonicalOutputJSON, PrivateKey } from '@bsv/sdk'
import { PrivatePublicationServiceRecords } from '../src/private/PrivatePublicationServiceRecords.js'
import {
  createPrivatePublicationRecords,
  parsePrivatePublicationRecords
} from '../src/private/PrivatePublicationRecords.js'
import { contractFixture } from './private-publication-service-fixture.js'
import { fixture, config } from './private-publication-fixture.js'

function prepared(maximumBindingBytes = 8192, maximumOutcomeBytes = 4096) {
  const f = contractFixture(),
    configuration = config()
  configuration.identity = {
    chain: f.installation.chain,
    seller: f.installation.seller
  }
  const native = fixture(configuration)
  const records = createPrivatePublicationRecords(
    f.request,
    native.owner.identity,
    {
      publisher: f.prepared.fence.state.publisher,
      chain: f.installation.chain,
      lookup: f.prepared.fence.state.lookup
    },
    '20',
    '30'
  )
  const options = {
    contracts: f.contracts,
    validationPolicy: f.policy,
    lookup: f.prepared.fence.state.lookup,
    maximumBindingBytes,
    maximumOutcomeBytes
  }
  const service = new PrivatePublicationServiceRecords(native.owner, options)
  return { f, native, records, options, service }
}
it('retains a verified original contract in an explicitly versioned owned fence without writing it', () => {
  const { f, native, records, service } = prepared()
  const plan = service.prepare(records, f.record)
  expect(plan.fence.format).toBe('private-publication-fence/2')
  expect(plan.binding.phase).toBe('reserved')
  expect(service.restore(plan.fence, plan.blob)).toEqual(f.record)
  expect(
    parsePrivatePublicationRecords(plan.fence, plan.blob, native.owner.identity).fence
  ).toEqual(plan.fence)
  expect(plan.bindingAddress).toEqual(service.bindingAddress(plan.fence.state))
  expect(native.rows()).toHaveLength(0)
  f.record.capability.manifest.body.baseURL = 'https://changed.example'
  expect(service.restore(plan.fence, plan.blob).capability.manifest.body.baseURL).toBe(
    'https://seller.example/api'
  )
})
it('keeps legacy fences readable but cannot invent their absent original service context', () => {
  const { native, records, service } = prepared()
  expect(
    parsePrivatePublicationRecords(records.fence, records.blob, native.owner.identity)
  ).toMatchObject(records)
  expect(() => service.restore(records.fence, records.blob)).toThrow(
    expect.objectContaining({ code: 'unavailable' })
  )
  expect(() =>
    parsePrivatePublicationRecords(
      { ...records.fence, original: {} },
      records.blob,
      native.owner.identity
    )
  ).toThrow()
  expect(() =>
    parsePrivatePublicationRecords(
      { ...records.fence, format: 'private-publication-fence/2' },
      records.blob,
      native.owner.identity
    )
  ).toThrow(expect.objectContaining({ code: 'unavailable' }))
})
it('reserves the complete future binding rather than its smaller inactive representation', () => {
  const { f, records, service, native, options } = prepared()
  const plan = service.prepare(records, f.record)
  const size =
    Buffer.byteLength(
      canonicalOutputJSON({
        ...plan.binding,
        phase: 'active',
        admission: null
      })
    ) -
    4 +
    4096
  const small = new PrivatePublicationServiceRecords(native.owner, {
    ...options,
    maximumBindingBytes: size - 1
  })
  expect(() => small.prepare(records, f.record)).toThrow(
    expect.objectContaining({ code: 'limited' })
  )
  const exact = new PrivatePublicationServiceRecords(native.owner, {
    ...options,
    maximumBindingBytes: size
  })
  expect(exact.prepare(records, f.record)).toEqual(plan)
  expect(native.rows()).toHaveLength(0)
})
it('rejects an admission allowance that cannot coexist with full progress framing and later reasons', () => {
  const { f, records, service, native } = prepared(131072, 65536)
  expect(() => service.prepare(records, f.record)).toThrow(
    expect.objectContaining({
      code: 'limited',
      message: 'Private publication admission cannot fit its complete progress record'
    })
  )
  expect(native.rows()).toHaveLength(0)
})
it('binds service installation to the physical seller and chain custody domain', () => {
  const { options } = prepared(),
    wrong = fixture()
  expect(() => new PrivatePublicationServiceRecords(wrong.owner, options)).toThrow(
    expect.objectContaining({ code: 'context-changed' })
  )
  expect(wrong.rows()).toHaveLength(0)
})
it('requires the selected lookup service and rules before retaining a new original contract', () => {
  const { f, native, records, options } = prepared()
  const different = new PrivatePublicationServiceRecords(native.owner, {
    ...options,
    lookup: { ...options.lookup, service: 'ls_other' }
  })
  expect(() => different.prepare(records, f.record)).toThrow(
    expect.objectContaining({ code: 'context-changed' })
  )
  expect(() => different.bindingAddress(records.fence.state)).toThrow(
    expect.objectContaining({ code: 'context-changed' })
  )
  expect(native.rows()).toHaveLength(0)
})

it.each(['seller', 'chain'] as const)(
  'rejects an independent %s mismatch without creating custody rows',
  field => {
    const { f, options } = prepared(),
      configuration = config()
    configuration.identity = { chain: { ...f.installation.chain }, seller: f.installation.seller }
    if (field === 'seller')
      configuration.identity.seller = new PrivateKey(99).toPublicKey().toString()
    else configuration.identity.chain.genesisHash = 'ff'.repeat(32)
    const other = fixture(configuration)
    expect(() => new PrivatePublicationServiceRecords(other.owner, options)).toThrow(
      expect.objectContaining({
        code: 'context-changed',
        message: 'Private service and native custody domain differ'
      })
    )
    expect(other.rows()).toHaveLength(0)
  }
)
it('bounds and owns the installed extension vocabulary before accepting an original', () => {
  const { native, options, records, f } = prepared()
  const extensions = Array.from({ length: 32 }, (_, i) => 'urn:test:extension:' + i)
  const exact = new PrivatePublicationServiceRecords(native.owner, {
    ...options,
    supportedExtensions: extensions
  })
  extensions.push('urn:test:extension:overflow')
  expect(exact.prepare(records, f.record).fence.format).toBe('private-publication-fence/2')
  expect(
    () =>
      new PrivatePublicationServiceRecords(native.owner, {
        ...options,
        supportedExtensions: extensions
      })
  ).toThrow('Invalid private service extensions')
  expect(
    () =>
      new PrivatePublicationServiceRecords(native.owner, { ...options, supportedExtensions: [''] })
  ).toThrow()
  expect(
    () =>
      new PrivatePublicationServiceRecords(native.owner, {
        ...options,
        supportedExtensions: ['x'.repeat(16384)]
      })
  ).toThrow()
  expect(native.rows()).toHaveLength(0)
})
it('reports legacy metadata as unavailable without inventing an original contract', () => {
  const { service, records, native } = prepared()
  expect(() => service.restoreStatus(records.fence)).toThrow(
    expect.objectContaining({
      code: 'unavailable',
      message: 'Original private publication service contract is unavailable'
    })
  )
  expect(() => service.restore(records.fence, records.blob)).toThrow(
    expect.objectContaining({
      code: 'unavailable',
      message: 'Original private publication service contract is unavailable'
    })
  )
  expect(native.rows()).toHaveLength(0)
})
it('requires the original lookup rules for fresh preparation and both recovery projections', () => {
  const { f, service, native, options, records } = prepared(),
    plan = service.prepare(records, f.record)
  const changed = new PrivatePublicationServiceRecords(native.owner, {
    ...options,
    lookup: { ...options.lookup, rulesDigest: 'ff'.repeat(32) }
  })
  for (const call of [
    () => changed.prepare(records, f.record),
    () => changed.restore(plan.fence, plan.blob),
    () => changed.restoreStatus(plan.fence),
    () => changed.bindingAddress(plan.fence.state)
  ])
    expect(call).toThrow(
      expect.objectContaining({
        code: 'context-changed',
        message: 'Private publication lookup installation differs'
      })
    )
  expect(native.rows()).toHaveLength(0)
})
it('rejects oversized original envelopes at the one-MiB boundary before parsing or storing their content', () => {
  const { f, service, native, records } = prepared()
  const oversized = { ...f.record, unrecognized: 'x'.repeat(1048576) }
  expect(() => service.prepare(records, oversized)).toThrow(
    expect.objectContaining({ code: 'limited' })
  )
  expect(native.rows()).toHaveLength(0)
})
