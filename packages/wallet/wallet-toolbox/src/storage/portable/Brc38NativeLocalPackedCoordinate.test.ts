import {
  brc38NativePackedBinaryCoordinate,
  brc38NativePackedTextCoordinate,
  validateBrc38NativePackedBinaryRead,
  validateBrc38NativePackedTextRead
} from './Brc38NativeLocalPackedCoordinate'
import {
  encodeBrc38NativeBlobRead,
  encodeBrc38NativeBlobWrite,
  encodeBrc38NativeTextRead
} from './Brc38NativeBlobProtocol'

describe('private local packed coordinates preserve the original transport contracts', () => {
  it('accepts signed core and auxiliary pointer keys with independent fixed IDs', () => {
    expect(brc38NativePackedBinaryCoordinate({ table: 'provenTxs', field: 'merklePath', rowId: -7 })).toEqual([1, 1])
    expect(
      brc38NativePackedBinaryCoordinate({ table: 'transactions', field: 'noSendExpiryReclaimRawTx', rowId: 0 })
    ).toEqual([0, 2])
    expect(
      brc38NativePackedBinaryCoordinate({ table: 'prepared_beefs', field: 'beef', rowId: -9007199254740991 })
    ).toEqual([8, 0])
    expect(brc38NativePackedBinaryCoordinate({ table: 'action_batch_blobs', field: 'bytes', rowId: 0 })).toEqual([9, 0])
    expect(
      brc38NativePackedBinaryCoordinate({ table: 'sync_transfer_parts', field: 'bytes', rowId: 9007199254740991 })
    ).toEqual([10, 0])
    expect(
      brc38NativePackedBinaryCoordinate({ table: 'snapshot_reconciliation_stage_pages', field: 'payload', rowId: -7 })
    ).toEqual([14, 0])
    expect(
      brc38NativePackedBinaryCoordinate({ table: 'snapshot_reconciliation_provenance', field: 'payload', rowId: 0 })
    ).toEqual([15, 0])
    expect(brc38NativePackedTextCoordinate({ table: 'action_batches', field: 'uploadDigests', rowId: -7 })).toEqual([
      11, 0
    ])
    expect(brc38NativePackedTextCoordinate({ table: 'action_batches', field: 'manifest', rowId: -7 })).toEqual([11, 2])
    expect(brc38NativePackedTextCoordinate({ table: 'sync_transfers', field: 'result', rowId: 0 })).toEqual([12, 0])
    expect(brc38NativePackedTextCoordinate({ table: 'monitor_events', field: 'details', rowId: -7 })).toEqual([13, 0])
    expect(brc38NativePackedTextCoordinate({ table: 'outputs', field: 'purpose', rowId: -7 })).toEqual([3, 7])
  })
  it('validates finite extents and rejects coordinate/range substitutions', () => {
    validateBrc38NativePackedBinaryRead({
      table: 'transactions',
      field: 'rawTx',
      rowId: -7,
      offset: 997,
      totalBytes: 999,
      length: 2
    })
    validateBrc38NativePackedTextRead({
      table: 'monitor_events',
      field: 'details',
      rowId: 0,
      offset: 0,
      totalBytes: 1,
      length: 1
    })
    expect(() =>
      validateBrc38NativePackedBinaryRead({
        table: 'transactions',
        field: 'rawTx',
        rowId: -7,
        offset: 998,
        totalBytes: 999,
        length: 2
      })
    ).toThrow()
    expect(() => brc38NativePackedBinaryCoordinate({ table: 'outputs', field: 'rawTx', rowId: 7 })).toThrow()
    expect(() => brc38NativePackedTextCoordinate({ table: 'outputs', field: 'notify', rowId: 7 })).toThrow()
    expect(() =>
      brc38NativePackedBinaryCoordinate({ table: 'prepared_beefs', field: 'beef', rowId: 9007199254740992 })
    ).toThrow()
  })
  it('leaves the original binary read/write positive-ID ABI and TEXT IDs unchanged', () => {
    expect(() =>
      encodeBrc38NativeBlobRead({
        table: 'transactions',
        field: 'rawTx',
        rowId: -7,
        offset: 0,
        totalBytes: 1,
        length: 1
      })
    ).toThrow()
    expect(() =>
      encodeBrc38NativeBlobWrite({
        table: 'transactions',
        field: 'rawTx',
        rowId: 0,
        offset: 0,
        totalBytes: 1,
        bytes: new Uint8Array([7])
      })
    ).toThrow()
    const packet = encodeBrc38NativeTextRead({
      table: 'outputs',
      field: 'purpose',
      rowId: -7,
      offset: 0,
      totalBytes: 1,
      length: 1
    })
    expect([packet[0], packet[1], new DataView(packet.buffer).getBigInt64(4, true)]).toEqual([3, 7, -7n])
  })
})
