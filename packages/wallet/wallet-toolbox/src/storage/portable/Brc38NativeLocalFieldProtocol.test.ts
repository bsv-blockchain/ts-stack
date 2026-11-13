import {
  brc38NativeLocalFieldCoordinate,
  brc38NativeLocalFieldKind,
  encodeBrc38NativeLocalFieldRead,
  brc38NativeLocalFieldProtocolMatches,
  type Brc38NativeLocalFieldRead
} from './Brc38NativeLocalFieldProtocol'
import { encodeBrc38NativeBlobWrite, encodeBrc38NativeTextRead } from './Brc38NativeBlobProtocol'

test.each([
  ['transactions', 'rawTx', 0, 0, 'blob'],
  ['transactions', 'inputBEEF', 0, 1, 'blob'],
  ['transactions', 'noSendExpiryReclaimRawTx', 0, 2, 'blob'],
  ['proven_txs', 'rawTx', 1, 0, 'blob'],
  ['proven_txs', 'merklePath', 1, 1, 'blob'],
  ['proven_tx_reqs', 'rawTx', 2, 0, 'blob'],
  ['proven_tx_reqs', 'inputBEEF', 2, 1, 'blob'],
  ['outputs', 'lockingScript', 3, 0, 'blob'],
  ['commissions', 'lockingScript', 4, 0, 'blob'],
  ['prepared_beefs', 'beef', 8, 0, 'blob'],
  ['action_batch_blobs', 'bytes', 9, 0, 'blob'],
  ['sync_transfer_parts', 'bytes', 10, 0, 'blob'],
  ['action_batches', 'uploadDigests', 11, 0, 'text'],
  ['action_batches', 'result', 11, 1, 'text'],
  ['action_batches', 'manifest', 11, 2, 'text'],
  ['sync_transfers', 'result', 12, 0, 'text'],
  ['monitor_events', 'details', 13, 0, 'text'],
  ['snapshot_reconciliation_stage_pages', 'payload', 14, 0, 'blob'],
  ['snapshot_reconciliation_provenance', 'payload', 15, 0, 'blob'],
  ['brc38_import_original', 'originalJson', 16, 0, 'text'],
  ['brc38_import_streamed_original', 'originalJson', 17, 0, 'text'],
  ['brc38_import_structured_original', 'originalJson', 18, 0, 'text'],
  ['private_binary_chunks', 'payload', 19, 0, 'blob'],
  ['private_text_chunks', 'payload', 20, 0, 'blob'],
  ['private_structured_chunks', 'payload', 21, 0, 'blob'],
  ['private_canonical_structured_chunks', 'payload', 22, 0, 'blob'],
  ['private_projected_structured_chunks', 'payload', 23, 0, 'blob']
] as const)('local %s.%s uses independently expected ABI coordinates', (table, field, tableId, fieldId, kind) => {
  const input = {
      table,
      field,
      rowId: -9007199254740991,
      offset: 7,
      totalBytes: 1000000000,
      length: 65536
    } as Brc38NativeLocalFieldRead,
    packet = encodeBrc38NativeLocalFieldRead(input),
    view = new DataView(packet.buffer)
  expect(brc38NativeLocalFieldCoordinate(input)).toEqual([tableId, fieldId])
  expect(brc38NativeLocalFieldKind(input)).toBe(kind)
  expect(packet.byteLength).toBe(28)
  expect(Array.from(packet.subarray(0, 4))).toEqual([tableId, fieldId, 0, 0])
  expect(view.getBigInt64(4, true)).toBe(-9007199254740991n)
  expect(view.getUint32(12, true)).toBe(7)
  expect(view.getUint32(16, true)).toBe(1000000000)
  expect(view.getUint32(20, true)).toBe(65536)
  expect(view.getUint32(24, true)).toBe(0)
  expect(() => encodeBrc38NativeTextRead(input as unknown as Parameters<typeof encodeBrc38NativeTextRead>[0])).toThrow()
  expect(() =>
    encodeBrc38NativeBlobWrite({ ...input, bytes: new Uint8Array([1]) } as unknown as Parameters<
      typeof encodeBrc38NativeBlobWrite
    >[0])
  ).toThrow()
})
test.each([
  { table: 'users', field: 'identityKey' },
  { table: 'action_batches', field: 'bytes' },
  { table: 'prepared_beefs', field: 'result' },
  { rowId: NaN },
  { rowId: Infinity },
  { rowId: 1.5 },
  { offset: -1 },
  { offset: 9 },
  { length: 0 },
  { length: 65537 },
  { length: 1.5 },
  { totalBytes: 0 },
  { totalBytes: 1000000001 },
  { totalBytes: NaN },
  { offset: 8, length: 2 }
])('invalid local field extent %p refuses before native I/O', changes => {
  expect(() =>
    encodeBrc38NativeLocalFieldRead({
      table: 'prepared_beefs',
      field: 'beef',
      rowId: 1,
      offset: 0,
      totalBytes: 9,
      length: 9,
      ...changes
    } as Brc38NativeLocalFieldRead)
  ).toThrow()
})

test('new journal BLOB coordinates require their additive local ABI', () => {
  for (const table of ['snapshot_reconciliation_stage_pages', 'snapshot_reconciliation_provenance'] as const) {
    const coordinate = { table, field: 'payload' as const, rowId: -7 }
    expect(brc38NativeLocalFieldProtocolMatches(coordinate, 1)).toBe(false)
    expect(brc38NativeLocalFieldProtocolMatches(coordinate, 2)).toBe(true)
    expect(brc38NativeLocalFieldProtocolMatches(coordinate, 3)).toBe(true)
    expect(brc38NativeLocalFieldProtocolMatches(coordinate, 4)).toBe(false)
  }
  expect(brc38NativeLocalFieldProtocolMatches({ table: 'monitor_events', field: 'details', rowId: 0 }, 1)).toBe(true)
  expect(brc38NativeLocalFieldProtocolMatches({ table: 'monitor_events', field: 'details', rowId: 0 }, 2)).toBe(true)
})

test('prior original JSON and field chunks require local ABI3', () => {
  for (const coordinate of [
    { table: 'brc38_import_structured_original', field: 'originalJson', rowId: -7 },
    { table: 'private_projected_structured_chunks', field: 'payload', rowId: 0 }
  ] as const) {
    expect(brc38NativeLocalFieldProtocolMatches(coordinate, 1)).toBe(false)
    expect(brc38NativeLocalFieldProtocolMatches(coordinate, 2)).toBe(false)
    expect(brc38NativeLocalFieldProtocolMatches(coordinate, 3)).toBe(true)
    expect(brc38NativeLocalFieldProtocolMatches(coordinate, 4)).toBe(false)
  }
})
