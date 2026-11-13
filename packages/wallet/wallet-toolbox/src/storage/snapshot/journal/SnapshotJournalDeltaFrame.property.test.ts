import fc from 'fast-check'
import type { SnapshotJournalDeltaPage } from './SnapshotJournalDeltaPage'
import { snapshotJournalRevision } from './SnapshotJournalRevision'
import { decodeSnapshotJournalDeltaFrame, encodeSnapshotJournalDeltaFrame } from './SnapshotJournalDeltaFrame'

jest.setTimeout(30000)
const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(
    MIN_PROPERTY_RUNS,
    Number(process.env.FAST_CHECK_NUM_RUNS ?? process.env.FC_NUM_RUNS ?? MIN_PROPERTY_RUNS)
  ),
  seed: Number(process.env.FAST_CHECK_SEED ?? process.env.FC_SEED ?? 3242026)
})
const controls = {
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true,
  path: process.env.FAST_CHECK_PATH ?? process.env.FC_PATH ?? ''
}
const names: SnapshotJournalDeltaPage['table'][] = [
  'transactions',
  'outputs',
  'certificates',
  'txLabels',
  'outputBaskets',
  'outputTags',
  'commissions',
  'syncStates',
  'provenTxs',
  'provenTxReqs',
  'txLabelMaps',
  'outputTagMaps',
  'certificateFields'
]
const keys = [
  'transactionId',
  'outputId',
  'certificateId',
  'txLabelId',
  'basketId',
  'outputTagId',
  'commissionId',
  'syncStateId',
  'provenTxId',
  'provenTxReqId',
  'txLabelId',
  'outputTagId',
  'certificateId'
]
const exactText = fc
  .array(fc.constantFrom('x', 'é', '中', '😀', '\u0000', '"', '\\'), { maxLength: 16 })
  .map(parts => parts.join(''))

test('generated exact journal identities, raw SQL cell representations and tombstones survive independent round trips', () => {
  fc.assert(
    fc.property(
      fc.record({
        tableId: fc.integer({ min: 0, max: 12 }),
        id1: fc.integer({ min: 1, max: 1000000 }),
        id2: fc.integer({ min: 1, max: 1000000 }),
        revision: fc.bigInt({ min: 1n, max: 9223372036854775807n }),
        text: exactText,
        bytes: fc.uint8Array({ maxLength: 128 }),
        time: fc.integer({ min: 0, max: 2000000000 }),
        number: fc.integer(),
        integer: fc.bigInt({ min: -9223372036854775808n, max: 9223372036854775807n }),
        flag: fc.boolean(),
        present: fc.boolean(),
        complete: fc.boolean()
      }),
      value => {
        const revision = snapshotJournalRevision(value.revision.toString())
        const id2 = value.tableId === 10 || value.tableId === 11 ? value.id2 : 0
        const field = value.tableId === 12 ? value.text : ''
        const metadata = { revision, id1: value.id1, id2, exactText: field, present: value.present }
        const row: Record<string, unknown> = {
          [keys[value.tableId]]: value.id1,
          nullable: null,
          rawBoolean: Number(value.flag),
          boolean: value.flag,
          text: value.text,
          rawTx: value.bytes,
          created_at: new Date(value.time),
          number: value.number,
          integer: value.integer,
          negativeZero: -0
        }
        if (value.tableId === 10) row.transactionId = value.id2
        if (value.tableId === 11) row.outputId = value.id2
        if (value.tableId === 12) row.fieldName = value.text
        const source: SnapshotJournalDeltaPage = {
          table: names[value.tableId],
          changes: [value.present ? { metadata, present: true, row } : { metadata, present: false }],
          examined: 1,
          payloadBytes: 4096,
          complete: value.complete,
          after: { revision, id1: value.id1, id2, exactText: field }
        }
        const bound = { stream: 'scope' as const, tableId: value.tableId }
        const encoded = encodeSnapshotJournalDeltaFrame(source, bound)
        const restored = decodeSnapshotJournalDeltaFrame(encoded, bound)
        expect(restored).toEqual(source)
        const change = restored.changes[0]
        if (change.present) {
          expect(change.row.rawTx).not.toBe(value.bytes)
          expect(change.row.created_at).not.toBe(row.created_at)
          expect(Object.is(change.row.negativeZero, -0)).toBe(true)
          value.bytes.fill(42)
          expect(decodeSnapshotJournalDeltaFrame(encoded, bound)).toEqual(restored)
          change.row[keys[value.tableId]] = value.id1 + 1
          expect(() => encodeSnapshotJournalDeltaFrame(restored, bound)).toThrow('Invalid raw')
        }
        expect(() => encodeSnapshotJournalDeltaFrame({ ...source, examined: 2 }, bound)).toThrow('Invalid raw')
      }
    ),
    controls
  )
})
