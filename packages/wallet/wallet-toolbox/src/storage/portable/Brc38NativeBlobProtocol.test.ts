import {
  encodeBrc38NativeBlobWrite,
  encodeBrc38NativeBlobRead,
  type Brc38NativeBlobWrite
} from './Brc38NativeBlobProtocol'

const input: Brc38NativeBlobWrite = {
  table: 'transactions',
  field: 'rawTx',
  rowId: 9007199254740991,
  offset: 17,
  totalBytes: 1000000000,
  bytes: new Uint8Array([0, 127, 255])
}

test('incremental read request carries only exact coordinates and no field payload', () => {
  const packet = encodeBrc38NativeBlobRead({ ...input, length: 65536 }),
    view = new DataView(packet.buffer)
  expect(packet.byteLength).toBe(28)
  expect(view.getBigUint64(4, true)).toBe(9007199254740991n)
  expect(view.getUint32(12, true)).toBe(17)
  expect(view.getUint32(16, true)).toBe(1000000000)
  expect(view.getUint32(20, true)).toBe(65536)
  expect(view.getUint32(24, true)).toBe(0)
})
test.each([0, -1, 1.5, 65537, NaN, Infinity])('incremental read length %p refuses before allocation', length => {
  expect(() => encodeBrc38NativeBlobRead({ ...input, length })).toThrow()
})
test('incremental read refuses an extent that passes EOF', () => {
  expect(() => encodeBrc38NativeBlobRead({ ...input, offset: 999999999, length: 2 })).toThrow()
  expect(encodeBrc38NativeBlobRead({ ...input, offset: 999999999, length: 1 }).byteLength).toBe(28)
})

test('incremental native ABI agrees with independent little-endian field decoding and owns its byte extent', () => {
  const source = { ...input, bytes: input.bytes.slice() },
    packet = encodeBrc38NativeBlobWrite(source)
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength)
  expect(packet.byteLength).toBe(31)
  expect(packet[0]).toBe(0)
  expect(packet[1]).toBe(0)
  expect(Array.from(packet.subarray(2, 4))).toEqual([0, 0])
  expect(view.getBigUint64(4, true)).toBe(9007199254740991n)
  expect(view.getUint32(12, true)).toBe(17)
  expect(view.getUint32(16, true)).toBe(1000000000)
  expect(view.getUint32(20, true)).toBe(3)
  expect(view.getUint32(24, true)).toBe(0)
  source.bytes.fill(23)
  expect(Array.from(packet.subarray(28))).toEqual([0, 127, 255])
})
test.each([
  ['transactions', 'inputBEEF', 0, 1],
  ['transactions', 'noSendExpiryReclaimRawTx', 0, 2],
  ['provenTxs', 'rawTx', 1, 0],
  ['provenTxs', 'merklePath', 1, 1],
  ['provenTxReqs', 'rawTx', 2, 0],
  ['provenTxReqs', 'inputBEEF', 2, 1],
  ['outputs', 'lockingScript', 3, 0],
  ['commissions', 'lockingScript', 4, 0]
] as const)('explicit native whitelist %s.%s has the fixed ABI identity', (table, field, tableId, fieldId) => {
  const actual = encodeBrc38NativeBlobWrite({ ...input, table, field })
  expect(Array.from(actual.subarray(0, 2))).toEqual([tableId, fieldId])
})
test.each([
  { rowId: 0 },
  { rowId: -1 },
  { rowId: 1.5 },
  { rowId: Infinity },
  { offset: -1 },
  { offset: 1000000000 },
  { offset: 1.5 },
  { totalBytes: 0 },
  { totalBytes: 1000000001 },
  { totalBytes: NaN },
  { bytes: new Uint8Array(0) },
  { bytes: new Uint8Array(65537) },
  { totalBytes: 18 },
  { table: 'outputs', field: 'rawTx' }
])('coordinate/extent %p refuses without any native operation', change => {
  expect(() => Reflect.apply(encodeBrc38NativeBlobWrite, undefined, [{ ...input, ...change }])).toThrow()
})
