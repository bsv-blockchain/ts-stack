import { createHash } from 'node:crypto'
import { parseSnapshotArchiveRequest, snapshotArchiveRequestId } from './SnapshotArchiveRequest'
import {
  parseSnapshotArchiveReaderRequest,
  snapshotArchiveReaderRequestId,
  validateSnapshotArchiveReaderRequest
} from './SnapshotArchiveReaderRequest'
import { snapshotArchiveLimits } from './SnapshotArchive'

const fields = { version: 2 as const, nonce: 'a'.repeat(64), notAfter: 1300000, maxBytes: 32768 }
function fixture() {
  return { ...fields, requestId: snapshotArchiveReaderRequestId(fields) }
}

test('independent SHA-256 fixes the reader domain and both parser paths reject cross-protocol requests', () => {
  const expected = createHash('sha256')
    .update(JSON.stringify(['wallet-snapshot-reader-request/1', 2, 'a'.repeat(64), 1300000, 32768]))
    .digest('hex')
  expect(snapshotArchiveReaderRequestId(fields)).toBe(expected)
  const reader = fixture()
  expect(parseSnapshotArchiveReaderRequest(reader)).toEqual(reader)
  expect(() => parseSnapshotArchiveRequest(reader)).toThrow()
  expect(() => parseSnapshotArchiveRequest({ ...reader, version: 1 })).toThrow()
  const legacyFields = { ...fields, version: 1 as const }
  const legacy = { ...legacyFields, requestId: snapshotArchiveRequestId(legacyFields) }
  expect(legacy.requestId).not.toBe(reader.requestId)
  expect(parseSnapshotArchiveRequest(legacy)).toEqual(legacy)
  expect(() => parseSnapshotArchiveReaderRequest(legacy)).toThrow()
  expect(() => parseSnapshotArchiveReaderRequest({ ...legacy, version: 2 })).toThrow()
})

test('reader request parsing detaches every field before asynchronous admission', () => {
  const input = fixture()
  const parsed = parseSnapshotArchiveReaderRequest(input)
  input.nonce = 'b'.repeat(64)
  input.notAfter++
  input.maxBytes++
  input.requestId = 'b'.repeat(64)
  expect(parsed).toEqual(fixture())
  expect(Object.isFrozen(parsed)).toBe(true)
})

test('reader request exact fields reject altered identities, invalid bounds and hidden/getter values', () => {
  const changes = [
    { version: 1 },
    { nonce: 'a'.repeat(63) },
    { nonce: 'A'.repeat(64) },
    { nonce: 1 },
    { notAfter: 0 },
    { notAfter: 1.5 },
    { notAfter: Number.MAX_SAFE_INTEGER + 1 },
    { notAfter: '1300000' },
    { maxBytes: snapshotArchiveLimits.headerCharge },
    { maxBytes: snapshotArchiveLimits.archiveBytes + 1 },
    { maxBytes: Number.NaN },
    { maxBytes: '32768' },
    { requestId: 'b'.repeat(64) },
    { extra: true }
  ]
  for (const change of changes)
    expect(() => parseSnapshotArchiveReaderRequest({ ...fixture(), ...change })).toThrow(
      'Invalid snapshot archive reader request'
    )
  for (const input of [undefined, null, 1, [], {}, 'request'])
    expect(() => parseSnapshotArchiveReaderRequest(input)).toThrow('Invalid snapshot archive reader request')
  for (const key of Object.keys(fixture())) {
    const missing = { ...fixture() } as Record<string, unknown>
    delete missing[key]
    expect(() => parseSnapshotArchiveReaderRequest(missing)).toThrow('Invalid snapshot archive reader request')
    const getter = jest.fn(() => 1)
    expect(() =>
      parseSnapshotArchiveReaderRequest(Object.defineProperty(fixture(), key, { get: getter, enumerable: true }))
    ).toThrow('Invalid snapshot archive reader request')
    expect(getter).not.toHaveBeenCalled()
    const hidden = fixture()
    Object.defineProperty(hidden, key, { enumerable: false })
    expect(() => parseSnapshotArchiveReaderRequest(hidden)).toThrow('Invalid snapshot archive reader request')
  }
})

test('database-clock deadline validation never extends a reader after expiry', () => {
  expect(validateSnapshotArchiveReaderRequest(fixture(), 1000000)).toEqual(fixture())
  expect(validateSnapshotArchiveReaderRequest(fixture(), fields.notAfter - 1)).toEqual(fixture())
  for (const now of [fields.notAfter, fields.notAfter + 1, -1, Number.NaN, Infinity, 1.5]) {
    expect(() => validateSnapshotArchiveReaderRequest(fixture(), now)).toThrow(
      'Invalid snapshot archive reader request'
    )
  }
  const long = { ...fields, notAfter: 1000000 + snapshotArchiveLimits.lifetimeMs }
  expect(
    validateSnapshotArchiveReaderRequest({ ...long, requestId: snapshotArchiveReaderRequestId(long) }, 1000000).notAfter
  ).toBe(long.notAfter)
  long.notAfter++
  expect(() =>
    validateSnapshotArchiveReaderRequest({ ...long, requestId: snapshotArchiveReaderRequestId(long) }, 1000000)
  ).toThrow('Invalid snapshot archive reader request')
})

test('valid independent digests do not authorize malformed request fields or exclude inclusive bounds', () => {
  const signed = (changes: Record<string, unknown>) => {
    const value = { ...fields, ...changes }
    const requestId = createHash('sha256')
      .update(
        JSON.stringify(['wallet-snapshot-reader-request/1', value.version, value.nonce, value.notAfter, value.maxBytes])
      )
      .digest('hex')
    return { ...value, requestId }
  }
  for (const change of [
    { nonce: 'x' + fields.nonce },
    { nonce: fields.nonce + 'x' },
    { nonce: fields.nonce + '\n' },
    { notAfter: 0 },
    { notAfter: -1 },
    { notAfter: 1.5 },
    { notAfter: '1300000' },
    { maxBytes: snapshotArchiveLimits.headerCharge },
    { maxBytes: snapshotArchiveLimits.headerCharge - 1 },
    { maxBytes: snapshotArchiveLimits.archiveBytes + 1 },
    { maxBytes: '32768' }
  ]) {
    expect(() => parseSnapshotArchiveReaderRequest(signed(change))).toThrow('Invalid snapshot archive reader request')
  }
  for (const maxBytes of [snapshotArchiveLimits.headerCharge + 1, snapshotArchiveLimits.archiveBytes]) {
    const value = signed({ notAfter: 1, maxBytes })
    expect(parseSnapshotArchiveReaderRequest(value)).toEqual(value)
    expect(validateSnapshotArchiveReaderRequest(value, 0)).toEqual(value)
  }
  for (const name of Object.keys(fixture())) {
    const missing: Record<string, unknown> = { ...fixture(), replacement: 1 }
    delete missing[name]
    expect(() => parseSnapshotArchiveReaderRequest(missing)).toThrow('Invalid snapshot archive reader request')
  }
})
