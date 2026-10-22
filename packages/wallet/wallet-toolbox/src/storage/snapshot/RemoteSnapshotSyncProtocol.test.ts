import { encodeSyncTransfer } from '../remoting/SyncTransfer'
import {
  parseRemoteSnapshotSyncSource,
  parseRemoteSnapshotSyncCheckpoint,
  parseRemoteSnapshotSyncPage,
  parseRemoteSnapshotSyncCommit,
  parseRemoteSnapshotSyncStagedPage,
  parseRemoteSnapshotSyncTransfer,
  remoteSnapshotStorageKey,
  remoteSnapshotSyncCapabilities,
  remoteSnapshotSyncFrameBytes,
  validateRemoteSnapshotSyncCapabilities
} from './RemoteSnapshotSyncProtocol'
import type { SnapshotSyncCheckpoint } from './SnapshotSync'
import type { Chain } from '../../sdk/types'

// Synthetic wire DATA for parser boundaries, never an authenticated transport,
// retained source issuer or platform qualification result.
const identity = '02' + '11'.repeat(32)
const time = '2026-10-06T00:00:00.000Z'

test.each<Chain>(['main', 'test', 'stn', 'ttn', 'tstn', 'regtest', 'mock'])(
  'operational destination source admission binds the declared %s chain',
  chain => {
    const input = source()
    input.sourceStorage.chain = chain
    expect(parseRemoteSnapshotSyncSource(input, identity, chain).sourceStorage.chain).toBe(chain)
    expect(() => parseRemoteSnapshotSyncSource(input, identity, chain === 'main' ? 'test' : 'main')).toThrow()
    input.sourceStorage.chain = 'unknown'
    expect(() => parseRemoteSnapshotSyncSource(input, identity, 'unknown' as Chain)).toThrow()
  }
)
function source() {
  return {
    version: 1,
    snapshotId: 'a'.repeat(64),
    expiresAt: Date.now() + 60000,
    sourceStorage: {
      storageIdentityKey: 'source',
      storageName: 'source',
      chain: 'test',
      dbtype: 'SQLite',
      maxOutputScript: 1024,
      created_at: time,
      updated_at: time
    },
    user: { userId: 7, identityKey: identity, created_at: time, updated_at: time, activeStorage: 'source' }
  }
}
function checkpoint(): SnapshotSyncCheckpoint {
  return {
    version: 1,
    sessionId: 'b'.repeat(64),
    snapshotId: 'a'.repeat(64),
    identityKey: identity,
    sourceStorageIdentityKey: 'source',
    destinationStorageIdentityKey: 'destination',
    tableIndex: 3,
    sequence: 3,
    done: false
  }
}
function page() {
  return {
    rows: [{ created_at: time, updated_at: time, txLabelId: 9, userId: 7, label: 'kept', isDeleted: true }],
    payloadBytes: 512,
    done: true,
    cursor: { version: 1, snapshotId: 'a'.repeat(64), table: 'txLabels', after: [9] }
  }
}

test('negotiated ceilings are exact, detached and reject accessors without invoking them', () => {
  expect(validateRemoteSnapshotSyncCapabilities({ ...remoteSnapshotSyncCapabilities })).toBe(
    remoteSnapshotSyncCapabilities
  )
  const getter = jest.fn(() => 1),
    value = { ...remoteSnapshotSyncCapabilities }
  Object.defineProperty(value, 'version', { get: getter, enumerable: true })
  expect(() => validateRemoteSnapshotSyncCapabilities(value)).toThrow()
  expect(getter).not.toHaveBeenCalled()
  expect(() => validateRemoteSnapshotSyncCapabilities({ ...remoteSnapshotSyncCapabilities, extra: true })).toThrow()
  expect(() => validateRemoteSnapshotSyncCapabilities({ ...remoteSnapshotSyncCapabilities, maxRows: 129 })).toThrow()
})

test('closed protocol dictionaries reject reserved and inherited fields without changing input or prototypes', () => {
  const before = Object.getOwnPropertyDescriptors(Object.prototype)
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const value = Object.fromEntries([...Object.entries(remoteSnapshotSyncCapabilities), [key, null]])
    const original = Object.getOwnPropertyDescriptors(value)
    expect(() => validateRemoteSnapshotSyncCapabilities(value)).toThrow()
    expect(Object.getOwnPropertyDescriptors(value)).toEqual(original)
  }
  const inherited = Object.create({ version: 1 })
  for (const key of ['maxRows', 'maxBytes', 'maxIoMs'] as const) inherited[key] = remoteSnapshotSyncCapabilities[key]
  expect(() => validateRemoteSnapshotSyncCapabilities(inherited)).toThrow()
  expect(validateRemoteSnapshotSyncCapabilities(Object.freeze({ ...remoteSnapshotSyncCapabilities }))).toBe(
    remoteSnapshotSyncCapabilities
  )
  expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(before)
})

test.each(['', 'a'.repeat(131), 'source\u0000', 'source\u007f', 'source\u0085'])(
  'storage identifiers reject controls and schema overflow',
  key => {
    expect(() => remoteSnapshotStorageKey(key)).toThrow()
  }
)

