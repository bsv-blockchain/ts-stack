import {
  snapshotArchiveDirectoryBytes,
  verifySnapshotArchiveDirectory,
  verifySnapshotArchivePage
} from './SnapshotArchiveDirectory'
import {
  expected,
  fixture,
  hash,
  now,
  rehash,
  sourceStorageIdentityKey
} from '../../../../test/utils/snapshotArchiveDirectoryFixtures'

test.each([null, undefined, 1, 'directory', []])('rejects a non-record directory %p', value => {
  expect(() => verifySnapshotArchiveDirectory(value, expected, now)).toThrow('Invalid snapshot archive directory')
})

test('uses the current clock by default and accepts the exact maximum lifetime', () => {
  const { directory } = fixture()
  directory.expiresAt = now + 3600000
  const clock = jest.spyOn(Date, 'now').mockReturnValue(now)
  try {
    expect(verifySnapshotArchiveDirectory(directory, expected).manifest.expiresAt).toBe(now + 3600000)
  } finally {
    clock.mockRestore()
  }
})

test.each(['not-a-date', '2026-09-30', '2026-09-30T00:00:00+00:00'])('rejects noncanonical source date %s', value => {
  const { directory, binding } = fixture()
  binding.sourceStorage.created_at = value
  directory.bindingJson = JSON.stringify(binding)
  rehash(directory)
  expect(() => verifySnapshotArchiveDirectory(directory, expected, now)).toThrow('Invalid snapshot archive directory')
})

test.each(['version', 'database', 'script-limit', 'user-id', 'schema-size'])('rejects invalid binding %s', variant => {
  const { directory, binding } = fixture()
  if (variant === 'version') binding.version = 2
  if (variant === 'database') binding.sourceStorage.dbtype = 'IndexedDB'
  if (variant === 'script-limit') binding.sourceStorage.maxOutputScript = -1
  if (variant === 'user-id') binding.user.userId = 0
  if (variant === 'schema-size') binding.sourceSchema = 'x'.repeat(257)
  directory.bindingJson = JSON.stringify(binding)
  rehash(directory)
  expect(() => verifySnapshotArchiveDirectory(directory, expected, now)).toThrow('Invalid snapshot archive directory')
})

test('accepts original MySQL metadata with empty permitted labels', () => {
  const { directory, binding } = fixture()
  binding.sourceStorage.dbtype = 'MySQL'
  binding.sourceStorage.storageName = ''
  binding.user.activeStorage = ''
  binding.sourceStorage.maxOutputScript = 0
  directory.bindingJson = JSON.stringify(binding)
  rehash(directory)
  const verified = verifySnapshotArchiveDirectory(directory, expected, now)
  expect(verified.manifest.binding.sourceStorage).toMatchObject({
    dbtype: 'MySQL',
    storageName: '',
    maxOutputScript: 0
  })
  expect(verified.manifest.binding.user.activeStorage).toBe('')
})

test('rejects oversized UTF-8 metadata before its JSON is interpreted', () => {
  const { directory, binding } = fixture()
  binding.sourceStorage.storageName = 'é'.repeat(40000)
  directory.bindingJson = JSON.stringify(binding)
  expect(directory.bindingJson.length).toBeLessThan(65536)
  expect(new TextEncoder().encode(directory.bindingJson).length).toBeGreaterThan(65536)
  rehash(directory)
  expect(() => verifySnapshotArchiveDirectory(directory, expected, now)).toThrow('Invalid snapshot archive directory')
})

test('rejects malformed UTF-16 metadata rather than hashing replacement text', () => {
  const { directory } = fixture()
  directory.bindingJson = directory.bindingJson.replace('Original source', '\ud800')
  rehash(directory)
  expect(() => verifySnapshotArchiveDirectory(directory, expected, now)).toThrow('Invalid snapshot archive directory')
})

test('all declared fields must be own enumerable data', () => {
  const { directory } = fixture()
  const hidden = { ...directory }
  Object.defineProperty(hidden, 'digest', { value: directory.digest, enumerable: false })
  expect(() => verifySnapshotArchiveDirectory(hidden, expected, now)).toThrow('Invalid snapshot archive directory')
  const renamed = { ...directory, replacement: directory.digest } as Record<string, unknown>
  delete renamed.digest
  expect(() => verifySnapshotArchiveDirectory(renamed, expected, now)).toThrow('Invalid snapshot archive directory')
  const symbol = { ...directory, [Symbol('extra')]: true }
  expect(() => verifySnapshotArchiveDirectory(symbol, expected, now)).toThrow('Invalid snapshot archive directory')
})

