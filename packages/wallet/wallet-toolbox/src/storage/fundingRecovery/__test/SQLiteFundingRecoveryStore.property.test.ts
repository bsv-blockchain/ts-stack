import fc from 'fast-check'
import { outputPacketDigest } from '@bsv/sdk'
import { _tu } from '../../../../test/utils/TestUtilsWalletStorage'
import { SQLiteFundingRecoveryStore } from '../SQLiteFundingRecoveryStore'
import { fundingFixture } from '../__tests__/fundingFixture'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH

fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns) ? Math.max(MIN_PROPERTY_RUNS, requestedRuns) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

test('generated retries retain one claim and cannot reassign its funding or erase a rejected fence', async () => {
  const context = await _tu.createLegacyWalletSQLiteCopy('funding-store-property', 'legacy')
  try {
    const fixture = fundingFixture(context), store = await SQLiteFundingRecoveryStore.install(context.activeStorage, fixture.chain)
    const rejected = new Set<number>(), retained = new Set<number>()
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 50 }), fc.boolean(), async (identity, reject) => {
      fixture.tx.lockTime = identity
      const operation = fixture.operation(), hook = await store.retain(context.userId, context.identityKey, operation)
      retained.add(identity)
      if (reject) { await hook.reject(); rejected.add(identity) }
      const other = { ...operation, acquisitionId: 'b2'.repeat(32) }
      other.id = outputPacketDigest('wallet-funding', { seller: other.seller, acquisitionId: other.acquisitionId, funding: other.funding })
      await expect(store.retain(context.userId, context.identityKey, other)).rejects.toThrow('already assigned')
      const reopened = await SQLiteFundingRecoveryStore.open(context.activeStorage, fixture.chain)
      expect((await reopened.getInternalization(context.userId, context.identityKey, operation.id)).state).toBe(rejected.has(identity) ? 'rejected' : 'unknown')
      expect((await context.activeStorage.knex('wallet_funding_recovery_metadata_v1').first()).usedRecords).toBe(retained.size)
      expect(await context.activeStorage.findOutputs({ partial: { txid: operation.funding.txid } })).toHaveLength(0)
    }))
  } finally { await context.wallet.destroy() }
}, 120000)
