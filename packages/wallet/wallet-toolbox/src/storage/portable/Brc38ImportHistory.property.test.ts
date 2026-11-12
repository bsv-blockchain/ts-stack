import fc from 'fast-check'
import { importJournalFixture } from './Brc38ImportJournalFixture'
import { importPageFixture } from './Brc38ImportPageFixture'
import { prepareBrc38ImportPage, type Brc38PreparedImportData } from './Brc38ImportPage'
import { prepareBrc38ImportHistory } from './Brc38ImportHistory'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(
    MIN_PROPERTY_RUNS,
    Number(process.env.FAST_CHECK_NUM_RUNS ?? process.env.FC_NUM_RUNS ?? MIN_PROPERTY_RUNS)
  ),
  seed: Number(process.env.FAST_CHECK_SEED ?? process.env.FC_SEED ?? 3242026)
})

test('full300 native notification projections match independent accepted-number scope oracle without mutating original history', async () => {
  const target = await importJournalFixture(),
    fixture = importPageFixture()
  try {
    await target.prepare()
    await target.commit(target.step(0, 4), index => [14, 0, -7, 1e300][index])
    const known = new Map([
        [14, 100],
        [0, 101],
        [-7, 102],
        [1e300, 103]
      ]),
      prepared = await (
        await prepareBrc38ImportPage(fixture.reader, fixture.metadata, fixture.admission, 12)
      ).consume(async value => value)
    if (prepared.kind !== 'table' || prepared.table !== 'provenTxReqs')
      throw new Error('Original notification row missing')
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(14, 0, -7, 1e300, 999, 1.5), { maxLength: 300 }),
        async transactionIds => {
          const originalJson = JSON.stringify({ transactionIds, enabled: false }),
            row: Brc38PreparedImportData = {
              ...prepared,
              rows: [{ ...prepared.rows[0], notify: originalJson }]
            },
            before = JSON.stringify(row),
            [projection] = await target.k.transaction(
              async trx => await prepareBrc38ImportHistory(trx, target.admission.scope, row, 65536)
            ),
            expected = [
              ...new Set(transactionIds.filter(value => known.has(value)).map(value => known.get(value)!))
            ].sort((a, b) => a - b),
            unknown = new Set(transactionIds.filter(value => Number.isInteger(value) && !known.has(value)))
          expect(JSON.parse(projection.mappedJson)).toEqual({
            transactionIds: expected,
            enabled: false
          })
          expect(projection.originalJson).toBe(originalJson)
          expect(projection).toMatchObject({ unmappedIds: unknown.size, activated: false })
          expect(JSON.stringify(row)).toBe(before)
        }
      ),
      {
        numRuns: Math.max(MIN_PROPERTY_RUNS, Number(process.env.FAST_CHECK_NUM_RUNS ?? MIN_PROPERTY_RUNS)),
        seed: Number(process.env.FAST_CHECK_SEED ?? 3242026),
        path: process.env.FAST_CHECK_PATH ?? process.env.FC_PATH ?? '',
        interruptAfterTimeLimit: 150000,
        markInterruptAsFailure: true
      }
    )
  } finally {
    await target.close()
  }
}, 180000)
