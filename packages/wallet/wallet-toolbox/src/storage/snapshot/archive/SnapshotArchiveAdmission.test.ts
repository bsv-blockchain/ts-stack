import { validateSnapshotArchiveAdmission, SnapshotArchiveAdmissionLimitError } from './SnapshotArchiveAdmission'
import { snapshotArchiveRequestId } from './SnapshotArchiveRequest'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'

const fields = { version: 1 as const, nonce: 'a'.repeat(64), notAfter: 1790812800000, maxBytes: 32768 }
const request = { ...fields, requestId: snapshotArchiveRequestId(fields) }
const receipt = { version: 1, requestId: request.requestId, expiresAt: request.notAfter, state: 'building' }
const refused = { version: 1, outcome: 'resource-limited', requestId: request.requestId, expiresAt: request.notAfter }

test('accepted and transient refused outcomes are distinct, detached and immutable', () => {
  const accepted = validateSnapshotArchiveAdmission({ version: 1, outcome: 'accepted', receipt }, request)
  expect(accepted).toEqual({ version: 1, outcome: 'accepted', receipt })
  expect(Object.isFrozen(accepted)).toBe(true)
  if (accepted.outcome !== 'accepted') throw new Error('Expected accepted fixture')
  expect(accepted.receipt).not.toBe(receipt)
  expect(Object.isFrozen(accepted.receipt)).toBe(true)
  const result = validateSnapshotArchiveAdmission(refused, request)
  expect(result).toEqual(refused)
  expect(result).not.toBe(refused)
  expect(Object.isFrozen(result)).toBe(true)
  expect(result).not.toHaveProperty('receipt')
  expect(new SnapshotArchiveAdmissionLimitError('occupied')).toBeInstanceOf(SnapshotResourceLimitError)
})

test.each([null, undefined, [], true, 1, 'accepted'])('rejects non-record admission %p', value => {
  expect(() => validateSnapshotArchiveAdmission(value, request)).toThrow('Invalid snapshot archive admission')
})

test.each([
  { version: 2 },
  { outcome: 'ready' },
  { requestId: 'b'.repeat(64) },
  { expiresAt: request.notAfter + 1 },
  { receipt },
  { claimToken: 'unwanted' },
  { [Symbol('extra')]: true }
])('refusal binds exactly to the original request and field set %p', fields => {
  expect(() => validateSnapshotArchiveAdmission({ ...refused, ...fields }, request)).toThrow(
    'Invalid snapshot archive admission'
  )
})

test('own enumerable data fields are required without invoking getters', () => {
  for (const name of Object.keys(refused)) {
    const missing = { ...refused } as Record<string, unknown>
    delete missing[name]
    expect(() => validateSnapshotArchiveAdmission(missing, request)).toThrow(
      'Invalid snapshot archive admission outcome'
    )
    Object.defineProperty(missing, name, { value: Reflect.get(refused, name), configurable: true })
    expect(() => validateSnapshotArchiveAdmission(missing, request)).toThrow(
      'Invalid snapshot archive admission outcome'
    )
    Object.defineProperty(missing, name, {
      get: () => {
        throw new Error('Getter must not run')
      },
      enumerable: true
    })
    expect(() => validateSnapshotArchiveAdmission(missing, request)).toThrow('Invalid snapshot archive admission')
  }
  expect(() => validateSnapshotArchiveAdmission(Object.create(refused), request)).toThrow(
    'Invalid snapshot archive admission outcome'
  )
  expect(() =>
    validateSnapshotArchiveAdmission(
      { version: 1, outcome: 'accepted', receipt: { ...receipt, expiresAt: 1 } },
      request
    )
  ).toThrow('Invalid snapshot archive protocol')
})

test.each([null, undefined, true, 1, 'request', {}])('an admission cannot bind to invalid request %p', value => {
  expect(() => validateSnapshotArchiveAdmission(refused, value as unknown as typeof request)).toThrow(
    'Invalid snapshot archive creation request'
  )
})
