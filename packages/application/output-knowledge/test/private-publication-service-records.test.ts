import { expect, it } from '@jest/globals'
import { canonicalOutputJSON } from '@bsv/sdk'
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
