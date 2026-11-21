import { snapshotSyncScalarChunk } from './SnapshotSyncScalarFields'
import type { SnapshotSyncCheckpoint } from './SnapshotSync'
import type { DetachedSnapshotSyncFieldRow } from './SnapshotSyncFieldRows'

const dates = { created_at: new Date('2026-01-01'), updated_at: new Date('2026-02-01') },
  cp: SnapshotSyncCheckpoint = {
    version: 1,
    snapshotId: 'aa'.repeat(32),
    sessionId: 'bb'.repeat(32),
    identityKey: '02' + '11'.repeat(32),
    sourceStorageIdentityKey: 'source',
    destinationStorageIdentityKey: 'target',
    sequence: 1,
    tableIndex: 1,
    done: false
  }
function row(fields: Readonly<Record<string, unknown>>): DetachedSnapshotSyncFieldRow {
  return { fields, extents: {}, cursor: { version: 1, snapshotId: cp.snapshotId, table: 'outputBaskets', after: [27] } }
}

test('complete scalar tables retain original values, tombstones and dates without placeholder payloads', () => {
  const fields = {
      ...dates,
      basketId: 27,
      userId: 77,
      name: 'ordinary',
      isDeleted: true,
      numberOfDesiredUTXOs: 8,
      minimumDesiredUTXOValue: 1
    },
    chunk = snapshotSyncScalarChunk(cp, [row(fields)])
  expect(chunk.outputBaskets).toEqual([fields])
  expect(chunk.outputBaskets![0].updated_at).not.toBe(fields.updated_at)
  expect(Object.keys(chunk).sort()).toEqual([
    'fromStorageIdentityKey',
    'outputBaskets',
    'toStorageIdentityKey',
    'userIdentityKey'
  ])
})

test.each(['missing', 'wrong type', 'extra', 'payload', 'wrong table'])(
  'partial or non-scalar metadata refuses %s before provider admission',
  failure => {
    const fields: Record<string, unknown> = {
        ...dates,
        basketId: 27,
        userId: 77,
        name: 'ordinary',
        isDeleted: true,
        numberOfDesiredUTXOs: 8,
        minimumDesiredUTXOValue: 1
      },
      selected = row(fields)
    if (failure === 'missing') delete fields.minimumDesiredUTXOValue
    if (failure === 'wrong type') fields.isDeleted = 1
    if (failure === 'extra') fields.unrelated = 'extra'
    if (failure === 'payload') Reflect.set(selected, 'extents', { name: { kind: 'utf16le', bytes: 2 } })
    expect(() =>
      snapshotSyncScalarChunk(failure === 'wrong table' ? { ...cp, tableIndex: 4 } : cp, [selected])
    ).toThrow('complete')
  }
)
