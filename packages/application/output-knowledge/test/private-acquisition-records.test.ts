import { beforeAll, expect, it } from '@jest/globals'
import { canonicalOutputJSON, outputPacketDigest, signOutputPacket } from '@bsv/sdk'
import { PrivateAcquisitionRecords } from '../src/private/PrivateAcquisitionRecords.js'
import { acquisitionRecordFixture } from './private-acquisition-records.fixture.js'
let f: Awaited<ReturnType<typeof acquisitionRecordFixture>>
beforeAll(async () => {
  f = await acquisitionRecordFixture()
})
it('retains the signed original, frozen evidence, schema and complete response allowance', () => {
  const prepared = f.records.prepare(f.input)
  expect(prepared.record).toEqual({
    ...f.input,
    format: 'private-acquisition-original/1',
    validationPolicy: f.policy
  })
  expect(prepared.responseBytes).toBeGreaterThan(131072 + 4 * Math.ceil(65536 / 3))
  expect(f.records.restore(prepared.record)).toEqual(prepared)
  expect(() => f.contracts.retain(f.manifest(), '101')).toThrow()
  expect(f.records.restore(prepared.record)).toEqual(prepared)
})
it('owns nested caller data and installed policy', () => {
  const input = structuredClone(f.input),
    settings = { ...f.settings, validationPolicy: { ...f.policy } }
  const records = new PrivateAcquisitionRecords(settings),
    prepared = records.prepare(input)
  input.schema = 'changed'
  input.evidence.beef = ''
  settings.validationPolicy.digest = '77'.repeat(32)
  expect(records.restore(prepared.record).record.schema).toBe(f.input.schema)
  expect(prepared.record.evidence).toEqual(f.evidence)
})
it.each([
  'format',
  'extra',
  'policy-id',
  'policy-digest',
  'context-chain',
  'evidence-txid',
  'evidence-index',
  'evidence-beef',
  'evidence-extra',
  'schema',
  'context-capacity',
  'acceptance-capacity'
] as const)('rejects changed/invalid original %s', field => {
  const record = f.records.prepare(f.input).record
  let expected: string | undefined
  if (field === 'format') {
    ;(record as unknown as Record<string, unknown>).format = 'other'
    expected = 'Unsupported'
  }
  if (field === 'extra') (record as unknown as Record<string, unknown>).extra = true
  if (field === 'policy-id') {
    record.validationPolicy.id = 'urn:test:other'
    expected = 'validation policy changed'
  }
  if (field === 'policy-digest') {
    record.validationPolicy.digest = '77'.repeat(32)
    expected = 'validation policy changed'
  }
  if (field === 'context-chain') {
    record.verificationContext.view.chain.network = 'different'
    expected = 'chain context differs'
  }
  if (field === 'evidence-txid') {
    record.evidence.txid = '77'.repeat(32)
    expected = 'frozen evidence differs'
  }
  if (field === 'evidence-index') {
    record.evidence.outputIndex = 1
    expected = 'frozen evidence differs'
  }
  if (field === 'evidence-beef') record.evidence.beef = 'AQ=='
  if (field === 'evidence-extra')
    (record.evidence as unknown as Record<string, unknown>).extra = true
  if (field === 'schema') record.schema = ''
  if (field === 'context-capacity') record.maximumContextBytes = 4194305
  if (field === 'acceptance-capacity') record.maximumAcceptanceBytes = 131073
  expect(() => f.records.restore(record)).toThrow(expected)
  if (expected !== undefined) {
    const messages = {
      format: ['unsupported', 'Unsupported acquisition original record'],
      'policy-id': ['context-changed', 'Acquisition validation policy changed'],
      'policy-digest': ['context-changed', 'Acquisition validation policy changed'],
      'context-chain': ['context-changed', 'Acquisition original chain context differs'],
      'evidence-txid': ['unavailable', 'Acquisition frozen evidence differs from listing'],
      'evidence-index': ['unavailable', 'Acquisition frozen evidence differs from listing']
    } as const
    const [code, message] = messages[field as keyof typeof messages]
    expect(() => f.records.restore(record)).toThrow(expect.objectContaining({ code, message }))
  }
})
it('rejects too-small acceptance before allocating material or issuing a quote', () => {
  expect(() => f.records.prepare({ ...f.input, maximumAcceptanceBytes: 1 })).toThrow(
    'acceptance allowance cannot hold'
  )
})
it('accounts for the complete future response, including base64 expansion and acceptance', () => {
  expect(() => f.records.prepare({ ...f.input, maximumContextBytes: 1048576 })).toThrow(
    'complete result cannot fit'
  )
  const baseline = f.records.prepare(f.input)
  const body = structuredClone(f.body)
  body.services[0].profiles[0].maxResponseBytes = baseline.responseBytes
  const q = f.contracts.prepare(
    f.input.request,
    signOutputPacket('capabilities', body, f.key),
    f.terms,
    '20'
  )
  expect(f.records.prepare({ ...f.input, capability: q.capability }).responseBytes).toBe(
    baseline.responseBytes
  )
  body.services[0].profiles[0].maxResponseBytes--
  const short = f.contracts.prepare(
    f.input.request,
    signOutputPacket('capabilities', body, f.key),
    f.terms,
    '20'
  )
  expect(() => f.records.prepare({ ...f.input, capability: short.capability })).toThrow(
    'complete result cannot fit'
  )
})
it('reserves escaped terminal reasons even when context is tiny', () => {
  const original = f.records.prepare({
    ...f.input,
    maximumContextBytes: 1,
    maximumAcceptanceBytes: 1024
  })
  const body = structuredClone(f.body)
  body.services[0].profiles[0].maxResponseBytes = original.responseBytes - 1
  const q = f.contracts.prepare(
    f.input.request,
    signOutputPacket('capabilities', body, f.key),
    f.terms,
    '20'
  )
  expect(() =>
    f.records.prepare({
      ...f.input,
      capability: q.capability,
      maximumContextBytes: 1,
      maximumAcceptanceBytes: 1024
    })
  ).toThrow('complete result cannot fit')
})
it('rejects a quote with another acceptance policy even when its request digest is unchanged', () => {
  const challenge = {
    ...f.input.challenge,
    acceptancePolicy: { kind: 'mined' as const, confirmations: 1 }
  }
  expect(() => f.records.prepare({ ...f.input, challenge })).toThrow(
    'original installation differs'
  )
})
it('requires the advertised recovery floor and the installed maximum on restoration', () => {
  const body = structuredClone(f.body)
  body.services[0].profiles[0].parameters.recoverySeconds = '172800'
  const q = f.contracts.prepare(
    f.input.request,
    signOutputPacket('capabilities', body, f.key),
    f.terms,
    '20'
  )
  expect(() => f.records.prepare({ ...f.input, capability: q.capability })).toThrow(
    'original recovery promise differs'
  )
  expect(() =>
    f.records.prepare({
      ...f.input,
      challenge: { ...q.challenge, recoveryUntil: '172901' },
      capability: q.capability
    })
  ).toThrow('original recovery promise differs')
})
it('bounds the complete owned original record and validates installation capacity', () => {
  const original = f.records.prepare(f.input).record,
    exact = Buffer.byteLength(canonicalOutputJSON(original))
  expect(
    new PrivateAcquisitionRecords({ ...f.settings, maximumRecordBytes: exact }).restore(original)
      .record
  ).toEqual(original)
  expect(() =>
    new PrivateAcquisitionRecords({ ...f.settings, maximumRecordBytes: exact - 1 }).restore(
      original
    )
  ).toThrow('Output JSON byte limit')
  expect(
    () => new PrivateAcquisitionRecords({ ...f.settings, maximumRecordBytes: 2097153 })
  ).toThrow()
  expect(
    () =>
      new PrivateAcquisitionRecords({
        ...f.settings,
        supportedExtensions: Array.from({ length: 33 }, () => 'urn:test:extension')
      })
  ).toThrow('record extensions')
})
it('does not restore a modified signed manifest or changed semantic request', () => {
  const record = f.records.prepare(f.input).record
  record.capability.manifest.body.expiresAt = '200'
  expect(() => f.records.restore(record)).toThrow()
  const changed = f.records.prepare(f.input).record
  changed.request.termsDigest = '77'.repeat(32)
  expect(() => f.records.restore(changed)).toThrow('differs from selected request')
  expect(outputPacketDigest('acquire-request', f.input.request)).toBe(
    f.input.challenge.requestDigest
  )
})