test('a correctly hashed but incomplete final table remains invalid', () => {
  const { directory } = fixture()
  directory.receipts[12].done = false
  directory.receipts[12].rows = 1
  directory.rows = 1
  rehash(directory)
  expect(() => verifySnapshotArchiveDirectory(directory, expected, now)).toThrow('Invalid snapshot archive directory')
})

test('a correctly hashed additional table remains invalid', () => {
  const { directory } = fixture()
  directory.receipts.push({ ...directory.receipts[12], sequence: 13 })
  directory.pages++
  rehash(directory)
  expect(() => verifySnapshotArchiveDirectory(directory, expected, now)).toThrow('Invalid snapshot archive directory')
})

test('preserves original binding bytes and verifies every table before out-of-order reads', () => {
  const { directory, payloads } = fixture(2)
  const verified = verifySnapshotArchiveDirectory(directory, expected, now)
  expect(verified.bindingJson).toBe(directory.bindingJson)
  expect(verified.manifest.binding.sourceStorage.storageIdentityKey).toBe(sourceStorageIdentityKey)
  expect(verified.manifest.binding.user.activeStorage).toBe('historical-primary')
  expect(verified.tables.provenTxs).toEqual({ first: 0, pages: 3, rows: 2 })
  expect(verified.tables.syncStates).toEqual({ first: 14, pages: 1, rows: 0 })
  for (const index of [14, 0, 7]) {
    const page = { ...directory.receipts[index], bytes: payloads[index] }
    const copied = verifySnapshotArchivePage(page, verified.receipts[index])
    expect(copied).toEqual(payloads[index])
    expect(copied).not.toBe(payloads[index])
  }
})

test('the binding hash uses exact UTF-8 bytes rather than parse/reserialize order', () => {
  const { directory, binding } = fixture()
  directory.bindingJson = JSON.stringify(
    {
      user: binding.user,
      sourceSchema: binding.sourceSchema,
      sourceStorage: binding.sourceStorage,
      snapshotId: binding.snapshotId,
      version: binding.version
    },
    null,
    1
  )
  rehash(directory)
  const verified = verifySnapshotArchiveDirectory(directory, expected, now)
  expect(verified.bindingJson).toBe(directory.bindingJson)
  const compact = { ...directory, bindingJson: JSON.stringify(JSON.parse(directory.bindingJson)) }
  expect(() => verifySnapshotArchiveDirectory(compact, expected, now)).toThrow('Invalid snapshot archive directory')
})

test('caller mutations cannot replace verified receipt or table positions', () => {
  const { directory } = fixture()
  const verified = verifySnapshotArchiveDirectory(directory, expected, now)
  directory.receipts[0].digest = 'f'.repeat(64)
  directory.receipts.reverse()
  expect(verified.receipts[0].table).toBe('provenTxs')
  expect(verified.receipts[0].digest).not.toBe('f'.repeat(64))
  expect(Object.isFrozen(verified)).toBe(true)
  expect(Object.isFrozen(verified.receipts)).toBe(true)
  expect(Object.isFrozen(verified.receipts[0])).toBe(true)
  expect(Object.isFrozen(verified.tables)).toBe(true)
  expect(Object.isFrozen(verified.tables.provenTxs)).toBe(true)
})

test.each([
  ['version', 2],
  ['encoding', 'other'],
  ['archiveId', 'B'.repeat(64)],
  ['expiresAt', now],
  ['expiresAt', now + 3600001],
  ['pages', 12],
  ['pages', 4097],
  ['pages', 13.5],
  ['rows', -1],
  ['rows', Number.MAX_SAFE_INTEGER],
  ['digest', 'z'.repeat(64)],
  ['bindingJson', ''],
  ['receipts', null]
])('rejects invalid directory %s=%s', (key, value) => {
  const { directory } = fixture()
  expect(() => verifySnapshotArchiveDirectory({ ...directory, [key]: value }, expected, now)).toThrow(
    'Invalid snapshot archive directory'
  )
})

test.each([NaN, Infinity, -1, 0.5])('rejects invalid verifier clock %s', clock => {
  expect(() => verifySnapshotArchiveDirectory(fixture().directory, expected, clock)).toThrow(
    'Invalid snapshot archive directory'
  )
})

