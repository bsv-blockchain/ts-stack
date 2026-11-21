import { runInNewContext } from 'node:vm'
import { createHash } from 'node:crypto'
import {
  createSnapshotSyncContentRevision,
  assertSnapshotSyncContentPositionNotFuture,
  createSnapshotSyncClockContentRevision,
  snapshotSyncContentConfirms,
  parseSnapshotSyncContentRevision,
  parseSnapshotSyncContentPosition,
  snapshotSyncContentPosition,
  sameSnapshotSyncContentRevision
} from './SnapshotSyncContentRevision'

const fixture = () => ({
  binding: '11'.repeat(32),
  floor: '0',
  highWater: '9223372036854775807',
  revisions: Array.from({ length: 15 }, (_, index) => String(index)),
  sourceStorage: {
    storageIdentityKey: 'source-storage',
    storageName: 'source',
    chain: 'test' as const,
    dbtype: 'SQLite' as const,
    maxOutputScript: 100000,
    created_at: new Date('2020-01-01T00:00:00.000Z'),
    updated_at: new Date('2020-01-02T00:00:00.000Z')
  },
  user: {
    userId: 1,
    identityKey: '02' + '22'.repeat(32),
    activeStorage: 'source-storage',
    created_at: new Date('2020-01-03T00:00:00.000Z'),
    updated_at: new Date('2020-01-04T00:00:00.000Z')
  },
  primaryEpoch: '9007199254740993'
})

test('content revision has an independent bounded encoding and retains exact signed64 metadata', () => {
  const input = fixture()
  input.revisions[14] = '9007199254740993'
  const metadata = [
    'source-storage',
    'source',
    'test',
    'SQLite',
    100000,
    '2020-01-01T00:00:00.000Z',
    '2020-01-02T00:00:00.000Z',
    1,
    '02' + '22'.repeat(32),
    '2020-01-03T00:00:00.000Z',
    '2020-01-04T00:00:00.000Z',
    'source-storage',
    '9007199254740993'
  ]
  const content = createHash('sha256')
    .update('snapshot-sync-content-revision-v1\n' + JSON.stringify([input.binding, '0', input.revisions, metadata]))
    .digest('hex')
  const metadataDigest = createHash('sha256')
    .update('snapshot-sync-content-metadata-v1\n' + JSON.stringify([input.binding, metadata]))
    .digest('hex')
  expect(createSnapshotSyncContentRevision(input)).toEqual({
    version: 1,
    binding: input.binding,
    content,
    metadata: metadataDigest,
    highWater: input.highWater,
    floor: '0'
  })
  expect(JSON.stringify(createSnapshotSyncContentRevision(input)).length).toBe(291)
})

test('capture-only clock advances do not change content while floor and every stream remain bound', () => {
  const input = fixture(),
    original = createSnapshotSyncContentRevision({ ...input, highWater: '100' })
  expect(
    sameSnapshotSyncContentRevision(original, createSnapshotSyncContentRevision({ ...input, highWater: '101' }))
  ).toBe(true)
  expect(sameSnapshotSyncContentRevision(original, createSnapshotSyncContentRevision({ ...input, floor: '1' }))).toBe(
    false
  )
  for (let index = 0; index < 15; index++) {
    const revisions = [...input.revisions]
    revisions[index] = '99'
    expect(sameSnapshotSyncContentRevision(original, createSnapshotSyncContentRevision({ ...input, revisions }))).toBe(
      false
    )
  }
})

test('profile, storage, primary and source metadata changes cannot reuse content comparison data', () => {
  const input = fixture(),
    original = createSnapshotSyncContentRevision(input)
  const changes = [
    { ...input, binding: '33'.repeat(32) },
    { ...input, primaryEpoch: '9007199254740994' },
    { ...input, user: { ...input.user, userId: 2 } },
    { ...input, user: { ...input.user, identityKey: '03' + '22'.repeat(32) } },
    { ...input, user: { ...input.user, activeStorage: 'other-storage' } },
    { ...input, user: { ...input.user, updated_at: new Date('2021-01-04T00:00:00.000Z') } },
    { ...input, sourceStorage: { ...input.sourceStorage, storageIdentityKey: 'other-storage' } },
    { ...input, sourceStorage: { ...input.sourceStorage, storageName: 'renamed' } },
    { ...input, sourceStorage: { ...input.sourceStorage, chain: 'main' as const } },
    { ...input, sourceStorage: { ...input.sourceStorage, maxOutputScript: 100001 } }
  ]
  for (const changed of changes)
    expect(sameSnapshotSyncContentRevision(original, createSnapshotSyncContentRevision(changed))).toBe(false)
})

test.each(['-1', '01', '1.0', '9223372036854775808', '1e9', '', ' 1'])('invalid revision %j is refused', value => {
  const input = fixture()
  expect(() => createSnapshotSyncContentRevision({ ...input, floor: value })).toThrow()
  expect(() => createSnapshotSyncContentRevision({ ...input, highWater: value })).toThrow()
  expect(() => createSnapshotSyncContentRevision({ ...input, primaryEpoch: value })).toThrow()
  input.revisions[0] = value
  expect(() => createSnapshotSyncContentRevision(input)).toThrow()
})

