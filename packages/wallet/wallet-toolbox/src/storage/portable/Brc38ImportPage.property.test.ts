import fc from 'fast-check'
import { prepareBrc38ImportPage, type Brc38PreparedImportData } from './Brc38ImportPage'
import { importPageFixture } from './Brc38ImportPageFixture'
import { semanticStageFixture } from './Brc38SemanticStageFixture'
import type { Brc38StageTable } from './Brc38SemanticStage'
import type { PortableRow } from './Brc38PortableRows'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(
    MIN_PROPERTY_RUNS,
    Number(process.env.FAST_CHECK_NUM_RUNS ?? process.env.FC_NUM_RUNS ?? MIN_PROPERTY_RUNS)
  ),
  seed: Number(process.env.FAST_CHECK_SEED ?? process.env.FC_SEED ?? 3242026)
})

const legacyOrder: readonly Brc38StageTable[] = [
  'provenTxs',
  'outputBaskets',
  'outputTags',
  'txLabels',
  'transactions',
  'outputs',
  'txLabelMaps',
  'outputTagMaps',
  'certificates',
  'certificateFields',
  'commissions',
  'provenTxReqs',
  'syncStates'
]
function observe(actual: object, original: PortableRow): object {
  return Object.fromEntries(
    Object.entries(actual).map(([field, value]) => {
      if (value instanceof Date) return [field, value.toISOString()]
      if (typeof original[field] === 'string' && Array.isArray(value))
        return [field, Buffer.from(value as number[]).toString('base64')]
      if (typeof value === 'string' && typeof original[field] === 'object') return [field, JSON.parse(value) as unknown]
      return [field, value]
    })
  )
}
function assertData(
  value: Brc38PreparedImportData,
  fixture: ReturnType<typeof importPageFixture>,
  expected: readonly { table: Brc38StageTable; index: number }[],
  position: number
): number {
  if (value.kind === 'header') {
    expect(value.original).toEqual(fixture.header)
    expect(observe(value.user, fixture.data.user)).toEqual(fixture.data.user)
    return 0
  }
  expect(value.table).toBe(expected[position].table)
  expect(value.fromIndex).toBe(expected[position].index)
  value.rows.forEach((row, index) => {
    const coordinate = expected[position + index]
    expect(value.table).toBe(coordinate.table)
    expect(observe(row, fixture.data.tables[coordinate.table][coordinate.index])).toEqual(
      fixture.data.tables[coordinate.table][coordinate.index]
    )
  })
  return value.rows.length
}
describe('independent bounded import page/legacy-field properties', () => {
  test('exact thirteen-table sequence and semantic values survive every row-page boundary including the original incoming Number domain', async () => {
    const incoming = fc.oneof(
        fc.integer({ min: -20, max: 20 }),
        fc.constantFrom(0, -1, Number.MAX_SAFE_INTEGER + 1, 1e21, -1e21, Number.MAX_VALUE)
      ),
      active = new Set<Promise<void>>()
    try {
      await fc.assert(
        fc.asyncProperty(
          incoming,
          fc.integer({ min: 1, max: 12 }),
          fc.integer({ min: 1, max: 4 }),
          async (id, count, pageRows) => {
            const work = (async () => {
              const data = semanticStageFixture(),
                original = data.tables.outputBaskets[0]
              data.tables.outputBaskets = Array.from({ length: count }, (_value, index) => ({
                ...original,
                basketId: index === 0 ? id : -1000 - index,
                name: 'original ' + index
              }))
              data.tables.outputs[0].basketId = id
              const fixture = importPageFixture(data),
                admission = { ...fixture.admission, maximumStepRows: pageRows },
                expected = legacyOrder.flatMap(table => data.tables[table].map((_row, index) => ({ table, index })))
              let cursor = 0,
                observed = 0
              while (cursor < admission.totalRows) {
                const page = await prepareBrc38ImportPage(fixture.reader, fixture.metadata, admission, cursor)
                expect(page.step.fromRow).toBe(cursor)
                expect(page.step.rows).toBeLessThanOrEqual(pageRows)
                expect(page.step.bytes).toBeLessThanOrEqual(admission.maximumStepBytes)
                observed += await page.consume(async value => assertData(value, fixture, expected, observed))
                cursor += page.step.rows
              }
              expect(observed).toBe(expected.length)
              expect(cursor).toBe(admission.totalRows)
              expect(fixture.maximumPending).toBe(1)
              expect(fixture.calls).toEqual(expected)
            })()
            active.add(work)
            try {
              await work
            } finally {
              active.delete(work)
            }
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
    } finally {
      await Promise.allSettled(active)
    }
  }, 180000)
})
