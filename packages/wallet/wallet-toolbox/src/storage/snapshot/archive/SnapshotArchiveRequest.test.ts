import { createHash } from 'node:crypto'
import {
  parseSnapshotArchiveRequest,
  snapshotArchiveRequestId,
  validateSnapshotArchiveRequest
} from './SnapshotArchiveRequest'

const now = Date.UTC(2026, 8, 30)
function request() {
  const value = { version: 1 as const, nonce: 'a'.repeat(64), notAfter: now + 300000, maxBytes: 32768 }
  const requestId = createHash('sha256')
    .update(JSON.stringify(['wallet-snapshot-request/1', 1, value.nonce, value.notAfter, value.maxBytes]))
    .digest('hex')
  return { ...value, requestId }
}

test('binds every creation option and the immutable deadline to an independent digest', () => {
  const value = request()
  expect(snapshotArchiveRequestId(value)).toBe(value.requestId)
  const parsed = validateSnapshotArchiveRequest(value, now)
  expect(parsed).toEqual(value)
  expect(parsed).not.toBe(value)
  expect(Object.isFrozen(parsed)).toBe(true)
  value.nonce = 'b'.repeat(64)
  expect(parsed.nonce).toBe('a'.repeat(64))
})

test.each(['nonce', 'notAfter', 'maxBytes'] as const)('a changed %s cannot reuse its previous request ID', key => {
  const value = request()
  const changed = key === 'nonce' ? 'b'.repeat(64) : value[key] + 1
  expect(() => validateSnapshotArchiveRequest({ ...value, [key]: changed }, now)).toThrow(
    'Invalid snapshot archive creation request'
  )
})

test.each([now + 300000, now + 300001])(
  'an expired request cannot reopen at %s after its receipt is collected',
  clock => {
    expect(() => validateSnapshotArchiveRequest(request(), clock)).toThrow('Invalid snapshot archive creation request')
  }
)

test.each([1, 3600000])('accepts a bounded remaining lifetime of %i milliseconds', lifetime => {
  const value = { ...request(), notAfter: now + lifetime }
  value.requestId = snapshotArchiveRequestId(value)
  expect(validateSnapshotArchiveRequest(value, now).notAfter).toBe(value.notAfter)
})

test.each([4097, 32 * 1024 * 1024])('accepts a reservation of exactly %i bytes', maxBytes => {
  const value = { ...request(), maxBytes }
  value.requestId = snapshotArchiveRequestId(value)
  expect(validateSnapshotArchiveRequest(value, now).maxBytes).toBe(maxBytes)
})

test.each([
  ['version', 2],
  ['nonce', 'A'.repeat(64)],
  ['nonce', 'a'.repeat(63)],
  ['nonce', 'a'.repeat(65)],
  ['nonce', 1],
  ['notAfter', 0],
  ['notAfter', NaN],
  ['notAfter', Infinity],
  ['notAfter', 0.5],
  ['notAfter', 'timestamp'],
  ['notAfter', now + 3600001],
  ['maxBytes', 4096],
  ['maxBytes', 32 * 1024 * 1024 + 1],
  ['maxBytes', NaN],
  ['maxBytes', '32768'],
  ['maxBytes', 32768.5],
  ['requestId', 'b'.repeat(64)]
])('refuses malformed request %s=%p even with a recomputed ID', (key, changed) => {
  const value = { ...request(), [key]: changed }
  if (key !== 'requestId') value.requestId = snapshotArchiveRequestId(value as ReturnType<typeof request>)
  expect(() => validateSnapshotArchiveRequest(value, now)).toThrow('Invalid snapshot archive creation request')
})

test.each([null, undefined, 1, 'request', []])('refuses a non-record request %p', value => {
  expect(() => parseSnapshotArchiveRequest(value)).toThrow('Invalid snapshot archive creation request')
})

test.each([NaN, Infinity, -1, 0.5])('refuses an invalid database clock %s', clock => {
  expect(() => validateSnapshotArchiveRequest(request(), clock)).toThrow('Invalid snapshot archive creation request')
})

test('requires exact own data fields without invoking request accessors', () => {
  const value = request()
  expect(() => parseSnapshotArchiveRequest({ ...value, claimToken: 'secret' })).toThrow(
    'Invalid snapshot archive creation request'
  )
  expect(() => parseSnapshotArchiveRequest({ ...value, [Symbol('extra')]: true })).toThrow(
    'Invalid snapshot archive creation request'
  )
  let reads = 0
  Object.defineProperty(value, 'nonce', {
    enumerable: true,
    get: () => {
      reads++
      return 'a'.repeat(64)
    }
  })
  expect(() => parseSnapshotArchiveRequest(value)).toThrow('Invalid snapshot archive creation request')
  expect(reads).toBe(0)
  const hidden = request()
  Object.defineProperty(hidden, 'nonce', { value: hidden.nonce, enumerable: false })
  expect(() => parseSnapshotArchiveRequest(hidden)).toThrow('Invalid snapshot archive creation request')
  const renamed: Record<string, unknown> = { ...request(), replacement: 'a'.repeat(64) }
  delete renamed.nonce
  expect(() => parseSnapshotArchiveRequest(renamed)).toThrow('Invalid snapshot archive creation request')
})

test('a different version cannot reuse the valid version-one digest', () => {
  expect(() => parseSnapshotArchiveRequest({ ...request(), version: 2 })).toThrow(
    'Invalid snapshot archive creation request'
  )
})

test('supports the exact epoch boundary while refusing negative verifier time', () => {
  const value = { ...request(), notAfter: 1 }
  value.requestId = snapshotArchiveRequestId(value)
  expect(validateSnapshotArchiveRequest(value, 0).notAfter).toBe(1)
  expect(() => validateSnapshotArchiveRequest(value, -1)).toThrow('Invalid snapshot archive creation request')
  expect(() => validateSnapshotArchiveRequest(value, 1)).toThrow('Invalid snapshot archive creation request')
})