test('source admission keeps exact dates and original profile data detached', () => {
  const input = source(),
    accepted = parseRemoteSnapshotSyncSource(input, identity, 'test')
  input.user.userId = 99
  input.sourceStorage.storageName = 'changed'
  expect(accepted.user.userId).toBe(7)
  expect(accepted.sourceStorage.storageName).toBe('source')
  expect(accepted.user.created_at.toISOString()).toBe(time)
  expect(accepted.user.activeStorage).toBe('source')
})

test.each(['identity', 'network', 'expired', 'extended', 'date', 'schema', 'extra'] as const)(
  'source refuses %s',
  changed => {
    const input = source()
    if (changed === 'identity') input.user.identityKey = '03' + '22'.repeat(32)
    if (changed === 'network') input.sourceStorage.chain = 'main'
    if (changed === 'expired') input.expiresAt = Date.now() - 1
    if (changed === 'extended') input.expiresAt = Date.now() + 3601000
    if (changed === 'date') input.user.created_at = '2026-10-06'
    if (changed === 'schema') input.version = 2
    if (changed === 'extra') Object.assign(input, { complete: true })
    expect(() => parseRemoteSnapshotSyncSource(input, identity, 'test')).toThrow()
  }
)

test('checkpoint terminal state and cursor bind to their exact original view', () => {
  const original = checkpoint()
  expect(parseRemoteSnapshotSyncCheckpoint(original, original)).toEqual(original)
  expect(() => parseRemoteSnapshotSyncCheckpoint({ ...original, tableIndex: 12 }, original)).toThrow()
  expect(() => parseRemoteSnapshotSyncCheckpoint({ ...original, done: true }, original)).toThrow()
  expect(() =>
    parseRemoteSnapshotSyncCheckpoint(
      { ...original, cursor: { version: 1, snapshotId: 'c'.repeat(64), table: 'txLabels', after: [9] } },
      original
    )
  ).toThrow()
  expect(() =>
    parseRemoteSnapshotSyncCheckpoint({ ...original, destinationStorageIdentityKey: 'foreign' }, original)
  ).toThrow()
})

test('full rows retain tombstones and reject another profile before merge preparation', () => {
  const input = page(),
    original = checkpoint()
  const accepted = parseRemoteSnapshotSyncPage(encodeSyncTransfer(input), original, 7)
  expect(accepted.rows[0]).toMatchObject({ userId: 7, label: 'kept', isDeleted: true, created_at: new Date(time) })
  input.rows[0].userId = 8
  expect(() => parseRemoteSnapshotSyncPage(encodeSyncTransfer(input), original, 7)).toThrow()
})

test.each(['frame', 'rows', 'charge', 'cursor', 'empty-progress', 'column'] as const)(
  'bounded page refuses %s',
  changed => {
    const input = page(),
      original = checkpoint()
    if (changed === 'frame') {
      expect(() => parseRemoteSnapshotSyncPage(new Uint8Array(remoteSnapshotSyncFrameBytes + 1), original, 7)).toThrow()
      return
    }
    if (changed === 'rows') input.rows = Array.from({ length: 129 }, () => ({ ...input.rows[0] }))
    if (changed === 'charge') input.payloadBytes = 1
    if (changed === 'cursor') input.cursor.after = [10]
    if (changed === 'empty-progress') {
      input.rows = []
      input.done = false
    }
    if (changed === 'column') Object.assign(input.rows[0], { authority: true })
    expect(() => parseRemoteSnapshotSyncPage(encodeSyncTransfer(input), original, 7)).toThrow()
  }
)

test.each(['session', 'view', 'sequence', 'table', 'count'] as const)(
  'commit acknowledgement refuses changed %s',
  changed => {
    const previous = checkpoint(),
      next = { ...previous, tableIndex: 4, sequence: 4 }
    const result = { checkpoint: next, inserts: 1, updates: 0 }
    if (changed === 'session') next.sessionId = 'c'.repeat(64)
    if (changed === 'view') next.snapshotId = 'c'.repeat(64)
    if (changed === 'sequence') next.sequence = 5
    if (changed === 'table') next.tableIndex = 5
    if (changed === 'count') result.inserts = -1
    expect(() => parseRemoteSnapshotSyncCommit(result, previous)).toThrow()
  }
)

test('staged page bytes bind the complete original checkpoint before any merge', () => {
  const original = checkpoint()
  expect(
    parseRemoteSnapshotSyncStagedPage(encodeSyncTransfer({ checkpoint: original, page: page() }), original, 7).rows
  ).toHaveLength(1)
  expect(() =>
    parseRemoteSnapshotSyncStagedPage(
      encodeSyncTransfer({ checkpoint: { ...original, sequence: 4 }, page: page() }),
      original,
      7
    )
  ).toThrow()
})

test('part parser detaches bounded raw bytes and refuses undeclared fields', () => {
  const bytes = new Uint8Array([7]),
    input = { transferId: 'c'.repeat(64), offset: 0, bytes }
  const detached = parseRemoteSnapshotSyncTransfer(input, 'writeSnapshotSyncPageTransferPart')
  bytes[0] = 9
  expect(detached.bytes).toEqual(new Uint8Array([7]))
  expect(() =>
    parseRemoteSnapshotSyncTransfer({ ...input, bytes: new Uint8Array(262145) }, 'writeSnapshotSyncPageTransferPart')
  ).toThrow()
  expect(() =>
    parseRemoteSnapshotSyncTransfer({ ...input, owner: identity }, 'writeSnapshotSyncPageTransferPart')
  ).toThrow()
})
