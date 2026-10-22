import { createHash } from 'node:crypto'
import { brc38PrivateCheckpointData, brc38PrivateCheckpointMaterializationCursor } from './Brc38PrivateCheckpointData'
import {
  boundedJson,
  digest,
  admissionCopy,
  decodeReceipt,
  read,
  type Brc38ImportJournalAdmission
} from './Brc38ImportJournalContract'

// Authored UNRUN. Independent Node UTF-8/SHA oracle preserves the existing
// SQLite persisted digest domain when the portable implementation is selected.
test.each(['', 'ASCII receipt', 'é😀', 'x\ud800y\udc00', 'A'.repeat(4096)])(
  'portable journal SHA matches the original Node UTF-8 domain',
  text => {
    expect(digest(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'))
  }
)
test('portable journal metadata preserves exact UTF-8 byte limits', () => {
  expect(boundedJson('é'.repeat(2047))).toBe(JSON.stringify('é'.repeat(2047)))
  expect(() => boundedJson('é'.repeat(2048))).toThrow('4096 bytes')
})

describe('private checkpoint observation compatibility and durable materialization boundaries', () => {
  const update = {
    syncStateId: 9,
    mode: 'UPDATE',
    preparedAt: 1700000000000,
    timestamp: '2023-11-14T22:13:20.000Z',
    refNum: null
  }
  const current = (materializedNextRow: number) =>
    brc38PrivateCheckpointData({
      protocol: 'brc38-private-checkpoint-data/v2',
      ...update,
      materializedNextRow
    })
  test('legacy canonical bytes and generated clocks remain unchanged', () => {
    const prior = { protocol: 'brc38-private-checkpoint-data/v1', ...update }
    expect(JSON.stringify(brc38PrivateCheckpointData(prior))).toBe(JSON.stringify(prior))
    expect(() => brc38PrivateCheckpointData({ ...prior, materializedNextRow: 0 })).toThrow()
    expect(() => brc38PrivateCheckpointData({ ...prior, timestamp: '0' })).toThrow()
  })
  test('a resumed receipt retains its pending cursor until the actual materialization boundary', () => {
    let cursor = brc38PrivateCheckpointMaterializationCursor(current(0), 0, 1, 0)
    cursor = brc38PrivateCheckpointMaterializationCursor(current(0), 1, 2, cursor)
    // Reload exact persisted JSON rather than carrying an in-memory overlay.
    const resumed = brc38PrivateCheckpointData(JSON.parse(JSON.stringify(current(0))))
    cursor = brc38PrivateCheckpointMaterializationCursor(resumed, 2, 3, cursor)
    expect(cursor).toBe(0)
    cursor = brc38PrivateCheckpointMaterializationCursor(current(4), 3, 4, cursor)
    expect(cursor).toBe(4)
    expect(brc38PrivateCheckpointMaterializationCursor(current(4), 4, 5, cursor)).toBe(4)
    expect(brc38PrivateCheckpointMaterializationCursor(current(6), 5, 6, cursor)).toBe(6)
    expect(Object.isFrozen(resumed)).toBe(true)
  })
  test.each([-1, 0.5, NaN, Infinity, 1000000001])('invalid cursor %s cannot become durable progress', cursor => {
    expect(() => current(cursor)).toThrow()
  })
  test.each([1, 2, 3, 5])('cursor %s cannot jump to an unmaterialized prefix, regress or go past this page', cursor => {
    expect(() => brc38PrivateCheckpointMaterializationCursor(current(cursor), 3, 4, 0)).toThrow()
  })
  test('NEW and provenance-only SKIP cannot hide pending operational map effects', () => {
    const created = brc38PrivateCheckpointData({
      protocol: 'brc38-private-checkpoint-data/v2',
      ...update,
      mode: 'NEW',
      refNum: 'AAAAAAAAAAAAAAAA',
      materializedNextRow: 1
    })
    expect(brc38PrivateCheckpointMaterializationCursor(created, 0, 1, 0)).toBe(1)
    expect(() => brc38PrivateCheckpointMaterializationCursor(created, 1, 2, 1)).toThrow()
    const skipped = brc38PrivateCheckpointData({
      protocol: 'brc38-private-checkpoint-data/v2',
      ...update,
      mode: 'SKIP',
      timestamp: null,
      materializedNextRow: 5
    })
    expect(brc38PrivateCheckpointMaterializationCursor(skipped, 4, 5, 4)).toBe(5)
    expect(() => brc38PrivateCheckpointMaterializationCursor(skipped, 4, 5, 0)).toThrow()
  })
  test('v2 requires its explicit finite cursor and does not admit extra authority fields', () => {
    expect(() => brc38PrivateCheckpointData({ protocol: 'brc38-private-checkpoint-data/v2', ...update })).toThrow()
    expect(() => brc38PrivateCheckpointData({ ...current(0), verified: true })).toThrow()
    expect(JSON.stringify(current(0)).length).toBeLessThanOrEqual(512)
  })
})
test('portable checkpoint parsing retains exact canonical bytes and actual mapping charge', () => {
  const expiresAt = Date.now() + 10000,
    admission: Brc38ImportJournalAdmission = {
      scope: {
        importId: '11111111-1111-4111-8111-111111111111',
        bindingSha256: 'a'.repeat(64),
        archiveSha256: 'b'.repeat(64),
        userId: -1
      },
      previewId: '22222222-2222-4222-8222-222222222222',
      expiresAt,
      originalLimitsJson: JSON.stringify([10, 65536, 1048576, 4096, 65536, expiresAt]),
      initialDestinationSha256: 'c'.repeat(64),
      totalRows: 2,
      maximumStepRows: 1,
      maximumStepBytes: 4096,
      maximumMappedIds: 1,
      maximumJournalLogicalBytes: 4608
    },
    copied = admissionCopy(admission),
    receipt = {
      protocol: 'brc38-destination-import/v1',
      state: 'COMMITTED',
      sequence: 1,
      nextRow: 1,
      mappedIds: 1,
      logicalBytes: 4608,
      destinationSha256: 'd'.repeat(64),
      lastStep: { fromRow: 0, rows: 1, bytes: 40, mappedIds: 1, pageSha256: 'e'.repeat(64) }
    },
    json = JSON.stringify(receipt),
    admissionJson = JSON.stringify(copied),
    row = {
      ...copied.scope,
      admissionJson,
      admissionSha256: createHash('sha256').update(admissionJson).digest('hex'),
      receiptJson: json,
      receiptSha256: createHash('sha256').update(json).digest('hex'),
      mappedIds: 1,
      maximumMappedIds: 1,
      cleanupAllowed: 0
    }
  expect(read(row, copied)).toEqual(receipt)
  expect(() => read({ ...row, mappedIds: 0 }, copied)).toThrow()
  expect(() => decodeReceipt(json.replace('"COMMITTED"', '"COMPLETE"'), copied)).toThrow()
  expect(() => decodeReceipt(json + ' ', copied)).toThrow()
  expect(admissionCopy(admission).scope.userId).toBe(-1)
})
