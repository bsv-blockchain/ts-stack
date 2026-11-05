import fc from 'fast-check'
import { Beef, LockingScript, Transaction, UnlockingScript } from '@bsv/sdk'
import type { StorageCreateActionResult } from '../../../sdk/WalletStorage.interfaces'
import { _tu } from '../../../../test/utils/TestUtilsWalletStorage'
import { actionRecoveryJSON } from '../ActionRecoveryCodec'
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

test('generated signing transitions retain the first final bytes across reopened stores and reject reordered steps', async () => {
  const context = await _tu.createLegacyWalletSQLiteCopy('generated-recovery-transitions', 'legacy')
  try {
    const store = await SQLiteActionRecoveryStore.install(context.activeStorage)
    let attempt = 0
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 100000 }), fc.boolean(), async (amount, changeLockTime) => {
        const id = String(attempt++)
        const source = new Transaction(1, [], [{ satoshis: amount + 1, lockingScript: LockingScript.fromHex('51') }], 0)
        const sourceBeef = new Beef()
        sourceBeef.mergeTransaction(source)
        const transaction = new Transaction(
          1,
          [
            {
              sourceTransaction: source,
              sourceOutputIndex: 0,
              sequence: 0xffffffff,
              unlockingScript: UnlockingScript.fromHex('')
            }
          ],
          [{ satoshis: amount, lockingScript: LockingScript.fromHex('51') }],
          0
        )
        const result: StorageCreateActionResult = {
          reference: Buffer.from(id).toString('base64'),
          version: 1,
          lockTime: 0,
          derivationPrefix: 'fixture',
          inputBeef: sourceBeef.toBinary(),
          inputs: [
            {
              vin: 0,
              sourceTxid: source.id('hex'),
              sourceVout: 0,
              sourceSatoshis: amount + 1,
              sourceLockingScript: '51',
              unlockingScriptLength: 0,
              providedBy: 'you',
              type: 'custom'
            }
          ],
          outputs: [
            {
              vout: 0,
              lockingScript: '51',
              satoshis: amount,
              outputDescription: 'Generated output',
              tags: [],
              providedBy: 'you'
            }
          ]
        }
        const binding = {
          userId: context.userId,
          walletIdentity: context.identityKey,
          storageIdentity: context.activeStorage.getSettings().storageIdentityKey,
          chain: context.chain,
          originator: 'property-fixture.local',
          operationId: id,
          requestJSON: actionRecoveryJSON({ amount })
        }
        const reopen = async () => (await SQLiteActionRecoveryStore.open(context.activeStorage)).operation(binding)
        let operation = await store.operation(binding)
        const prepared = transaction.toAtomicBEEF(),
          digest = transaction.id('hex')
        await expect(operation.retainPrepared(prepared)).rejects.toThrow('funding is not complete')
        await context.activeStorage.transaction(async trx => {
          await operation.claim(trx)
          await operation.retain({ result, fundingTxids: [] }, trx)
        })
        await expect(operation.retainPrepared(prepared)).rejects.toThrow('funding is not complete')
        await operation.complete(result)
        operation = await reopen()
        expect(await operation.signingState()).toEqual({ processed: false })
        await expect(operation.retainFinal(digest, prepared)).rejects.toThrow('signable transaction is absent')
        await expect(operation.markProcessed(digest)).rejects.toThrow('final transaction is absent')
        expect(await operation.retainPrepared(prepared)).toEqual(prepared)
        const changed = Transaction.fromAtomicBEEF(prepared)
        if (changeLockTime) changed.lockTime++
        else changed.outputs[0].satoshis++
        await expect(operation.retainFinal(digest, changed.toAtomicBEEF())).rejects.toThrow('changed funded layout')
        transaction.inputs[0].unlockingScript = UnlockingScript.fromHex('51')
        const final = transaction.toAtomicBEEF()
        expect(await operation.retainFinal(digest, final)).toEqual(final)
        operation = await reopen()
        transaction.inputs[0].unlockingScript = UnlockingScript.fromHex('5253')
        expect(await operation.retainFinal(digest, transaction.toAtomicBEEF())).toEqual(final)
        const otherDigest = digest === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64)
        await expect(operation.retainFinal(otherDigest, final)).rejects.toThrow('signing request conflicts')
        await expect(operation.markProcessed(otherDigest)).rejects.toThrow('final transaction is absent')
        await operation.markProcessed(digest)
        operation = await reopen()
        expect(await operation.signingState()).toEqual({ prepared, final: { digest, beef: final }, processed: true })
        await operation.markProcessed(digest)
        expect((await store.metadata()).usedRecords).toBe(attempt)
      })
    )
  } finally {
    await context.wallet.destroy()
  }
}, 120000)