test.each([
  { identityKey: '03' + '22'.repeat(32) },
  { chain: 'main' as const },
  { sourceStorageIdentityKey: 'replacement' },
  { sourceSchema: 'replacement' },
  { archiveId: 'c'.repeat(64) },
  { digest: 'd'.repeat(64) }
])('rejects changed expected profile/source or resumed binding %p', changed => {
  expect(() => verifySnapshotArchiveDirectory(fixture().directory, { ...expected, ...changed }, now)).toThrow(
    'Invalid snapshot archive directory'
  )
})

test('a resumed handle can require its already-observed root and schema', () => {
  const { directory, binding } = fixture()
  expect(
    verifySnapshotArchiveDirectory(
      directory,
      { ...expected, archiveId: directory.archiveId, digest: directory.digest, sourceSchema: binding.sourceSchema },
      now
    ).manifest.digest
  ).toBe(directory.digest)
})

test.each(['version', 'snapshotId', 'sourceSchema', 'sourceStorage', 'user'])(
  'refuses missing binding field %s',
  key => {
    const { directory, binding } = fixture()
    const copy = { ...binding } as Record<string, unknown>
    delete copy[key]
    directory.bindingJson = JSON.stringify(copy)
    rehash(directory)
    expect(() => verifySnapshotArchiveDirectory(directory, expected, now)).toThrow('Invalid snapshot archive directory')
  }
)

test('rejects extra internal credentials without reading accessor values', () => {
  const { directory } = fixture()
  expect(() => verifySnapshotArchiveDirectory({ ...directory, writerToken: 'internal' }, expected, now)).toThrow(
    'Invalid snapshot archive directory'
  )
  let reads = 0
  const withAccessor = { ...directory }
  Object.defineProperty(withAccessor, 'digest', {
    enumerable: true,
    get: () => {
      reads++
      return directory.digest
    }
  })
  expect(() => verifySnapshotArchiveDirectory(withAccessor, expected, now)).toThrow(
    'Invalid snapshot archive directory'
  )
  expect(reads).toBe(0)
  const receipts = [...directory.receipts]
  Object.defineProperty(receipts, 0, {
    get: () => {
      reads++
      return directory.receipts[0]
    }
  })
  expect(() => verifySnapshotArchiveDirectory({ ...directory, receipts }, expected, now)).toThrow(
    'Invalid snapshot archive directory'
  )
  expect(reads).toBe(0)
})

test.each(['omitted', 'reordered', 'unfinished', 'wrong-table', 'wrong-sequence', 'wrong-total', 'different-root'])(
  'rejects %s receipt chains',
  variant => {
    const { directory } = fixture()
    if (variant === 'omitted') delete directory.receipts[0]
    if (variant === 'reordered') directory.receipts.reverse()
    if (variant === 'unfinished') directory.receipts[0].done = false
    if (variant === 'wrong-table') directory.receipts[0].table = 'outputs'
    if (variant === 'wrong-sequence') directory.receipts[0].sequence = 1
    if (variant === 'wrong-total') directory.rows = 1
    if (variant === 'different-root') directory.receipts[0].digest = 'c'.repeat(64)
    expect(() => verifySnapshotArchiveDirectory(directory, expected, now)).toThrow('Invalid snapshot archive directory')
  }
)

test('the maximum receipt count remains bounded below the transport metadata budget', () => {
  const { directory, binding } = fixture(4096 - 13)
  const base = new TextEncoder().encode(JSON.stringify(binding)).length
  binding.sourceStorage.storageName = '\u0001'.repeat(
    Math.floor((65536 - base + binding.sourceStorage.storageName.length) / 6)
  )
  binding.sourceStorage.storageName += 'x'.repeat(65536 - new TextEncoder().encode(JSON.stringify(binding)).length)
  directory.bindingJson = JSON.stringify(binding)
  expect(new TextEncoder().encode(directory.bindingJson)).toHaveLength(65536)
  rehash(directory)
  const verified = verifySnapshotArchiveDirectory(directory, expected, now)
  expect(verified.receipts).toHaveLength(4096)
  expect(new TextEncoder().encode(JSON.stringify(directory)).length).toBeLessThan(snapshotArchiveDirectoryBytes)
})

