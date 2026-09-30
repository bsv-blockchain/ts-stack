import fc from 'fast-check'
import { _tu } from '../../../../test/utils/TestUtilsWalletStorage'
import { SQLiteActionRecoveryStore } from '../../../storage/actionRecovery/SQLiteActionRecoveryStore'
import { RecoverableActionController } from '../RecoverableActionController'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH

fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns) ? Math.max(MIN_PROPERTY_RUNS, requestedRuns) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

test('recovery of arbitrary absent operation identities never creates funding or signing state', async () => {
  const context = await _tu.createLegacyWalletSQLiteCopy('generated-absent-recovery', 'legacy')
  try {
    const store = await SQLiteActionRecoveryStore.install(context.activeStorage)
    const controller = new RecoverableActionController(context.wallet, store, 'property-fixture.local')
    const allocate = jest.spyOn(context.activeStorage, 'insertTransaction')
    const sign = jest.spyOn(context.wallet, 'getClientChangeKeyPair')
    await fc.assert(fc.asyncProperty(fc.uuid(), fc.integer({ min: 1, max: 10000 }), async (operationId, satoshis) => {
      const result = await controller.recover(operationId, { description: 'Generated recovery fixture', outputs: [{ lockingScript: '51', satoshis, outputDescription: 'Generated output' }],
        options: { noSend: true, signAndProcess: false, randomizeOutputs: false, returnTXIDOnly: false } })
      expect(result).toEqual({ state: 'absent' })
      expect(allocate).not.toHaveBeenCalled()
      expect(sign).not.toHaveBeenCalled()
      expect((await store.metadata()).usedRecords).toBe(0)
    }))
  } finally { jest.restoreAllMocks(); await context.wallet.destroy() }
}, 120000)
