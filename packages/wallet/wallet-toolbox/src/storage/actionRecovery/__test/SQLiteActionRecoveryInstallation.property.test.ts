import fc from 'fast-check'
import { _tu } from '../../../../test/utils/TestUtilsWalletStorage'
import { SQLiteActionRecoveryStore } from '../SQLiteActionRecoveryStore'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH

fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns) ? Math.max(MIN_PROPERTY_RUNS, requestedRuns) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

test('generated installation capacities belong to durable state rather than mutable caller objects', async () => {
  const context = await _tu.createLegacyWalletSQLiteCopy('generated-recovery-installation', 'legacy')
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4095 }),
        fc.integer({ min: 1, max: 67108863 }),
        async (records, bytes) => {
          const db = context.activeStorage.knex
          await db.schema.dropTableIfExists('wallet_action_recovery_v1')
          await db.schema.dropTableIfExists('wallet_action_recovery_metadata_v1')
          const limits = { records, bytes }
          const installing = SQLiteActionRecoveryStore.install(context.activeStorage, limits)
          limits.records++
          limits.bytes++
          const store = await installing
          expect(await store.metadata()).toMatchObject({
            maximumRecords: records,
            maximumBytes: bytes,
            usedRecords: 0,
            usedBytes: 0
          })
          const reopened = await SQLiteActionRecoveryStore.open(context.activeStorage)
          expect(await reopened.metadata()).toEqual(await store.metadata())
          await expect(SQLiteActionRecoveryStore.install(context.activeStorage, limits)).rejects.toThrow('differs')
          await expect(
            SQLiteActionRecoveryStore.install(context.activeStorage, { records, bytes })
          ).resolves.toBeInstanceOf(SQLiteActionRecoveryStore)
          expect(await store.metadata()).toEqual(await reopened.metadata())
        }
      )
    )
  } finally {
    await context.wallet.destroy()
  }
}, 120000)
