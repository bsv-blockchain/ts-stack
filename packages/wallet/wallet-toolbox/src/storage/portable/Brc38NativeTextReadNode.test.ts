import type { Knex } from 'knex'
import { readBrc38NativeTextBytes, readBrc38NativeTextExtent } from './Brc38NativeTextReadNode'
import { encodeBrc38NativeTextRead, encodeBrc38NativeBlobWrite } from './Brc38NativeBlobProtocol'
import { readBrc38NativePackedTextPhysicalBytes } from './Brc38NativePackedTextFieldsNode'

test.each([
  ['provenTxReqs', 'history', 2, 2],
  ['provenTxReqs', 'notify', 2, 3],
  ['syncStates', 'syncMap', 5, 0],
  ['syncStates', 'errorLocal', 5, 1],
  ['syncStates', 'errorOther', 5, 2]
] as const)('read-only TEXT %s.%s uses independently decoded fixed coordinates', (table, field, tableId, fieldId) => {
  const packet = encodeBrc38NativeTextRead({
      table,
      field,
      rowId: 9007199254740991,
      offset: 17,
      totalBytes: 1000000000,
      length: 65536
    }),
    view = new DataView(packet.buffer)
  expect(packet.length).toBe(28)
  expect(Array.from(packet.subarray(0, 4))).toEqual([tableId, fieldId, 0, 0])
  expect(view.getBigUint64(4, true)).toBe(9007199254740991n)
  expect(view.getUint32(12, true)).toBe(17)
  expect(view.getUint32(16, true)).toBe(1000000000)
  expect(view.getUint32(20, true)).toBe(65536)
  expect(view.getUint32(24, true)).toBe(0)
  // New read-only fields never expand the original native writer whitelist.
  expect(() =>
    encodeBrc38NativeBlobWrite({
      table,
      field,
      rowId: 1,
      offset: 0,
      totalBytes: 1,
      bytes: new Uint8Array([1])
    } as unknown as Parameters<typeof encodeBrc38NativeBlobWrite>[0])
  ).toThrow()
})
test.each([0, -1, NaN, Infinity, 1.5, 65537])('invalid TEXT extent %p refuses before native I/O', length => {
  expect(() =>
    encodeBrc38NativeTextRead({
      table: 'syncStates',
      field: 'syncMap',
      rowId: 1,
      offset: 0,
      totalBytes: 1000000,
      length
    })
  ).toThrow()
})
test('copied transaction/config/schema flags never issue TEXT SQL or native reads', async () => {
  const raw = jest.fn(),
    transaction = {
      isTransaction: true,
      raw,
      client: { config: { client: 'better-sqlite3' } }
    } as unknown as Knex.Transaction
  await expect(
    readBrc38NativeTextBytes(transaction, { table: 'provenTxReqs', field: 'history', rowId: 1 })
  ).rejects.toThrow('actual retained')
  await expect(
    readBrc38NativeTextExtent(transaction, {
      table: 'provenTxReqs',
      field: 'history',
      rowId: 1,
      offset: 0,
      totalBytes: 2,
      length: 2
    })
  ).rejects.toThrow('actual retained')
  expect(raw).not.toHaveBeenCalled()
  await expect(
    readBrc38NativePackedTextPhysicalBytes(transaction, { table: 'provenTxReqs', field: 'history', rowId: 1 })
  ).rejects.toThrow()
  expect(raw).not.toHaveBeenCalled()
})
test('aborted TEXT read retains the original cancellation and issues no SQL', async () => {
  const controller = new AbortController(),
    reason = new Error('original cancellation'),
    raw = jest.fn()
  controller.abort(reason)
  await expect(
    readBrc38NativeTextBytes(
      { raw } as unknown as Knex.Transaction,
      { table: 'syncStates', field: 'syncMap', rowId: 1 },
      controller.signal
    )
  ).rejects.toBe(reason)
  expect(raw).not.toHaveBeenCalled()
})

// Additive TEXT transport preserves SQLite's accepted signed safe rowids;
// original binary coordinate validation remains positive and unchanged.
test.each([-9007199254740991, -1, 0, 1, 9007199254740991])('TEXT packet retains exact signed rowid %s', rowId => {
  const packet = encodeBrc38NativeTextRead({
      table: 'syncStates',
      field: 'syncMap',
      rowId,
      offset: 0,
      totalBytes: 2,
      length: 2
    }),
    view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength)
  expect(view.getBigInt64(4, true)).toBe(BigInt(rowId))
  expect(packet.slice(0, 4)).toEqual(new Uint8Array([5, 0, 0, 0]))
  expect(() =>
    encodeBrc38NativeBlobWrite({
      table: 'transactions',
      field: 'rawTx',
      rowId: 0,
      offset: 0,
      totalBytes: 1,
      bytes: new Uint8Array([0])
    })
  ).toThrow()
})