test('invalid interval, incomplete stream inventory and accessor data cannot produce a revision', () => {
  const input = fixture(),
    getter = jest.fn(() => '1')
  expect(() => createSnapshotSyncContentRevision({ ...input, floor: '2', highWater: '1' })).toThrow()
  expect(() => createSnapshotSyncContentRevision({ ...input, highWater: '1' })).toThrow()
  expect(() => createSnapshotSyncContentRevision({ ...input, revisions: input.revisions.slice(1) })).toThrow()
  Object.defineProperty(input.revisions, '0', { enumerable: true, get: getter })
  expect(() => createSnapshotSyncContentRevision(input)).toThrow()
  expect(getter).not.toHaveBeenCalled()
})

test('wire/storage parsing detaches exact data and refuses unbounded, extra or accessor values', () => {
  const value = createSnapshotSyncContentRevision(fixture()),
    wire = { ...value },
    copied = parseSnapshotSyncContentRevision(wire)
  wire.content = '44'.repeat(32)
  expect(copied).toEqual(value)
  expect(Object.isFrozen(copied)).toBe(true)
  const getter = jest.fn(() => value.content),
    accessor = Object.defineProperty({ ...value }, 'content', {
      enumerable: true,
      get: getter
    })
  for (const invalid of [
    null,
    [],
    { ...value, extra: true },
    { ...value, version: 2 },
    { ...value, content: 'a'.repeat(65) },
    accessor
  ])
    expect(() => parseSnapshotSyncContentRevision(invalid)).toThrow()
  expect(getter).not.toHaveBeenCalled()
})

test('confirmation positions are detached DATA and retain metadata and exact event bounds', () => {
  const state = createSnapshotSyncContentRevision(fixture()),
    position = snapshotSyncContentPosition(state)
  expect(position).toEqual({ version: 1, binding: state.binding, metadata: state.metadata, highWater: state.highWater })
  expect(Object.isFrozen(position)).toBe(true)
  expect(parseSnapshotSyncContentPosition(position)).toEqual(position)
  expect(() => parseSnapshotSyncContentPosition({ ...position, highWater: '01' })).toThrow()
  expect(() => parseSnapshotSyncContentPosition({ ...position, extra: true })).toThrow()
  expect(() => parseSnapshotSyncContentRevision({ ...state, unchangedSince: '-1' })).toThrow()
  expect(() => parseSnapshotSyncContentRevision({ ...state, floor: '2', unchangedSince: '1' })).toThrow()
  expect(() => parseSnapshotSyncContentRevision({ ...state, highWater: '100', unchangedSince: '101' })).toThrow()
})

test('an actual monotone MVCC clock has an independent hash domain and exact data position', () => {
  const input = fixture(),
    metadata = [
      'source-storage',
      'source',
      'test',
      'SQLite',
      100000,
      '2020-01-01T00:00:00.000Z',
      '2020-01-02T00:00:00.000Z',
      1,
      '02' + '22'.repeat(32),
      '2020-01-03T00:00:00.000Z',
      '2020-01-04T00:00:00.000Z',
      'source-storage',
      '9007199254740993'
    ]
  const expected = createHash('sha256')
    .update('snapshot-sync-mvcc-content-revision-v1\n' + JSON.stringify([input.binding, input.highWater, metadata]))
    .digest('hex')
  const actual = createSnapshotSyncClockContentRevision(input)
  expect(actual.content).toBe(expected)
  expect(actual.highWater).toBe('9223372036854775807')
  expect(actual.floor).toBe('0')
  expect(actual.content).not.toBe(createSnapshotSyncContentRevision(input).content)
  expect(snapshotSyncContentConfirms(actual, actual)).toBe(true)
  expect(
    snapshotSyncContentConfirms(
      actual,
      createSnapshotSyncClockContentRevision({ ...input, highWater: '9223372036854775806' })
    )
  ).toBe(false)
  expect(snapshotSyncContentConfirms(actual, { ...actual, metadata: 'ff'.repeat(32) })).toBe(false)
})

test('genuine cross-realm Date metadata is retained while Date impostors cannot invoke getters', () => {
  const input = fixture(),
    original = createSnapshotSyncContentRevision(input)
  input.sourceStorage.created_at = runInNewContext("new Date('2020-01-01T00:00:00.000Z')")
  expect(createSnapshotSyncContentRevision(input)).toEqual(original)
  const getter = jest.fn(() => Date.now())
  input.sourceStorage.created_at = Object.defineProperty({}, 'getTime', { get: getter }) as Date
  expect(() => createSnapshotSyncContentRevision(input)).toThrow()
  expect(getter).not.toHaveBeenCalled()
})

test('metadata-only comparison retains empty names/selections and safe declared script sizes without allocating payloads', () => {
  const input = fixture()
  input.sourceStorage.storageName = ''
  input.sourceStorage.maxOutputScript = Number.MAX_SAFE_INTEGER
  input.user.activeStorage = ''
  expect(createSnapshotSyncContentRevision(input)).toMatchObject({ version: 1, highWater: input.highWater })
})

test('matching content positions cannot jump beyond the actual observed high-water', () => {
  const current = createSnapshotSyncContentRevision({ ...fixture(), highWater: '100' })
  expect(() =>
    assertSnapshotSyncContentPositionNotFuture({ ...snapshotSyncContentPosition(current), highWater: '101' }, current)
  ).toThrow('actual source high-water')
  expect(() => assertSnapshotSyncContentPositionNotFuture(snapshotSyncContentPosition(current), current)).not.toThrow()
})