it('bounds the complete installed extension representation before accepting each individual identifier', () => {
  expect(
    () =>
      new PrivateAcquisitionRecords({
        ...f.settings,
        supportedExtensions: Array.from(
          { length: 32 },
          (_, index) => 'urn:test:' + index + ':' + 'x'.repeat(750)
        )
      })
  ).toThrow('Output JSON byte limit')
  expect(
    () =>
      new PrivateAcquisitionRecords({
        ...f.settings,
        supportedExtensions: Array.from({ length: 32 }, (_, index) => 'urn:test:extension:' + index)
      })
  ).not.toThrow()
  expect(
    () =>
      new PrivateAcquisitionRecords({
        ...f.settings,
        supportedExtensions: {} as readonly string[]
      })
  ).toThrow(
    expect.objectContaining({ code: 'invalid', message: 'Invalid acquisition record extensions' })
  )
  expect(
    () =>
      new PrivateAcquisitionRecords({
        ...f.settings,
        supportedExtensions: null as unknown as readonly string[]
      })
  ).not.toThrow()
})

it.each(['service', 'chain', 'listing-txid', 'listing-index', 'unavailable-output'] as const)(
  'separately binds the self-consistent request %s to its actual installation and frozen evidence',
  field => {
    const record = f.records.prepare(f.input).record
    if (field === 'service') record.request.service = 'another-installed-service'
    if (field === 'chain') record.request.listing.chain.network = 'another-chain'
    if (field === 'listing-txid') record.request.listing.txid = 'ef'.repeat(32)
    if (field === 'listing-index') record.request.listing.outputIndex = 1
    if (field === 'unavailable-output') {
      record.request.listing.outputIndex = 0xffffffff
      record.evidence.outputIndex = 0xffffffff
    }
    record.challenge.requestDigest = outputPacketDigest('acquire-request', record.request)
    record.challenge.acquisitionId = outputPacketDigest('acquisition', {
      chain: record.request.listing.chain,
      seller: record.challenge.seller,
      buyer: record.challenge.buyer,
      service: record.request.service,
      requestId: record.request.requestId
    })
    const installation = field === 'service' || field === 'chain'
    expect(() => f.records.restore(record)).toThrow(
      expect.objectContaining({
        code: installation ? 'context-changed' : 'unavailable',
        message: installation
          ? 'Acquisition original installation differs'
          : 'Acquisition frozen evidence differs from listing'
      })
    )
    expect(f.records.prepare(f.input).record.request).toEqual(f.input.request)
  }
)

it('accepts the exact installed recovery ceiling and refuses the next second', () => {
  const challenge = { ...f.input.challenge, recoveryUntil: '172900' }
  expect(f.records.prepare({ ...f.input, challenge }).record.challenge.recoveryUntil).toBe('172900')
  expect(() =>
    f.records.prepare({ ...f.input, challenge: { ...challenge, recoveryUntil: '172901' } })
  ).toThrow(
    expect.objectContaining({
      code: 'context-changed',
      message: 'Acquisition original recovery promise differs from installation'
    })
  )
})
