import { expect, it } from '@jest/globals'
import { createHash, createSecretKey } from 'node:crypto'
import { canonicalOutputJSON, PrivateKey } from '@bsv/sdk'
import { PrivateServiceIdentity } from '../src/private/PrivateServiceIdentity.js'
import {
  PrivateAcquisitionPayloads,
  parsePrivateAcquisitionPayload
} from '../src/private/PrivateAcquisitionPayloads.js'
import type {
  ProtectedLedgerChange,
  ProtectedLedgerRecord
} from '../src/private/ProtectedLedgerCodec.js'
import { authorize, clock, configuration, fixture } from './protected-ledger-fixture.js'

const id = 'aa'.repeat(32),
  request = 'bb'.repeat(32)
function helper(scope = 1) {
  return new PrivateAcquisitionPayloads(
    new PrivateServiceIdentity(
      {
        chain: { network: 'payload-test', genesisHash: 'cc'.repeat(32) },
        seller: new PrivateKey(scope).toPublicKey().toString()
      },
      { resolve: () => createSecretKey(Buffer.alloc(32, 16)) },
      'index'
    )
  )
}
function records(changes: ProtectedLedgerChange[]): ProtectedLedgerRecord[] {
  return changes.map(({ expectedRevision: _, ...rest }) => ({
    ...structuredClone(rest),
    revision: '1'
  }))
}
it.each([0, 1, 786431, 786432, 786433, 4194304])(
  'reserves, stores and restores %i actual bytes in one native revision',
  size => {
    const h = helper(),
      data = Buffer.alloc(size, 73),
      encoded = data.toString('base64')
    const { descriptor, changes } = h.reserve(id, request, 'material', Math.max(1, size), encoded)
    const f = fixture({
      ...configuration,
      maximumRecords: 16,
      maximumRecordBytes: 2 * 1024 * 1024,
      maximumReservedBytes: 8 * 1024 * 1024
    })
    expect(
      f.ledger.commit('0', changes, clock, authorize, { maximumBatchBytes: 8 * 1024 * 1024 })
    ).toBe('1')
    const rows = f.reopen().read(h.addresses(descriptor), clock, authorize).records
    expect(h.read(descriptor, rows)).toBe(encoded)
    expect(descriptor.bytes).toBe(size)
    expect(descriptor.digest).toBe(
      createHash('sha256')
        .update('private-acquisition-payload/1\0')
        .update(
          canonicalOutputJSON({ acquisitionId: id, requestDigest: request, purpose: 'material' })
        )
        .update('\0')
        .update(data)
        .digest('hex')
    )
    expect(rows.every(row => row?.reservedUpdates === 0)).toBe(true)
  }
)
it('reserves all result slots before payment then seals once at already allocated capacity', () => {
  const h = helper(),
    initial = h.reserve(id, request, 'result', 786433)
  const reserved = initial.changes.reduce((sum, c) => sum + c.reservedBytes, 0)
  const f = fixture({
    ...configuration,
    maximumRecords: 2,
    maximumRecordBytes: 2 * 1024 * 1024,
    maximumReservedBytes: reserved
  })
  expect(f.ledger.commit('0', initial.changes, clock, authorize)).toBe('1')
  const rows = f.ledger.read(h.addresses(initial.descriptor), clock, authorize).records
  expect(() => h.read(initial.descriptor, rows)).toThrow('not yet complete')
  const result = Buffer.alloc(786433, 25).toString('base64')
  const sealed = h.seal(initial.descriptor, rows, result)
  expect(f.ledger.commit('1', sealed.changes, clock, authorize)).toBe('2')
  const restored = f.reopen().read(h.addresses(sealed.descriptor), clock, authorize).records
  expect(h.read(sealed.descriptor, restored)).toBe(result)
  expect(h.seal(sealed.descriptor, restored, result)).toEqual({
    descriptor: sealed.descriptor,
    changes: []
  })
  expect(() => h.seal(sealed.descriptor, restored, 'AQ==')).toThrow('already immutable')
})
it('retains reserved unused chunks when the eventual result is shorter than its allowance', () => {
  const h = helper(),
    start = h.reserve(id, request, 'result', 4194304)
  const sealed = h.seal(start.descriptor, records(start.changes), 'AQ==')
  expect(sealed.changes).toHaveLength(6)
  expect(h.read(sealed.descriptor, records(sealed.changes))).toBe('AQ==')
  expect(sealed.changes.slice(1).every(c => c.value.data === '')).toBe(true)
})
it('separates opaque slots by purpose, request, acquisition, seller and chunk position', () => {
  const h = helper(),
    base = h.reserve(id, request, 'material', 786433, '').descriptor
  const positions = [
    ...h.addresses(base),
    ...h.addresses({ ...base, purpose: 'result' }),
    ...h.addresses({ ...base, requestDigest: 'dd'.repeat(32) }),
    ...h.addresses({ ...base, acquisitionId: 'ee'.repeat(32) }),
    ...helper(2).addresses(base)
  ]
  expect(new Set(positions.map(p => p.key)).size).toBe(10)
  expect(positions.every(p => p.kind === 'delivery' && /^[0-9a-f]{64}$/.test(p.key))).toBe(true)
})
it.each([0, -1, 1.1, 4194305, NaN])('rejects payload allowance %p before reserving', maximum => {
  expect(() => helper().reserve(id, request, 'result', maximum)).toThrow()
})
it.each([
  'format',
  'purpose',
  'acquisitionId',
  'requestDigest',
  'chunks',
  'bytes',
  'digest',
  'extra'
] as const)('validates descriptor %s independently', field => {
  const h = helper(),
    descriptor = h.reserve(id, request, 'material', 4, 'AQ==').descriptor
  const bad: any = { ...descriptor }
  if (field === 'format' || field === 'purpose') bad[field] = 'other'
  if (field === 'acquisitionId' || field === 'requestDigest' || field === 'digest')
    bad[field] = 'bad'
  if (field === 'chunks') bad.chunks = 2
  if (field === 'bytes') bad.bytes = 5
  if (field === 'extra') bad.extra = true
  expect(() => parsePrivateAcquisitionPayload(bad)).toThrow()
})
it('requires paired completion facts and integral nonnegative bounded actual length', () => {
  const initial = helper().reserve(id, request, 'result', 4).descriptor
  for (const facts of [
    { bytes: 0 },
    { digest: 'aa'.repeat(32) },
    { bytes: -1, digest: 'aa'.repeat(32) },
    { bytes: 1.5, digest: 'aa'.repeat(32) }
  ])
    expect(() => parsePrivateAcquisitionPayload({ ...initial, ...facts })).toThrow()
})
it.each([
  'missing',
  'key',
  'kind',
  'capacity',
  'updates',
  'frame',
  'id',
  'request',
  'purpose',
  'index',
  'digest',
  'data',
  'extra'
] as const)('requires every retained slot binding: %s', field => {
  const h = helper(),
    prepared = h.reserve(id, request, 'material', 4, 'AQ=='),
    rows = records(prepared.changes)
  if (field === 'missing') rows.pop()
  else if (field === 'key') rows[0].key = 'ee'.repeat(32)
  else if (field === 'kind') rows[0].kind = 'acquisition'
  else if (field === 'capacity') rows[0].reservedBytes++
  else if (field === 'updates') rows[0].reservedUpdates++
  else if (field === 'frame') rows[0].value.format = 'other'
  else if (field === 'id') rows[0].value.acquisitionId = 'ee'.repeat(32)
  else if (field === 'request') rows[0].value.requestDigest = 'ee'.repeat(32)
  else if (field === 'purpose') rows[0].value.purpose = 'result'
  else if (field === 'index') rows[0].value.index = 1
  else if (field === 'digest') rows[0].value.digest = 'ee'.repeat(32)
  else if (field === 'data') rows[0].value.data = null
  else rows[0].value.extra = true
  expect(() => h.read(prepared.descriptor, rows)).toThrow()
})
it('fails closed for missing or already populated reserved slots', () => {
  const h = helper(),
    p = h.reserve(id, request, 'result', 4),
    rows = records(p.changes)
  expect(() => h.seal(p.descriptor, [undefined], 'AQ==')).toThrow('slot reservation differs')
  rows[0].value.data = 'AQ=='
  expect(() => h.seal(p.descriptor, rows, 'AQ==')).toThrow('unbound data')
})
it('verifies actual retained bytes even on an identical completed retry', () => {
  const h = helper(),
    p = h.reserve(id, request, 'result', 4, 'AQ=='),
    rows = records(p.changes)
  rows[0].value.data = 'Ag=='
  expect(() => h.read(p.descriptor, rows)).toThrow('integrity differs')
  expect(() => h.seal(p.descriptor, rows, 'AQ==')).toThrow('integrity differs')
  rows[0].value.data = 'AQI='
  expect(() => h.read(p.descriptor, rows)).toThrow('chunk length differs')
})
it.each(['AR==', '!!!', 'AQ', 'AQI='])(
  'rejects malformed, noncanonical or oversized supplied bytes: %s',
  data => {
    const h = helper()
    expect(() => h.reserve(id, request, 'material', 1, data)).toThrow()
    const initial = h.reserve(id, request, 'result', 1)
    expect(() => h.seal(initial.descriptor, records(initial.changes), data)).toThrow()
  }
)
