import {
  brc38NativeTextCoordinate,
  brc38NativeTextProtocolSupports,
  encodeBrc38NativeTextRead
} from './Brc38NativeBlobProtocol'

// Independent ABI fixtures. Existing binary/structured coordinates stay fixed;
// added TEXT coordinates require a current v2 native producer.
const coordinates = [
  ['transactions', 'description', 0, 3],
  ['transactions', 'noSendExpiryReclaimDerivationPrefix', 0, 4],
  ['transactions', 'noSendExpiryReclaimDerivationSuffix', 0, 5],
  ['outputs', 'outputDescription', 3, 1],
  ['outputs', 'spendingDescription', 3, 2],
  ['outputs', 'customInstructions', 3, 3],
  ['outputs', 'derivationPrefix', 3, 4],
  ['outputs', 'derivationSuffix', 3, 5],
  ['outputs', 'type', 3, 6],
  ['outputs', 'purpose', 3, 7],
  ['commissions', 'keyOffset', 4, 1],
  ['certificates', 'subject', 6, 0],
  ['certificates', 'revocationOutpoint', 6, 1],
  ['certificates', 'signature', 6, 2],
  ['certificates', 'verifier', 6, 3],
  ['certificateFields', 'fieldValue', 7, 0],
  ['certificateFields', 'masterKey', 7, 1]
] as const
test.each(coordinates)(
  'native raw TEXT %s.%s has an independent additive coordinate',
  (table, field, tableId, fieldId) => {
    expect(brc38NativeTextCoordinate(table, field)).toEqual([tableId, fieldId])
    expect(brc38NativeTextProtocolSupports(table, 1)).toBe(false)
    expect(brc38NativeTextProtocolSupports(table, 2)).toBe(true)
    const packet = encodeBrc38NativeTextRead({
        table,
        field,
        rowId: -9007199254740991,
        offset: 65535,
        totalBytes: 131071,
        length: 65536
      }),
      view = new DataView(packet.buffer)
    expect(packet.length).toBe(28)
    expect(Array.from(packet.subarray(0, 4))).toEqual([tableId, fieldId, 0, 0])
    expect(view.getBigInt64(4, true)).toBe(-9007199254740991n)
    expect(view.getUint32(12, true)).toBe(65535)
    expect(view.getUint32(16, true)).toBe(131071)
    expect(view.getUint32(20, true)).toBe(65536)
    expect(view.getUint32(24, true)).toBe(0)
  }
)
test('original structured text coordinates and protocol remain compatible', () => {
  expect(brc38NativeTextCoordinate('provenTxReqs', 'history')).toEqual([2, 2])
  expect(brc38NativeTextCoordinate('provenTxReqs', 'notify')).toEqual([2, 3])
  expect(brc38NativeTextCoordinate('syncStates', 'syncMap')).toEqual([5, 0])
  expect(brc38NativeTextCoordinate('syncStates', 'errorLocal')).toEqual([5, 1])
  expect(brc38NativeTextCoordinate('syncStates', 'errorOther')).toEqual([5, 2])
  for (const table of ['provenTxReqs', 'syncStates'] as const) {
    expect(brc38NativeTextProtocolSupports(table, 1)).toBe(true)
    expect(brc38NativeTextProtocolSupports(table, 2)).toBe(true)
    expect(brc38NativeTextProtocolSupports(table, 3)).toBe(false)
  }
})
test('added table/field pairs cannot borrow another table coordinate', () => {
  expect(() => brc38NativeTextCoordinate('certificates', 'masterKey')).toThrow()
  expect(() => brc38NativeTextCoordinate('commissions', 'description')).toThrow()
  expect(() =>
    encodeBrc38NativeTextRead({
      table: 'outputs',
      field: 'customInstructions',
      rowId: 1,
      offset: 0,
      totalBytes: 65536,
      length: 65537
    })
  ).toThrow()
})
