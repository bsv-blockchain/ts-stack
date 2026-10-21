import { Telemetry, Transaction, type CreateActionArgs } from '@bsv/sdk'
import * as scriptVerification from '../../methods/verifyUnlockScripts'
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

test('generated authorization delays never produce a second payment or lose the retained first final', async () => {
  const context = await _tu.createLegacyWalletSQLiteCopy('generated-signing-authority', 'legacy')
  try {
    const store = await SQLiteActionRecoveryStore.install(context.activeStorage)
    const controller = new RecoverableActionController(context.wallet, store, 'generated-authority.local')
    const request: CreateActionArgs = { description: 'Generated local authority fixture', outputs: [{ lockingScript: '51', satoshis: 10, outputDescription: 'Synthetic output' }],
      options: { noSend: true, signAndProcess: false, randomizeOutputs: false, returnTXIDOnly: false } }
    const first = await controller.prepare('original', request)
    const signing = { reference: first.signableTransaction!.reference, spends: {} }
    const allocate = jest.spyOn(context.activeStorage, 'insertTransaction')
    const broadcast = jest.spyOn(context.activeStorage, 'attemptToPostReqsToNetwork').mockRejectedValue(new Error('Never broadcast'))
    let now = 0, deadline = 0, phase = '', lag = 0, suspended = false
    const delay = async (name: string): Promise<void> => {
      if (!suspended && phase === name) { await Promise.resolve(); now = deadline + lag; suspended = true }
    }
    const auth = context.wallet.storage.getAuth.bind(context.wallet.storage)
    jest.spyOn(context.wallet.storage, 'getAuth').mockImplementation(async (...args) => { const value = await auth(...args); await delay('auth'); return value })
    const telemetry = new Telemetry({ sink: { capture: () => undefined } })
    Object.defineProperty(context.wallet, 'telemetry', { value: telemetry })
    const withSpan = telemetry.withSpan.bind(telemetry)
    jest.spyOn(telemetry, 'withSpan').mockImplementation(async (name, options, work) => { await delay(name); return await withSpan(name, options, work) })
    const verify = scriptVerification.verifyUnlockScripts
    jest.spyOn(scriptVerification, 'verifyUnlockScripts').mockImplementation(async (...args) => { const value = await verify(...args); await delay('verification'); return value })
    const guard = (): void => { if (now >= deadline) throw new Error('Original deadline expired') }
    await fc.assert(fc.asyncProperty(
      fc.constantFrom('auth', 'wallet.crypto.client_change_key', 'wallet.crypto.derive_unlocking_templates', 'wallet.crypto.transaction_sign', 'verification'),
      fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 0, max: 10000 }),
      async (selected, time, elapsed) => {
        phase = selected; now = time - 1; deadline = time; lag = elapsed; suspended = false
        await expect(controller.finalize('original', request, signing, guard)).rejects.toThrow('Original deadline expired')
        expect(suspended).toBe(true)
        const status = await controller.recover('original', request)
        expect(status.state).toBe('prepared')
        if (status.state !== 'prepared') throw new Error('No new final may be retained')
        expect(status.result.signableTransaction!.reference).toBe(signing.reference)
        expect(Transaction.fromAtomicBEEF(status.result.signableTransaction!.tx).toHex()).toBe(Transaction.fromAtomicBEEF(first.signableTransaction!.tx).toHex())
        expect((await store.metadata()).usedRecords).toBe(1)
        expect(allocate).not.toHaveBeenCalled(); expect(broadcast).not.toHaveBeenCalled()
      }
    ))
    phase = ''; now = 0; deadline = 1
    const final = await controller.finalize('original', request, signing, guard)
    now = 1
    const keys = jest.spyOn(context.wallet, 'getClientChangeKeyPair').mockImplementation(() => { throw new Error('Never sign a replacement') })
    await expect(controller.finalize('original', request, signing, guard)).resolves.toEqual(final)
    await expect(controller.recover('original', request)).resolves.toEqual({ state: 'finalized', result: final })
    expect(keys).not.toHaveBeenCalled(); expect(allocate).not.toHaveBeenCalled(); expect(broadcast).not.toHaveBeenCalled()
  } finally { jest.restoreAllMocks(); await context.wallet.destroy() }
}, 120000)
