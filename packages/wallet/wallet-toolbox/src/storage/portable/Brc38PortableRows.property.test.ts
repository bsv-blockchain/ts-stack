import fc from 'fast-check'
import {
  assertBase64,
  assertIsoDate,
  decodePortableRow,
  requireNumber,
  requireString,
  validatePortableRows,
  type PortableRow
} from './Brc38PortableRows'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(MIN_PROPERTY_RUNS, Number(process.env.FAST_CHECK_NUM_RUNS ?? MIN_PROPERTY_RUNS)),
  seed: Number(process.env.FAST_CHECK_SEED ?? 3242026)
})

// Explicit external row contracts; expected decoding uses standard Date,
// Buffer and JSON operations rather than production field-map exports.
const contracts = [
  { kind: 'commission', binary: ['lockingScript'], json: [], date: ['created_at', 'updated_at'] },
  { kind: 'output', binary: ['lockingScript'], json: [], date: ['created_at', 'updated_at'] },
  {
    kind: 'provenTx',
    binary: ['merklePath', 'rawTx'],
    json: [],
    date: ['created_at', 'updated_at']
  },
  {
    kind: 'provenTxReq',
    binary: ['rawTx', 'inputBEEF'],
    json: ['history', 'notify'],
    date: ['created_at', 'updated_at']
  },
  {
    kind: 'transaction',
    binary: ['rawTx', 'inputBEEF'],
    json: [],
    date: ['created_at', 'updated_at']
  },
  {
    kind: 'syncState',
    binary: [],
    json: ['syncMap', 'errorLocal', 'errorOther'],
    date: ['created_at', 'updated_at', 'when']
  },
  ...[
    'settings',
    'user',
    'outputBasket',
    'outputTag',
    'outputTagMap',
    'txLabel',
    'txLabelMap',
    'certificate',
    'certificateField'
  ].map(kind => ({ kind, binary: [], json: [], date: ['created_at', 'updated_at'] }))
]

describe('portable row decoding agrees with independent standard codecs', () => {
  test('generated rows retain unknown data and decode every declared field without changing source rows', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...contracts),
        fc.uint8Array({ maxLength: 128 }),
        fc.integer({ min: 0, max: 2000000000000 }),
        fc.string({ maxLength: 64 }),
        (contract, bytes, time, text) => {
          const row: PortableRow = { unrelated: text, unrelatedNumber: time }
          const expected: Record<string, unknown> = { ...row }
          for (const field of contract.binary) {
            row[field] = Buffer.from(bytes).toString('base64')
            expected[field] = [...bytes]
          }
          for (const field of contract.date) {
            row[field] = new Date(time).toISOString()
            expected[field] = new Date(time)
          }
          for (const field of contract.json) {
            row[field] = { text, integer: time, flag: true }
            expected[field] = JSON.stringify(row[field])
          }
          const before = JSON.stringify(row)
          expect(() => validatePortableRows(contract.kind, [row], 'rows')).not.toThrow()
          expect(decodePortableRow(contract.kind, row)).toEqual(expected)
          expect(JSON.stringify(row)).toBe(before)
          for (const field of contract.date) {
            expect(() =>
              validatePortableRows(contract.kind, [{ ...row, [field]: text + 'not-an-iso-date' }], 'rows')
            ).toThrow(`BRC-38 rows[0].${field}`)
          }
          for (const field of contract.binary) {
            expect(() => validatePortableRows(contract.kind, [{ ...row, [field]: '#' + row[field] }], 'rows')).toThrow(
              `BRC-38 rows[0].${field}`
            )
          }
          for (const field of contract.json) {
            expect(() => validatePortableRows(contract.kind, [{ ...row, [field]: [] }], 'rows')).toThrow(
              `BRC-38 rows[0].${field}`
            )
          }
        }
      ),
      {
        interruptAfterTimeLimit: 150000,
        markInterruptAsFailure: true,
        path: process.env.FAST_CHECK_PATH ?? process.env.FC_PATH ?? ''
      }
    )
  })

  test('primitive validation retains caller values and exact failing paths', () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.string({ maxLength: 128 }),
        fc.uint8Array({ maxLength: 128 }),
        (integer, text, bytes) => {
          expect(requireNumber(integer, 'field')).toBe(integer)
          expect(requireString(text, 'field')).toBe(text)
          expect(() => requireNumber(integer + 0.5, 'field')).toThrow('BRC-38 field must be an integer')
          expect(() => requireString(integer, 'field')).toThrow('BRC-38 field must be a string')
          expect(() => assertBase64(Buffer.from(bytes).toString('base64'), 'field')).not.toThrow()
          expect(() => assertIsoDate(new Date(Math.abs(integer)).toISOString(), 'field')).not.toThrow()
          expect(() => assertIsoDate('2026-02-30T00:00:00.000Z', 'field')).toThrow('BRC-38 field is invalid')
          expect(() => validatePortableRows('unmapped', [null as unknown as PortableRow], 'rows')).toThrow(
            'BRC-38 rows[0] must be an object'
          )
        }
      ),
      {
        interruptAfterTimeLimit: 150000,
        markInterruptAsFailure: true,
        path: process.env.FAST_CHECK_PATH ?? process.env.FC_PATH ?? ''
      }
    )
  })
})
