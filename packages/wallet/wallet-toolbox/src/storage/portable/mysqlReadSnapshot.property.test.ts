import fc from 'fast-check'
import type { TrxToken } from '../../sdk/WalletStorage.interfaces'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
import { runInSeries } from '../../utility/runInSeries'
import { mysqlReadSnapshotFixture } from '../../../test/utils/mysqlReadSnapshotFixture'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns) ? Math.max(MIN_PROPERTY_RUNS, requestedRuns) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

const reads: ReadonlyArray<(storage: StorageKnex, trx: TrxToken) => Promise<unknown>> = [
  (storage, trx) => storage.findProvenTxs({ partial: { provenTxId: 1 }, trx }),
  (storage, trx) => storage.findProvenTxs({ partial: { txid: '11'.repeat(32) }, trx }),
  (storage, trx) => storage.findSyncStates({ partial: { userId: 1, syncStateId: 1 }, trx }),
  (storage, trx) => storage.findSyncStates({ partial: { userId: 1, storageIdentityKey: 'source' }, trx }),
  (storage, trx) => storage.findProvenTxs({ partial: {}, trx }),
  (storage, trx) => storage.findSyncStates({ partial: { userId: 1 }, trx }),
  (storage, trx) => storage.findSyncStates({ partial: { syncStateId: 1 }, trx })
]

test('generated direct and retained view schedules preserve consistent reads, writable locks and exact failures', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        retained: fc.boolean(),
        fail: fc.boolean(),
        schedule: fc.array(
          fc.record({
            selector: fc.integer({ min: 0, max: reads.length - 1 }),
            peer: fc.boolean(),
            write: fc.boolean()
          }),
          { minLength: 1, maxLength: 24 }
        )
      }),
      async input => {
        // The installed Knex transaction/query builders run against a bounded
        // synthetic driver. The separate native fixture proves server isolation.
        const fixture = mysqlReadSnapshotFixture()
        const peer = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: fixture.db })
        peer._settings = fixture.storage.getSettings()
        jest.spyOn(fixture.storage, 'readSettings').mockResolvedValue(fixture.storage.getSettings())
        const failure = new Error('generated callback failure')
        const expectedLocks: boolean[] = []
        const read = async (trx: TrxToken): Promise<number> => {
          await runInSeries(input.schedule, async operation => {
            const storage = operation.peer ? peer : fixture.storage
            await reads[operation.selector](storage, trx)
            expectedLocks.push(false)
            if (operation.write) {
              await fixture.db.transaction(async writable => {
                await reads[operation.selector](storage, writable)
              })
              // Only the four exact writable authority selectors require locks.
              expectedLocks.push(operation.selector < 4)
            }
          })
          if (input.fail) throw failure
          return input.schedule.length
        }
        try {
          if (input.retained) {
            const view = await fixture.storage.openReadSnapshot({ lifetimeMs: 30000 })
            const result = view.read(read)
            if (input.fail) {
              await expect(result).rejects.toBe(failure)
              await expect(view.close()).rejects.toBe(failure)
            } else {
              await expect(result).resolves.toBe(input.schedule.length)
              await view.close()
            }
          } else {
            const result = fixture.storage.readSnapshot(read)
            if (input.fail) await expect(result).rejects.toBe(failure)
            else await expect(result).resolves.toBe(input.schedule.length)
          }
          await fixture.db.transaction(async trx => {
            await fixture.storage.findProvenTxs({ partial: { provenTxId: 1 }, trx })
          })
          expectedLocks.push(true)
          const actual = fixture.events.filter(sql => sql.startsWith('SELECT'))
          expect(actual).toHaveLength(expectedLocks.length)
          expect(actual.map(sql => sql.endsWith('FOR UPDATE'))).toEqual(expectedLocks)
          expect(fixture.events.at(-1)).toBe('RELEASE')
        } finally {
          await fixture.db.destroy()
          jest.restoreAllMocks()
        }
      }
    ),
    { interruptAfterTimeLimit: 150000, markInterruptAsFailure: true }
  )
}, 180000)
