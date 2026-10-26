import { Beef, LockingScript, Transaction } from '@bsv/sdk'
import type { StorageCreateActionResult } from '../../../sdk/WalletStorage.interfaces'
import type { StorageProvider } from '../../StorageProvider'
import { resumeActionRecoveryPlan, type ActionRecoveryConstruction, type RetainedActionRecoveryPlan } from '../ActionRecoveryPlan'

function fixture() {
  const transaction = new Transaction(1, [], [{ satoshis: 1, lockingScript: LockingScript.fromHex('51') }], 0)
  const funding = new Beef()
  funding.mergeTransaction(transaction)
  const result: StorageCreateActionResult = {
    reference: 'cHJlcGFyZWQ=', derivationPrefix: 'dGVzdA==', version: 1, lockTime: 0,
    inputs: [], outputs: [], inputBeef: new Beef().toBinary()
  }
  const retained: RetainedActionRecoveryPlan = { plan: { result, fundingTxids: [transaction.id('hex')] } }
  const lookup = jest.fn().mockResolvedValue(funding)
  const storage = { getBeefForTransactions: lookup } as unknown as StorageProvider
  const complete = jest.fn(async (value: StorageCreateActionResult) => value)
  const recovery: ActionRecoveryConstruction = {
    protocol: 'wallet-action-recovery-v1', read: jest.fn(), claim: jest.fn(), retain: jest.fn(), complete
  }
  return { retained, storage, recovery, lookup, complete, transaction }
}

test('resumes only exact retained funding roots through the local evidence reader', async () => {
  const { retained, storage, recovery, lookup, complete, transaction } = fixture()
  const result = await resumeActionRecoveryPlan(storage, recovery, retained)
  expect(lookup).toHaveBeenCalledTimes(1)
  expect(lookup).toHaveBeenCalledWith([transaction.id('hex')], {
    trustSelf: undefined, knownTxids: [], ignoreStorage: false, ignoreServices: true, ignoreNewProven: false
  })
  expect(complete).toHaveBeenCalledWith(result)
  expect(result.reference).toBe(retained.plan.result.reference)
  expect(Beef.fromBinaryStrict(result.inputBeef!).findTransactionForSigning(transaction.id('hex'))!.toHex()).toBe(transaction.toHex())
  expect(Beef.fromBinaryStrict(retained.plan.result.inputBeef!).txs).toHaveLength(0)
})

test('returns a completed result without proof reads or completion writes', async () => {
  const { retained, storage, recovery, lookup, complete } = fixture()
  retained.completed = { ...retained.plan.result }
  expect(await resumeActionRecoveryPlan(storage, recovery, retained)).toBe(retained.completed)
  expect(lookup).not.toHaveBeenCalled()
  expect(complete).not.toHaveBeenCalled()
})

test('requires retained BEEF before attempting any evidence or completion work', async () => {
  const { retained, storage, recovery, lookup, complete } = fixture()
  delete retained.plan.result.inputBeef
  await expect(resumeActionRecoveryPlan(storage, recovery, retained)).rejects.toThrow('evidence is missing')
  expect(lookup).not.toHaveBeenCalled()
  expect(complete).not.toHaveBeenCalled()
})

test('completes a fixed-input-only plan without a funding query', async () => {
  const { retained, storage, recovery, lookup, complete } = fixture()
  retained.plan.fundingTxids = []
  expect(await resumeActionRecoveryPlan(storage, recovery, retained)).toEqual({
    ...retained.plan.result, inputBeef: Uint8Array.from(retained.plan.result.inputBeef!)
  })
  expect(lookup).not.toHaveBeenCalled()
  expect(complete).toHaveBeenCalledTimes(1)
})

test('an unavailable retained dependency does not complete or allocate a replacement', async () => {
  const { retained, storage, recovery, lookup, complete } = fixture()
  lookup.mockRejectedValueOnce(new Error('Retained funding proof unavailable'))
  await expect(resumeActionRecoveryPlan(storage, recovery, retained)).rejects.toThrow('Retained funding proof unavailable')
  expect(complete).not.toHaveBeenCalled()
  expect(recovery.claim).not.toHaveBeenCalled()
  expect(recovery.retain).not.toHaveBeenCalled()
})
