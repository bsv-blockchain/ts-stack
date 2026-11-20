import fc from 'fast-check'
import { brc38StageTables } from './Brc38SemanticStage'
import { semanticStageFixture, importToMemoryStage } from './Brc38SemanticStageFixture'
import { parseBRC38Json } from './index'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(
    MIN_PROPERTY_RUNS,
    Number(process.env.FAST_CHECK_NUM_RUNS ?? process.env.FC_NUM_RUNS ?? MIN_PROPERTY_RUNS)
  ),
  seed: Number(process.env.FAST_CHECK_SEED ?? process.env.FC_SEED ?? 3242026)
})

function shiftReferences(
  data: ReturnType<typeof semanticStageFixture>,
  referenceFields: Set<string>,
  shift: number
): void {
  for (const table of brc38StageTables) {
    for (const row of data.tables[table]) {
      for (const field of Object.keys(row)) if (referenceFields.has(field)) row[field] = (row[field] as number) + shift
      if ('spentBy' in row) row.spentBy = 14 + shift
    }
  }
}

jest.setTimeout(180000)
test('generated identity-preserving ID shifts and table orders agree with the independent legacy parser', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 0, max: 1000000 }),
      fc.integer({ min: 1, max: 30 }),
      fc.integer({ min: 0, max: 12 }),
      async (shift, outputs, rotate) => {
        const data = semanticStageFixture(),
          referenceFields = new Set([
            'provenTxId',
            'provenTxReqId',
            'basketId',
            'transactionId',
            'commissionId',
            'outputId',
            'outputTagId',
            'txLabelId',
            'certificateId',
            'syncStateId'
          ])
        shiftReferences(data, referenceFields, shift)
        data.tables.outputs = Array.from({ length: outputs }, (_, index) => ({
          ...data.tables.outputs[0],
          outputId: 16 + shift + index,
          vout: index
        }))
        const entries = Object.entries(data.tables)
        data.tables = Object.fromEntries([...entries.slice(rotate), ...entries.slice(0, rotate)]) as typeof data.tables
        const before = JSON.stringify(data),
          legacy = parseBRC38Json(before),
          result = await importToMemoryStage(data)
        expect(result.sealed).toBe(1)
        expect(result.maximumReturnedRows).toBe(1)
        expect(result.rows.size).toBe(12 + outputs)
        for (const table of brc38StageTables) {
          for (const [index, row] of legacy.tables[table].entries())
            expect(result.rows.get(JSON.stringify([table, index]))).toEqual(row)
        }
        expect(JSON.stringify(data)).toBe(before)
      }
    ),
    {
      numRuns: Math.max(300, Number(process.env.FAST_CHECK_NUM_RUNS ?? process.env.FC_NUM_RUNS ?? 300)),
      seed: Number(process.env.FAST_CHECK_SEED ?? process.env.FC_SEED ?? 3242026),
      path: process.env.FAST_CHECK_PATH ?? process.env.FC_PATH ?? '',
      interruptAfterTimeLimit: 150000,
      markInterruptAsFailure: true
    }
  )
})
