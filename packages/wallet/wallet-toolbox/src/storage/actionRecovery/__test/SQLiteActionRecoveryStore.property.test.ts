import fc from 'fast-check'
import { Beef, LockingScript, Transaction } from '@bsv/sdk'
import type { StorageCreateActionResult } from '../../../sdk/WalletStorage.interfaces'
import { _tu } from '../../../../test/utils/TestUtilsWalletStorage'
import { actionRecoveryJSON, encodeActionRecoveryResult } from '../ActionRecoveryCodec'
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

test('generated recovery claims atomically retain or roll back plans and never replace the first result', async () => {
  const context = await _tu.createLegacyWalletSQLiteCopy('generated-recovery-records', 'legacy')
  try {
    const store = await SQLiteActionRecoveryStore.install(context.activeStorage)
    let attempt = 0, committed = 0
    await fc.assert(fc.asyncProperty(fc.boolean(), fc.integer({ min: 1, max: 100000 }), async (rollback, amount) => {
      const id = String(attempt++)
      const source = new Transaction(1, [], [{ satoshis: amount + 1, lockingScript: LockingScript.fromHex('51') }], 0)
      const beef = new Beef(); beef.mergeTransaction(source)
      const result: StorageCreateActionResult = { reference: Buffer.from(id).toString('base64'), version: 1, lockTime: 0, derivationPrefix: 'fixture', inputBeef: beef.toBinary(),
        inputs: [{ vin: 0, sourceTxid: source.id('hex'), sourceVout: 0, sourceSatoshis: amount + 1, sourceLockingScript: '51', unlockingScriptLength: 0, providedBy: 'you', type: 'custom' }],
        outputs: [{ vout: 0, lockingScript: '51', satoshis: amount, outputDescription: 'Generated output', tags: [], providedBy: 'you' }] }
      const binding = { userId: context.userId, walletIdentity: context.identityKey, storageIdentity: context.activeStorage.getSettings().storageIdentityKey,
        chain: context.chain, originator: 'property-fixture.local', operationId: id, requestJSON: actionRecoveryJSON({ amount }) }
      const operation = await store.operation(binding)
      const encoded = encodeActionRecoveryResult(result)
      const run = context.activeStorage.transaction(async trx => {
        expect(await operation.claim(trx)).toBeUndefined()
        await operation.retain({ result, fundingTxids: [] }, trx)
        if (rollback) throw new Error('generated rollback')
      })
      if (rollback) {
        await expect(run).rejects.toThrow('generated rollback')
        expect(await operation.read()).toBeUndefined()
      } else {
        await run; committed++
        expect(encodeActionRecoveryResult(await operation.complete(result))).toBe(encoded)
        const reopened = await SQLiteActionRecoveryStore.open(context.activeStorage)
        expect(encodeActionRecoveryResult((await (await reopened.operation(binding)).read())!.completed!)).toBe(encoded)
        result.outputs[0].satoshis++
        await expect(operation.complete(result)).rejects.toThrow('changed funding plan')
      }
      expect((await store.metadata()).usedRecords).toBe(committed)
    }))
  } finally { await context.wallet.destroy() }
}, 120000)
