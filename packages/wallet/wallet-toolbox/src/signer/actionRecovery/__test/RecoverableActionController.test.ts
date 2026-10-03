import { Beef, Transaction, type CreateActionArgs } from '@bsv/sdk'
import { _tu, type TestWalletNoSetup } from '../../../../test/utils/TestUtilsWalletStorage'
import { SQLiteActionRecoveryStore } from '../../../storage/actionRecovery/SQLiteActionRecoveryStore'
import { RecoverableActionController } from '../RecoverableActionController'
import * as transactionSigning from '../../methods/completeSignedTransaction'
import * as scriptVerification from '../../methods/verifyUnlockScripts'

describe('retained noSend action signing', () => {
  let context: TestWalletNoSetup
  let store: SQLiteActionRecoveryStore
  let controller: RecoverableActionController
  const request: CreateActionArgs = {
    description: 'Recoverable signing fixture',
    outputs: [{ lockingScript: '51', satoshis: 10, outputDescription: 'Synthetic signing output' }],
    options: { noSend: true, signAndProcess: false, randomizeOutputs: false, returnTXIDOnly: false }
  }

  beforeEach(async () => {
    context = await _tu.createLegacyWalletSQLiteCopy(expect.getState().currentTestName!, 'legacy')
    store = await SQLiteActionRecoveryStore.install(context.activeStorage)
    controller = new RecoverableActionController(context.wallet, store, 'recovery-fixture.local')
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    await context?.wallet.destroy()
  })

  test('describes the actual independently installed local action owner without exposing mutable configuration', () => {
    const expected = {
      protocol: 'wallet-action-recovery-v1',
      walletIdentity: context.wallet.identityKey,
      storageIdentity: context.activeStorage.getSettings().storageIdentityKey,
      chain: context.wallet.chain,
      originator: 'recovery-fixture.local'
    }
    const first = controller.configuration()
    expect(first).toEqual(expected)
    first.originator = 'changed-by-caller.local'
    expect(controller.configuration()).toEqual(expected)
  })

  function changeAtomicLayout(bytes: number[]): number[] {
    const beef = Beef.fromBinaryStrict(bytes)
    const tx = Transaction.fromAtomicBEEF(bytes)
    tx.lockTime += 1
    beef.mergeTransaction(tx)
    return beef.toBinaryAtomic(tx.id('hex'))
  }

  test('requires a named originator, the active provider and a committed workspace', async () => {
    for (const originator of [undefined, null, 1])
      expect(() => new RecoverableActionController(context.wallet, store, originator as unknown as string)).toThrow('explicit action recovery originator')
    expect(() => new RecoverableActionController(context.wallet, store, '')).toThrow('originator parameter must be at least 1')
    const otherStore = Object.create(store) as SQLiteActionRecoveryStore
    Object.defineProperty(otherStore, 'storage', { value: Object.create(context.activeStorage) })
    const inactive = new RecoverableActionController(context.wallet, otherStore, 'recovery-fixture.local')
    await expect(inactive.recover('one', request)).rejects.toThrow('not the active wallet provider')
    jest.spyOn(context.wallet.actionBatch, 'hasWorkspace', 'get').mockReturnValueOnce(true)
    await expect(controller.prepare('one', request)).rejects.toThrow('separate committed wallet workspace')
    expect((await store.metadata()).usedRecords).toBe(0)
  })

  test('prepares and finalizes actual wallet inputs, retaining the same final transaction on recovery', async () => {
    const broadcast = jest.spyOn(context.activeStorage, 'attemptToPostReqsToNetwork').mockRejectedValue(new Error('No broadcast allowed'))
    const authorization = jest.spyOn(context.wallet.storage, 'getAuth')
    const prepared = await controller.prepare('one', request)
    expect(authorization).toHaveBeenCalledWith(true)
    const unsigned = Transaction.fromAtomicBEEF(prepared.signableTransaction!.tx)
    expect(unsigned.outputs.length).toBeGreaterThan(1)
    expect(prepared.noSendChange).toEqual(unsigned.outputs.slice(1).map((_, index) => `${unsigned.id('hex')}.${index + 1}`))
    const reference = prepared.signableTransaction!.reference
    const final = await controller.finalize('one', request, { reference, spends: {} })
    const transaction = Transaction.fromAtomicBEEF(final.tx!)
    expect(final.txid).toBe(transaction.id('hex'))
    expect(transaction.inputs.length).toBeGreaterThan(0)
    expect(transaction.inputs.every(input => input.unlockingScript!.toBinary().length > 0)).toBe(true)
    const stored = await context.activeStorage.findTransactions({ partial: { userId: context.userId, reference } })
    expect(stored).toHaveLength(1)
    expect(stored[0].status).toBe('nosend')
    jest.spyOn(context.wallet, 'getClientChangeKeyPair').mockImplementation(() => { throw new Error('Must not sign again') })
    const reopened = new RecoverableActionController(context.wallet, await SQLiteActionRecoveryStore.open(context.activeStorage), 'recovery-fixture.local')
    expect(await reopened.recover('one', request)).toEqual({ state: 'finalized', result: final })
    expect(await reopened.finalize('one', request, { reference, spends: {} })).toEqual(final)
    expect(broadcast).not.toHaveBeenCalled()
  })

  test('does not fund an absent operation during recovery', async () => {
    const allocate = jest.spyOn(context.activeStorage, 'insertTransaction')
    expect(await controller.recover('absent', request)).toEqual({ state: 'absent' })
    expect(allocate).not.toHaveBeenCalled()
  })

  test('recovers a lost prepared response without a second allocation', async () => {
    const original = store.operation.bind(store)
    let reference: string | undefined
    jest.spyOn(store, 'operation').mockImplementationOnce(async binding => {
      const operation = await original(binding)
      const retain = operation.retainPrepared.bind(operation)
      jest.spyOn(operation, 'retainPrepared').mockImplementationOnce(async bytes => {
        const result = await retain(bytes)
        reference = (await operation.read())!.completed!.reference
        expect(result.length).toBeGreaterThan(0)
        throw new Error('prepared response lost')
      })
      return operation
    })
    await expect(controller.prepare('one', request)).rejects.toThrow('prepared response lost')
    const allocate = jest.spyOn(context.activeStorage, 'insertTransaction')
    const recovered = await controller.recover('one', request)
    expect(recovered.state).toBe('prepared')
    if (recovered.state !== 'prepared') throw new Error('Expected preparation')
    expect(recovered.result.signableTransaction!.reference).toBe(reference)
    expect(allocate).not.toHaveBeenCalled()
  })

  test('retains final bytes before processing and recovers them without signing again', async () => {
    const prepared = await controller.prepare('one', request)
    const reference = prepared.signableTransaction!.reference
    const process = jest.spyOn(context.activeStorage, 'processAction').mockRejectedValueOnce(new Error('processing interrupted'))
    await expect(controller.finalize('one', request, { reference, spends: {} })).rejects.toThrow('processing interrupted')
    const attempted = process.mock.calls[0][1]
    expect(attempted).toMatchObject({ isNewTx: true, isSendWith: false, isNoSend: true, isDelayed: false, sendWith: [] })
    jest.spyOn(context.wallet, 'getClientChangeKeyPair').mockImplementation(() => { throw new Error('Must not sign again') })
    const recovered = await controller.recover('one', request)
    expect(recovered.state).toBe('finalized')
    if (recovered.state !== 'finalized') throw new Error('Expected finalization')
    expect(recovered.result.txid).toBe(attempted.txid)
    expect(Transaction.fromAtomicBEEF(recovered.result.tx!).toHex()).toBe(Buffer.from(attempted.rawTx!).toString('hex'))
  })

  test('reconciles a processing commit whose response is lost using exact stored bytes', async () => {
    const prepared = await controller.prepare('one', request)
    const reference = prepared.signableTransaction!.reference
    const original = context.activeStorage.processAction.bind(context.activeStorage)
    const process = jest.spyOn(context.activeStorage, 'processAction').mockImplementationOnce(async (...args) => {
      await original(...args)
      throw new Error('committed response lost')
    })
    const final = await controller.finalize('one', request, { reference, spends: {} })
    expect(final.txid).toBe(process.mock.calls[0][1].txid)
    expect(await controller.recover('one', request)).toEqual({ state: 'finalized', result: final })
    expect(process).toHaveBeenCalledTimes(1)
  })

  test('rejects another reference, changed signing request and broadcast options', async () => {
    const prepared = await controller.prepare('one', request)
    const reference = prepared.signableTransaction!.reference
    await expect(controller.finalize('one', request, { reference: 'Zm9yZWlnbg==', spends: {} })).rejects.toThrow('reference mismatch')
    await expect(controller.finalize('one', request, { reference, spends: {}, options: { noSend: false } })).rejects.toThrow('noSend')
    await controller.finalize('one', request, { reference, spends: {} })
    await expect(controller.finalize('one', request, { reference, spends: { 0: { unlockingScript: '00' } } })).rejects.toThrow('conflicts')
  })

  test('refuses to sign after the underlying allocation is cancelled', async () => {
    const prepared = await controller.prepare('one', request)
    const reference = prepared.signableTransaction!.reference
    await context.wallet.abortAction({ reference })
    const signer = jest.spyOn(context.wallet, 'getClientChangeKeyPair')
    await expect(controller.finalize('one', request, { reference, spends: {} })).rejects.toThrow('no longer available')
    expect(signer).not.toHaveBeenCalled()
  })

  test('rejects a missing allocation before invoking the signer', async () => {
    const prepared = await controller.prepare('one', request)
    const find = jest.spyOn(context.activeStorage, 'findTransactions').mockResolvedValueOnce([])
    const signer = jest.spyOn(transactionSigning, 'completeSignedTransaction')
    await expect(controller.finalize('one', request, { reference: prepared.signableTransaction!.reference, spends: {} })).rejects.toThrow('no longer available')
    expect(find).toHaveBeenCalledWith({ partial: { userId: context.userId, reference: prepared.signableTransaction!.reference }, noRawTx: true })
    expect(signer).not.toHaveBeenCalled()
  })

  test('rejects retained preparation or signer output that changes the funded transaction', async () => {
    const prepared = await controller.prepare('one', request)
    const signing = { reference: prepared.signableTransaction!.reference, spends: {} }
    const open = store.operation.bind(store)
    jest.spyOn(store, 'operation').mockImplementationOnce(async binding => {
      const operation = await open(binding)
      const state = await operation.signingState()
      jest.spyOn(operation, 'signingState').mockResolvedValueOnce({ ...state, prepared: changeAtomicLayout(state.prepared!) })
      return operation
    })
    const signer = jest.spyOn(transactionSigning, 'completeSignedTransaction')
    await expect(controller.finalize('one', request, signing)).rejects.toThrow('Recovered signable transaction changed')
    expect(signer).not.toHaveBeenCalled()
    signer.mockImplementationOnce(async prior => { prior.tx.lockTime += 1; return prior.tx })
    await expect(controller.finalize('one', request, signing)).rejects.toThrow('Final action changed funded layout')
    expect((await controller.recover('one', request)).state).toBe('prepared')
  })

  test('requires every input verification before retaining final bytes and again on recovery', async () => {
    const prepared = await controller.prepare('one', request)
    const signing = { reference: prepared.signableTransaction!.reference, spends: {} }
    const count = Transaction.fromAtomicBEEF(prepared.signableTransaction!.tx).inputs.length
    const verify = jest.spyOn(scriptVerification, 'verifyUnlockScripts')
    for (const result of [{ verifiedInputs: count, skippedInputs: 1 }, { verifiedInputs: count - 1, skippedInputs: 0 }]) {
      verify.mockResolvedValueOnce(result)
      await expect(controller.finalize('one', request, signing)).rejects.toThrow('Full input evidence is required')
      expect((await controller.recover('one', request)).state).toBe('prepared')
    }
    const final = await controller.finalize('one', request, signing)
    for (const result of [{ verifiedInputs: count, skippedInputs: 1 }, { verifiedInputs: count - 1, skippedInputs: 0 }]) {
      verify.mockResolvedValueOnce(result)
      await expect(controller.recover('one', request)).rejects.toThrow('Retained final action lacks complete valid inputs')
    }
    expect(await controller.recover('one', request)).toEqual({ state: 'finalized', result: final })
  })

  test('refuses recovery when retained funding or prepared layout disappears during processing', async () => {
    const prepared = await controller.prepare('one', request)
    const final = await controller.finalize('one', request, { reference: prepared.signableTransaction!.reference, spends: {} })
    const open = store.operation.bind(store)
    for (const missing of [true, false]) {
      jest.spyOn(store, 'operation').mockImplementationOnce(async binding => {
        const operation = await open(binding)
        const retained = await operation.read()
        jest.spyOn(operation, 'read').mockResolvedValueOnce(retained).mockResolvedValueOnce(missing ? undefined : { plan: retained!.plan })
        return operation
      })
      await expect(controller.recover('one', request)).rejects.toThrow('Action recovery funding result is absent')
    }
    for (const missing of [true, false]) {
      jest.spyOn(store, 'operation').mockImplementationOnce(async binding => {
        const operation = await open(binding)
        const state = await operation.signingState()
        jest.spyOn(operation, 'signingState').mockResolvedValueOnce(state).mockResolvedValueOnce({ ...state, prepared: missing ? undefined : changeAtomicLayout(state.prepared!) })
        return operation
      })
      await expect(controller.recover('one', request)).rejects.toThrow('Retained final action changed funded layout')
    }
    expect(await controller.recover('one', request)).toEqual({ state: 'finalized', result: final })
  })

  test('reconciles only one exact processed transaction in a supported durable status', async () => {
    const prepared = await controller.prepare('one', request)
    const reference = prepared.signableTransaction!.reference
    const final = await controller.finalize('one', request, { reference, spends: {} })
    const [row] = await context.activeStorage.findTransactions({ partial: { userId: context.userId, reference } })
    const find = jest.spyOn(context.activeStorage, 'findTransactions')
    const process = jest.spyOn(context.activeStorage, 'processAction')
    for (const rows of [[], [row, row]]) {
      find.mockResolvedValueOnce(rows)
      await expect(controller.recover('one', request)).rejects.toThrow('wallet transaction is absent')
    }
    for (const changed of [
      { ...row, txid: '11'.repeat(32) }, { ...row, txid: undefined },
      { ...row, status: 'unsigned' as const }, { ...row, status: 'failed' as const }
    ]) {
      find.mockResolvedValueOnce([changed])
      await expect(controller.recover('one', request)).rejects.toThrow('wallet transaction conflicts')
    }
    for (const status of ['nosend', 'unprocessed', 'sending', 'unproven', 'completed'] as const) {
      find.mockResolvedValueOnce([{ ...row, status }])
      expect(await controller.recover('one', request)).toEqual({ state: 'finalized', result: final })
    }
    expect(process).not.toHaveBeenCalled()
  })

  test('refuses incomplete preparation before requesting wallet signatures', async () => {
    const signer = jest.spyOn(transactionSigning, 'completeSignedTransaction')
    await expect(controller.finalize('absent', request, { reference: 'YWJzZW50', spends: {} })).rejects.toThrow('has not finished preparation')
    const prepared = await controller.prepare('one', request)
    const open = store.operation.bind(store)
    jest.spyOn(store, 'operation').mockImplementationOnce(async binding => {
      const operation = await open(binding)
      jest.spyOn(operation, 'signingState').mockResolvedValueOnce({ processed: false })
      return operation
    })
    await expect(controller.finalize('one', request, { reference: prepared.signableTransaction!.reference, spends: {} })).rejects.toThrow('signable transaction is absent')
    expect(signer).not.toHaveBeenCalled()
  })

  test('rejects incomplete final evidence or another send route before signing', async () => {
    const prepared = await controller.prepare('one', request)
    const reference = prepared.signableTransaction!.reference
    const signer = jest.spyOn(transactionSigning, 'completeSignedTransaction')
    for (const options of [{ returnTXIDOnly: true }, { sendWith: ['11'.repeat(32)] }])
      await expect(controller.finalize('one', request, { reference, spends: {}, options })).rejects.toThrow('full-evidence noSend')
    await expect(controller.finalize('one', request, { reference, spends: { 0: { unlockingScript: '00', sequenceNumber: 1 } } })).rejects.toThrow('changed funded sequence')
    expect(signer).not.toHaveBeenCalled()
  })

  test('owns the original request and signing request before waiting on wallet authorization', async () => {
    const mutable: CreateActionArgs = { ...request, outputs: request.outputs!.map(output => ({ ...output })), options: { ...request.options } }
    const getAuth = context.wallet.storage.getAuth.bind(context.wallet.storage)
    jest.spyOn(context.wallet.storage, 'getAuth').mockImplementationOnce(async (...args) => {
      mutable.outputs![0].satoshis = 99
      return await getAuth(...args)
    })
    const prepared = await controller.prepare('one', mutable)
    expect(Transaction.fromAtomicBEEF(prepared.signableTransaction!.tx).outputs[0].satoshis).toBe(10)
    const signing = { reference: prepared.signableTransaction!.reference, spends: {} }
    jest.spyOn(context.wallet.storage, 'getAuth').mockImplementationOnce(async (...args) => {
      signing.reference = 'Zm9yZWlnbg=='
      return await getAuth(...args)
    })
    const final = await controller.finalize('one', request, signing)
    expect(await controller.recover('one', request)).toEqual({ state: 'finalized', result: final })
    await expect(controller.recover('one', mutable)).rejects.toThrow('conflicts')
  })

  test('does not accept an uncommitted process response and can resume the retained final bytes', async () => {
    const prepared = await controller.prepare('one', request)
    jest.spyOn(context.activeStorage, 'processAction').mockResolvedValueOnce({})
    await expect(controller.finalize('one', request, { reference: prepared.signableTransaction!.reference, spends: {} })).rejects.toThrow('processing has not committed')
    jest.spyOn(context.wallet, 'getClientChangeKeyPair').mockImplementation(() => { throw new Error('Must not sign again') })
    expect((await controller.recover('one', request)).state).toBe('finalized')
  })

  test('requires exact durable raw bytes when the wallet already records the final transaction', async () => {
    const prepared = await controller.prepare('one', request)
    const final = await controller.finalize('one', request, { reference: prepared.signableTransaction!.reference, spends: {} })
    const original = context.activeStorage.getProvenOrRawTx.bind(context.activeStorage)
    const lookup = jest.spyOn(context.activeStorage, 'getProvenOrRawTx')
    lookup.mockImplementation(async (txid, ...args) => txid === final.txid ? {} : await original(txid, ...args))
    await expect(controller.recover('one', request)).rejects.toThrow('Exact processed action bytes are unavailable')
    lookup.mockImplementation(async (txid, ...args) => txid === final.txid ? { rawTx: [0] } : await original(txid, ...args))
    await expect(controller.recover('one', request)).rejects.toThrow('Exact processed action bytes are unavailable')
    lookup.mockRestore()
    expect(await controller.recover('one', request)).toEqual({ state: 'finalized', result: final })
  })

  test('joins simultaneous preparation and finalization without changing the selected transaction', async () => {
    const [one, two] = await Promise.all([controller.prepare('concurrent', request), controller.prepare('concurrent', request)])
    expect(one).toEqual(two)
    const signing = { reference: one.signableTransaction!.reference, spends: {} }
    const finals = await Promise.all([controller.finalize('concurrent', request, signing), controller.finalize('concurrent', request, signing)])
    expect(finals[0]).toEqual(finals[1])
    expect(await controller.recover('concurrent', request)).toEqual({ state: 'finalized', result: finals[0] })
    expect((await store.metadata()).usedRecords).toBe(1)
  })

  test('claims a known fixed input in the allocation transaction and restores it on rollback', async () => {
    const creation: CreateActionArgs = { ...request, outputs: [{ ...request.outputs![0], lockingScript: '7551', basket: 'recovery-test' }] }
    const first = await controller.prepare('source', creation)
    const source = await controller.finalize('source', creation, { reference: first.signableTransaction!.reference, spends: {} })
    const next: CreateActionArgs = { ...request, inputBEEF: source.tx, inputs: [{ outpoint: `${source.txid}.0`, inputDescription: 'Known custom fixture input', unlockingScriptLength: 1 }] }
    const open = store.operation.bind(store)
    jest.spyOn(store, 'operation').mockImplementationOnce(async binding => {
      const operation = await open(binding)
      const retain = operation.retain.bind(operation)
      jest.spyOn(operation, 'retain').mockImplementationOnce(async (plan, trx) => {
        await retain(plan, trx)
        throw new Error('fixed input allocation rollback')
      })
      return operation
    })
    const before = await context.activeStorage.findOutputs({ partial: { userId: context.userId, txid: source.txid, vout: 0 } })
    await expect(controller.prepare('spend-source', next)).rejects.toThrow('fixed input allocation rollback')
    expect(await context.activeStorage.findOutputs({ partial: { userId: context.userId, txid: source.txid, vout: 0 } })).toEqual(before)
    expect(await controller.recover('spend-source', next)).toEqual({ state: 'absent' })
    const prepared = await controller.prepare('spend-source', next)
    const claimed = await context.activeStorage.findOutputs({ partial: { userId: context.userId, txid: source.txid, vout: 0 } })
    expect(claimed[0].spendable).toBe(false)
    expect(claimed[0].spentBy).toBeDefined()
    const final = await controller.finalize('spend-source', next, { reference: prepared.signableTransaction!.reference, spends: { 0: { unlockingScript: '00' } } })
    expect(Transaction.fromAtomicBEEF(final.tx!).inputs[0].sourceTXID).toBe(source.txid)
    const allocations = await context.activeStorage.findTransactions({ partial: { userId: context.userId }, noRawTx: true })
    await expect(controller.prepare('competing-spend', next)).rejects.toThrow('Recoverable action input is already spent')
    expect(await controller.recover('competing-spend', next)).toEqual({ state: 'absent' })
    expect(await context.activeStorage.findTransactions({ partial: { userId: context.userId }, noRawTx: true })).toEqual(allocations)
  })
})
