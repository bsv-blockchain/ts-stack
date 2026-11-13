import fc from 'fast-check'
import { importJournalFixture } from './Brc38ImportJournalFixture'
import { readBrc38ImportJournal, commitBrc38ImportJournalStep } from './Brc38ImportJournal'
import { runInSeries } from '../../utility/runInSeries'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(
    MIN_PROPERTY_RUNS,
    Number(process.env.FAST_CHECK_NUM_RUNS ?? process.env.FC_NUM_RUNS ?? MIN_PROPERTY_RUNS)
  ),
  seed: Number(process.env.FAST_CHECK_SEED ?? process.env.FC_SEED ?? 3242026)
})

type Fixture = Awaited<ReturnType<typeof importJournalFixture>>
async function verifyPage(fixture: Fixture, ids: readonly number[], index: number): Promise<void> {
  const page = fixture.step(index, 1),
    before = await fixture.observer('native_import_rows').orderBy('rowId'),
    failure = new Error('Synthetic rollback after rows/maps/checkpoint')
  await expect(
    fixture.k.transaction(async trx => {
      await commitBrc38ImportJournalStep(
        trx,
        fixture.admission,
        page,
        await fixture.destinationSha256(trx),
        async () => await fixture.apply(trx, page, position => ids[position])
      )
      throw failure
    })
  ).rejects.toBe(failure)
  expect(await fixture.observer('native_import_rows').orderBy('rowId')).toEqual(before)
  const rolledBack = await fixture.observer.transaction(
    async trx => await readBrc38ImportJournal(trx, fixture.admission)
  )
  expect(rolledBack.nextRow).toBe(index)
  await fixture.commit(page, position => ids[position])
  const replay = jest.fn()
  const committed = await fixture.k.transaction(
    async trx =>
      await commitBrc38ImportJournalStep(trx, fixture.admission, page, await fixture.destinationSha256(trx), replay)
  )
  expect(replay).not.toHaveBeenCalled()
  expect(committed.nextRow).toBe(index + 1)
  expect(committed.state).toBe(index + 1 === ids.length ? 'COMPLETE' : 'COMMITTED')
  const rows = await fixture.observer('native_import_rows').orderBy('rowId'),
    maps = await fixture.observer('brc38_import_ids').where(fixture.admission.scope).orderBy('localId')
  expect(rows.map(row => row.rowId)).toEqual(ids.slice(0, index + 1).map((_value, position) => 100 + position))
  expect(maps.map(row => [row.incomingId, row.localId])).toEqual(
    ids.slice(0, index + 1).map((value, position) => [String(value), 100 + position])
  )
  const row = await fixture.observer('brc38_import_journal').first()
  expect(JSON.parse(row.admissionJson)).toEqual(fixture.admission)
  expect(row.mappedIds).toBe(index + 1)
  expect(committed.mappedIds).toBe(maps.length)
  expect(committed.logicalBytes).toBe(4096 + maps.length * 512)
}

describe('destination-authoritative bounded import journal properties', () => {
  test('independently observes exact prefix/IDs across every rollback and lost-ack boundary', async () => {
    const incoming = fc.uniqueArray(
      fc.oneof(
        fc.integer({ min: -1000000, max: 1000000 }),
        fc.constantFrom(0, Number.MAX_SAFE_INTEGER + 1, 1e21, -1e21, Number.MAX_VALUE)
      ),
      { minLength: 1, maxLength: 24, selector: value => String(value) }
    )
    const active = new Set<Promise<void>>()
    try {
      await fc.assert(
        fc.asyncProperty(incoming, async ids => {
          const work = (async () => {
            const fixture = await importJournalFixture(ids.length)
            try {
              await fixture.prepare()
              await runInSeries(ids.entries(), async ([index]) => await verifyPage(fixture, ids, index))
            } finally {
              await fixture.close()
            }
          })()
          active.add(work)
          try {
            await work
          } finally {
            active.delete(work)
          }
        }),
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