test('accepts the exact byte and row limits without changing copied page bytes', () => {
  const { directory } = fixture()
  const bytes = new Uint8Array(1024 * 1024).fill(7)
  directory.receipts[0].digest = hash(bytes)
  directory.receipts[0].rows = 1000
  directory.rows = 1000
  rehash(directory)
  const verified = verifySnapshotArchiveDirectory(directory, expected, now)
  const received = verifySnapshotArchivePage({ ...directory.receipts[0], bytes }, verified.receipts[0])
  expect(received).toHaveLength(1024 * 1024)
  expect(hash(received)).toBe(hash(bytes))
  expect(verified.tables.provenTxs.rows).toBe(1000)
})

test.each(['metadata', 'bytes', 'digest', 'extra', 'empty', 'oversized'])(
  'rejects %s page substitution against the verified receipt',
  variant => {
    const { directory, payloads } = fixture()
    const verified = verifySnapshotArchiveDirectory(directory, expected, now)
    const page: Record<string, unknown> = { ...directory.receipts[0], bytes: payloads[0] }
    if (variant === 'metadata') page.table = 'outputs'
    if (variant === 'bytes') page.bytes = payloads[1]
    if (variant === 'digest') page.digest = 'c'.repeat(64)
    if (variant === 'extra') page.writerToken = 'internal'
    if (variant === 'empty') page.bytes = new Uint8Array()
    if (variant === 'oversized') page.bytes = new Uint8Array(1024 * 1024 + 1)
    expect(() => verifySnapshotArchivePage(page, verified.receipts[0])).toThrow('Invalid snapshot archive directory')
  }
)

test.each([0, null, { length: 12 }, ''])('refuses a non-text or empty source schema %p', value => {
  const { directory, binding } = fixture()
  directory.bindingJson = JSON.stringify({ ...binding, sourceSchema: value })
  rehash(directory)
  expect(() => verifySnapshotArchiveDirectory(directory, expected, now)).toThrow('Invalid snapshot archive directory')
})

test.each(['count', 'array-like', 'done-type', 'empty-continuation'])(
  'refuses correctly hashed invalid receipt structure %s',
  variant => {
    const { directory } = fixture(1)
    if (variant === 'count') directory.receipts.push({ ...directory.receipts[13], sequence: 14 })
    if (variant === 'done-type') Object.assign(directory.receipts[0], { done: 0 })
    if (variant === 'empty-continuation') {
      directory.receipts[0].rows = 0
      directory.rows = 0
    }
    rehash(directory)
    const input =
      variant === 'array-like'
        ? { ...directory, receipts: { ...directory.receipts, length: directory.pages } }
        : directory
    expect(() => verifySnapshotArchiveDirectory(input, expected, now)).toThrow('Invalid snapshot archive directory')
  }
)

test.each(['sequence', 'rows', 'done'])('refuses changed page %s even when its payload digest is correct', field => {
  const { directory, payloads } = fixture()
  const verified = verifySnapshotArchiveDirectory(directory, expected, now)
  const page = { ...directory.receipts[0], bytes: payloads[0] }
  const changed = field === 'done' ? false : 1
  expect(() => verifySnapshotArchivePage({ ...page, [field]: changed }, verified.receipts[0])).toThrow(
    'Invalid snapshot archive directory'
  )
})

test.each(['array', 'array-like', 'empty', 'oversized'])(
  'requires bounded typed page bytes with a matching digest: %s',
  variant => {
    const bytes =
      variant === 'empty' ? new Uint8Array() : new Uint8Array(variant === 'oversized' ? 1024 * 1024 + 1 : 1).fill(9)
    const { directory } = fixture()
    directory.receipts[0].digest = hash(bytes)
    rehash(directory)
    const verified = verifySnapshotArchiveDirectory(directory, expected, now)
    const input = variant === 'array' ? Array.from(bytes) : variant === 'array-like' ? { 0: 9, length: 1 } : bytes
    expect(() => verifySnapshotArchivePage({ ...directory.receipts[0], bytes: input }, verified.receipts[0])).toThrow(
      'Invalid snapshot archive directory'
    )
  }
)

test('accepts one byte with the digest bound into the directory', () => {
  const bytes = Uint8Array.of(9)
  const { directory } = fixture()
  directory.receipts[0].digest = hash(bytes)
  rehash(directory)
  const verified = verifySnapshotArchiveDirectory(directory, expected, now)
  expect(verifySnapshotArchivePage({ ...directory.receipts[0], bytes }, verified.receipts[0])).toEqual(bytes)
})
