import { snapshotArchiveLimits } from './SnapshotArchive'
import { snapshotArchiveReaderRequestId } from './SnapshotArchiveReaderRequest'
import { validateSnapshotArchiveReaderOffer, validateSnapshotArchiveReaderOptions } from './SnapshotArchiveReaderOffer'

const options = { lifetimeMs: 300000, maxBytes: 32768 }
const storage = 'original-storage'
function fixture() {
  const fields = { version: 2 as const, nonce: 'a'.repeat(64), notAfter: 1300000, maxBytes: 32768 }
  return {
    version: 1,
    outcome: 'offered',
    offer: {
      version: 1,
      serverTime: 1000000,
      sourceStorageIdentityKey: storage,
      sourceSchema: 'original-schema',
      chain: 'test'
    },
    request: { ...fields, requestId: snapshotArchiveReaderRequestId(fields) }
  }
}
const parse = (value: unknown) => validateSnapshotArchiveReaderOffer(value, options, storage, 'test')

test('reader offer retains exactly the authenticated options, source and immutable request', () => {
  const input = fixture()
  const output = parse(input)
  expect(output).toEqual(input)
  expect(output).not.toBe(input)
  if (output.outcome !== 'offered') throw new Error('Expected offered fixture')
  expect(output.request).not.toBe(input.request)
  expect(output.offer).not.toBe(input.offer)
  input.offer.sourceSchema = 'later caller mutation'
  input.request.nonce = 'b'.repeat(64)
  expect(output.offer.sourceSchema).toBe('original-schema')
  expect(output.request.nonce).toBe('a'.repeat(64))
  expect(Object.isFrozen(output)).toBe(true)
  expect(Object.isFrozen(output.offer)).toBe(true)
  expect(Object.isFrozen(output.request)).toBe(true)
  expect(parse({ version: 1, outcome: 'resource-limited' })).toEqual({ version: 1, outcome: 'resource-limited' })
})

test('a refusal carries no request that could have been admitted', () => {
  for (const name of ['request', 'offer', 'requestId', 'expiresAt', 'claimToken']) {
    expect(() => parse({ version: 1, outcome: 'resource-limited', [name]: fixture().request })).toThrow(
      'Invalid snapshot archive reader offer'
    )
  }
  for (const outcome of ['accepted', 'building', 'ready', undefined, null, 1]) {
    expect(() => parse({ version: 1, outcome })).toThrow('Invalid snapshot archive reader offer')
  }
})

test('offer framing rejects altered versions, hidden fields and accessors without evaluating them', () => {
  for (const input of [null, [], 'offered', 1, {}, { ...fixture(), version: 2 }, { ...fixture(), extra: true }]) {
    expect(() => parse(input)).toThrow('Invalid snapshot archive reader offer')
  }
  for (const name of ['version', 'outcome', 'offer', 'request']) {
    const getter = jest.fn(() => {
      throw new Error('must not evaluate property')
    })
    const input = fixture()
    Object.defineProperty(input, name, { get: getter, enumerable: true })
    expect(() => parse(input)).toThrow('Invalid snapshot archive reader offer')
    expect(getter).not.toHaveBeenCalled()
    const hidden = fixture()
    Object.defineProperty(hidden, name, { value: hidden[name as keyof typeof hidden], enumerable: false })
    expect(() => parse(hidden)).toThrow('Invalid snapshot archive reader offer')
    const missing = { ...fixture() } as Record<string, unknown>
    delete missing[name]
    expect(() => parse(missing)).toThrow('Invalid snapshot archive reader offer')
  }
  const symbol = fixture()
  Object.defineProperty(symbol, Symbol('extra'), { value: true })
  expect(() => parse(symbol)).toThrow('Invalid snapshot archive reader offer')
})

test('valid request hashes cannot change negotiated time, budget, source schema shape or chain', () => {
  for (const change of [{ notAfter: 1300001 }, { notAfter: 1299999 }, { maxBytes: 32769 }, { maxBytes: 32767 }]) {
    const input = fixture()
    Object.assign(input.request, change)
    input.request.requestId = snapshotArchiveReaderRequestId(input.request)
    expect(() => parse(input)).toThrow()
  }
  for (const change of [
    { serverTime: 999999 },
    { sourceStorageIdentityKey: 'substituted' },
    { sourceSchema: '' },
    { chain: 'main' }
  ]) {
    const input = fixture()
    Object.assign(input.offer, change)
    expect(() => parse(input)).toThrow()
  }
  const changedHash = fixture()
  changedHash.request.requestId = 'b'.repeat(64)
  expect(() => parse(changedHash)).toThrow()
})

test('reader options admit exact integer bounds and reject unbounded or getter-backed input', () => {
  const minimum = { lifetimeMs: 1, maxBytes: snapshotArchiveLimits.headerCharge + 1 }
  const maximum = { lifetimeMs: snapshotArchiveLimits.lifetimeMs, maxBytes: snapshotArchiveLimits.archiveBytes }
  expect(validateSnapshotArchiveReaderOptions(minimum)).toEqual(minimum)
  expect(validateSnapshotArchiveReaderOptions(maximum)).toEqual(maximum)
  for (const lifetimeMs of [0, -1, 1.5, Number.NaN, Infinity, snapshotArchiveLimits.lifetimeMs + 1, '1']) {
    expect(() => validateSnapshotArchiveReaderOptions({ ...options, lifetimeMs })).toThrow(
      'Invalid snapshot archive reader request'
    )
  }
  for (const maxBytes of [
    snapshotArchiveLimits.headerCharge,
    snapshotArchiveLimits.archiveBytes + 1,
    1.5,
    Number.NaN,
    Infinity,
    '32768'
  ]) {
    expect(() => validateSnapshotArchiveReaderOptions({ ...options, maxBytes })).toThrow(
      'Invalid snapshot archive reader request'
    )
  }
  for (const input of [null, [], {}, { lifetimeMs: 1 }, { maxBytes: 32768 }, { ...options, extra: true }]) {
    expect(() => validateSnapshotArchiveReaderOptions(input)).toThrow('Invalid snapshot archive reader request')
  }
  const getter = jest.fn(() => 1)
  expect(() =>
    validateSnapshotArchiveReaderOptions(Object.defineProperty({ ...options }, 'lifetimeMs', { get: getter }))
  ).toThrow('Invalid snapshot archive reader request')
  expect(getter).not.toHaveBeenCalled()
})
