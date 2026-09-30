import fc from 'fast-check'
import { _tu } from '../../../../test/utils/TestUtilsWalletStorage'
import { SQLiteFundingRecoveryStore } from '../../../storage/fundingRecovery/SQLiteFundingRecoveryStore'
import { fundingFixture } from '../../../storage/fundingRecovery/__tests__/fundingFixture'
import { RecoverableFundingController } from '../RecoverableFundingController'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH

fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns) ? Math.max(MIN_PROPERTY_RUNS, requestedRuns) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

test('generated exact payments or duplicate scripts produce one stable receipt or a no-effect rejection', async () => {
  const context = await _tu.createLegacyWalletSQLiteCopy('funding-controller-property', 'legacy')
  try {
    const fixture = fundingFixture(context)
    jest.spyOn(context.services, 'getChainTracker').mockResolvedValue(fixture.tracker)
    const store = await SQLiteFundingRecoveryStore.install(context.activeStorage, fixture.chain)
    const controller = new RecoverableFundingController(context.wallet, store)
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 50 }), fc.boolean(), async (amount, duplicate) => {
      fixture.tx.outputs.length = 2
      fixture.tx.outputs[0].satoshis = 1000 - amount - (duplicate ? 1 : 0)
      fixture.tx.outputs[1].satoshis = amount
      if (duplicate) fixture.tx.outputs.push({ ...fixture.tx.outputs[1], satoshis: 1 })
      const operation = { ...fixture.operation(), satoshis: String(amount) }
      const first = await controller.internalizeOnce(operation)
      expect(first.state).toBe(duplicate ? 'rejected' : 'accepted')
      expect(await controller.internalizeOnce(operation)).toEqual(first)
      expect(await controller.getInternalization(operation.id)).toEqual(first)
      const outputs = await context.activeStorage.findOutputs({ partial: { userId: context.userId, txid: operation.funding.txid } })
      expect(outputs).toHaveLength(duplicate ? 0 : 1)
      if (!duplicate) expect(outputs[0].satoshis).toBe(amount)
    }))
  } finally { jest.restoreAllMocks(); await context.wallet.destroy() }
}, 120000)
