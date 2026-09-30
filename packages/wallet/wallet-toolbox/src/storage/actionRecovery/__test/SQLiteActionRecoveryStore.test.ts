import { Beef, Transaction, UnlockingScript, Validation, type CreateActionArgs } from '@bsv/sdk'
import { _tu, type TestWalletNoSetup } from '../../../../test/utils/TestUtilsWalletStorage'
import { createAction } from '../../methods/createAction'
import { actionRecoveryJSON, decodeActionRecoveryResult, encodeActionRecoveryResult } from '../ActionRecoveryCodec'
import { SQLiteActionRecoveryStore } from '../SQLiteActionRecoveryStore'
import { buildSignableTransaction } from '../../../signer/methods/buildSignableTransaction'
import { WalletLogger } from '../../../WalletLogger'

describe('local recoverable funding allocation', () => {
  let context: TestWalletNoSetup
  const request: CreateActionArgs = {
    description: 'Recoverable allocation fixture',
    outputs: [{ lockingScript: '51', satoshis: 10, outputDescription: 'Synthetic test output' }],
    options: { noSend: true, signAndProcess: false, randomizeOutputs: false, returnTXIDOnly: false }
  }

  beforeEach(async () => {
    context = await _tu.createLegacyWalletSQLiteCopy(expect.getState().currentTestName!, 'legacy')
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    await context?.wallet.destroy()
  })

  function binding(operationId = 'operation-one', body: CreateActionArgs = request) {
    return {
      userId: context.userId,
      walletIdentity: context.identityKey,
      storageIdentity: context.activeStorage.getSettings().storageIdentityKey,
      chain: context.chain,
      originator: 'recovery-fixture.local',
      operationId,
      requestJSON: actionRecoveryJSON(body)
    }
  }

  function args() {
    const validated = Validation.validateCreateActionArgs({ ...request, outputs: request.outputs!.map(output => ({ ...output })), options: { ...request.options } })
    validated.includeAllSourceTransactions = true
    return validated
  }

  function auth() {
    return { userId: context.userId, identityKey: context.identityKey, isActive: true }
  }

  test('rejects an unsupported recovery protocol before reading or allocating', async () => {
    const store = await SQLiteActionRecoveryStore.install(context.activeStorage)
    const operation = await store.operation(binding())
    Object.defineProperty(operation, 'protocol', { value: 'wallet-action-recovery-unknown' })
    const read = jest.spyOn(operation, 'read')
    const allocate = jest.spyOn(context.activeStorage, 'insertTransaction')
    await expect(createAction(context.activeStorage, auth(), args(), undefined, operation)).rejects.toThrow('Unsupported action recovery construction')
    expect(read).not.toHaveBeenCalled()
    expect(allocate).not.toHaveBeenCalled()
  })

  test('preserves legacy failed-record behavior when ordinary allocation rolls back', async () => {
    const validated = args()
    validated.logger = new WalletLogger()
    const before = await context.activeStorage.findTransactions({ partial: { userId: context.userId }, noRawTx: true })
    jest.spyOn(context.activeStorage, 'insertOutputs').mockRejectedValueOnce(new Error('ordinary output write interrupted'))
    await expect(createAction(context.activeStorage, auth(), validated)).rejects.toThrow('ordinary output write interrupted')
    const after = await context.activeStorage.findTransactions({ partial: { userId: context.userId }, noRawTx: true })
    const added = after.filter(row => !before.some(old => old.transactionId === row.transactionId))
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({ status: 'failed', description: request.description })
    expect(validated.logger.logs.some(entry => entry.log.includes('recorded failed createAction transaction'))).toBe(true)
  })

  test('preserves legacy failed status when ordinary assembly fails after allocation commit', async () => {
    const validated = args()
    validated.logger = new WalletLogger()
    const update = jest.spyOn(context.activeStorage, 'updateTransactionStatus')
    jest.spyOn(context.activeStorage, 'getRawTxOfKnownValidTransaction').mockRejectedValueOnce(new Error('ordinary source read interrupted'))
    await expect(createAction(context.activeStorage, auth(), validated)).rejects.toThrow('ordinary source read interrupted')
    expect(update).toHaveBeenCalledWith('failed', expect.any(Number))
    const transactionId = update.mock.calls.find(call => call[0] === 'failed')![1]
    const rows = await context.activeStorage.findTransactions({ partial: { userId: context.userId, transactionId } })
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('failed')
    expect(validated.logger.logs.some(entry => entry.log.includes('marked failed createAction transaction'))).toBe(true)
  })

  test('requires explicit installation and preserves immutable configured capacity', async () => {
    await expect(SQLiteActionRecoveryStore.open(context.activeStorage)).rejects.toThrow()
    await SQLiteActionRecoveryStore.install(context.activeStorage, { records: 2, bytes: 1048576 })
    await expect(SQLiteActionRecoveryStore.open(context.activeStorage)).resolves.toBeInstanceOf(SQLiteActionRecoveryStore)
    await expect(SQLiteActionRecoveryStore.install(context.activeStorage)).rejects.toThrow('differs')
  })

  test('returns the original completed funding result across new store instances without another allocation', async () => {
    const store = await SQLiteActionRecoveryStore.install(context.activeStorage)
    const operation = await store.operation(binding())
    const first = await createAction(context.activeStorage, auth(), args(), undefined, operation)
    const allocate = jest.spyOn(context.activeStorage, 'insertTransaction')
    const reopened = await SQLiteActionRecoveryStore.open(context.activeStorage)
    const writeTransaction = jest.spyOn(context.activeStorage, 'transaction')
    const second = await createAction(context.activeStorage, auth(), args(), undefined, await reopened.operation(binding()))
    expect(encodeActionRecoveryResult(second)).toBe(encodeActionRecoveryResult(first))
    expect(allocate).not.toHaveBeenCalled()
    expect(writeTransaction).not.toHaveBeenCalled()
    expect((await operation.read())?.completed?.reference).toBe(first.reference)
  })

  test('keeps the allocated plan after completion fails and resumes the same reference', async () => {
    const store = await SQLiteActionRecoveryStore.install(context.activeStorage)
    const operation = await store.operation(binding())
    const validated = args()
    validated.logger = new WalletLogger()
    jest.spyOn(operation, 'complete').mockRejectedValueOnce(new Error('completion interrupted'))
    await expect(createAction(context.activeStorage, auth(), validated, undefined, operation)).rejects.toThrow('completion interrupted')
    expect(validated.logger.logs.some(entry => entry.log === 'retained recoverable allocation after evidence completion error')).toBe(true)
    const retained = await operation.read()
    expect(retained?.completed).toBeUndefined()
    expect(retained?.plan.result.reference).toBeTruthy()
    const transactions = await context.activeStorage.findTransactions({ partial: { userId: context.userId, reference: retained!.plan.result.reference } })
    expect(transactions).toHaveLength(1)
    expect(transactions[0].status).toBe('unsigned')
    const allocate = jest.spyOn(context.activeStorage, 'insertTransaction')
    const resumed = await createAction(context.activeStorage, auth(), args(), undefined, await store.operation(binding()))
    expect(resumed.reference).toBe(retained!.plan.result.reference)
    expect(allocate).not.toHaveBeenCalled()
  })

  test('rolls back wallet allocation and the operation claim together before commit', async () => {
    const store = await SQLiteActionRecoveryStore.install(context.activeStorage)
    const operation = await store.operation(binding())
    const original = operation.retain.bind(operation)
    jest.spyOn(operation, 'retain').mockImplementationOnce(async (plan, trx) => {
      await original(plan, trx)
      throw new Error('before allocation commit')
    })
    const before = await context.activeStorage.findTransactions({ partial: { userId: context.userId }, noRawTx: true })
    await expect(createAction(context.activeStorage, auth(), args(), undefined, operation)).rejects.toThrow('before allocation commit')
    expect(await operation.read()).toBeUndefined()
    const after = await context.activeStorage.findTransactions({ partial: { userId: context.userId }, noRawTx: true })
    expect(after).toEqual(before)
    expect((await store.metadata()).usedRecords).toBe(0)
    expect((await createAction(context.activeStorage, auth(), args(), undefined, operation)).reference).toBeTruthy()
  })

  test('joins concurrent callers at one operation and rejects a different request under that ID', async () => {
    const store = await SQLiteActionRecoveryStore.install(context.activeStorage)
    const one = await store.operation(binding()), two = await store.operation(binding())
    const [first, second] = await Promise.all([
      createAction(context.activeStorage, auth(), args(), undefined, one),
      createAction(context.activeStorage, auth(), args(), undefined, two)
    ])
    expect(encodeActionRecoveryResult(first)).toBe(encodeActionRecoveryResult(second))
    expect((await store.metadata()).usedRecords).toBe(1)
    const changed = await store.operation(binding('operation-one', { ...request, description: 'Different operation request' }))
    await expect(createAction(context.activeStorage, auth(), args(), undefined, changed)).rejects.toThrow('conflicts')
  })

  test('rejects changed funding descriptors when completing a retained plan', async () => {
    const store = await SQLiteActionRecoveryStore.install(context.activeStorage)
    const operation = await store.operation(binding())
    const result = await createAction(context.activeStorage, auth(), args(), undefined, operation)
    const changed = decodeActionRecoveryResult(encodeActionRecoveryResult(result))
    changed.outputs[0].satoshis += 1
    await expect(operation.complete(changed)).rejects.toThrow('changed funding plan')
  })

  test('does not allocate when the durable operation capacity is exhausted', async () => {
    const store = await SQLiteActionRecoveryStore.install(context.activeStorage, { records: 1, bytes: 1048576 })
    await createAction(context.activeStorage, auth(), args(), undefined, await store.operation(binding()))
    const allocate = jest.spyOn(context.activeStorage, 'insertTransaction')
    await expect(createAction(context.activeStorage, auth(), args(), undefined, await store.operation(binding('operation-two')))).rejects.toThrow('capacity exhausted')
    expect(allocate).not.toHaveBeenCalled()
  })

  test('requires a matching wallet, storage, chain and real transaction token', async () => {
    const store = await SQLiteActionRecoveryStore.install(context.activeStorage)
    for (const changed of [
      { ...binding(), walletIdentity: 'wrong' },
      { ...binding(), storageIdentity: 'wrong' },
      { ...binding(), chain: 'wrong' }
    ]) await expect(store.operation(changed)).rejects.toThrow('binding mismatch')
    const operation = await store.operation(binding())
    await expect(operation.claim(undefined)).rejects.toThrow('active allocation transaction')
  })

  test('reopens only when aggregate accounting agrees with the retained records', async () => {
    const store = await SQLiteActionRecoveryStore.install(context.activeStorage)
    await createAction(context.activeStorage, auth(), args(), undefined, await store.operation(binding()))
    await expect(SQLiteActionRecoveryStore.open(context.activeStorage)).resolves.toBeInstanceOf(SQLiteActionRecoveryStore)
    await context.activeStorage.knex('wallet_action_recovery_metadata_v1').where({ id: 1 }).increment('usedRecords', 1)
    await expect(SQLiteActionRecoveryStore.open(context.activeStorage)).rejects.toThrow('accounting does not match')
  })

  test('rejects incomplete or changed signing state instead of reconstructing a new action', async () => {
    const store = await SQLiteActionRecoveryStore.install(context.activeStorage)
    const operation = await store.operation(binding())
    await createAction(context.activeStorage, auth(), args(), undefined, operation)
    const db = context.activeStorage.knex
    const original = await db('wallet_action_recovery_v1').first()
    for (const change of [
      { processed: 1 }, { processed: 2 }, { byteLength: original.byteLength + 1 },
      { plan: null }, { preparedBeef: 'AA==', completed: null },
      { finalBeef: 'AA==', finalRequestDigest: null },
      { finalBeef: 'AA==', finalRequestDigest: 'a'.repeat(64) },
      { finalRequestDigest: 'invalid', finalBeef: 'AA==', preparedBeef: 'AA==' }
    ]) {
      await db('wallet_action_recovery_v1').where({ operationKey: original.operationKey }).update({ ...original, ...change })
      await expect(operation.read()).rejects.toThrow()
      await expect(operation.signingState()).rejects.toThrow()
    }
    await db('wallet_action_recovery_v1').where({ operationKey: original.operationKey }).update(original)
    expect((await operation.read())!.completed).toBeDefined()
  })

  test('binds an owned closed identity before awaiting the wallet lookup', async () => {
    const store = await SQLiteActionRecoveryStore.install(context.activeStorage)
    const mutable = binding()
    const original = context.activeStorage.findUsers.bind(context.activeStorage)
    jest.spyOn(context.activeStorage, 'findUsers').mockImplementationOnce(async (...args) => {
      mutable.operationId = 'changed'
      mutable.requestJSON = actionRecoveryJSON({ changed: true })
      return await original(...args)
    })
    const operation = await store.operation(mutable)
    const result = await createAction(context.activeStorage, auth(), args(), undefined, operation)
    expect((await (await store.operation(binding())).read())!.completed!.reference).toBe(result.reference)
    expect(await (await store.operation(mutable)).read()).toBeUndefined()
    await expect(store.operation({ ...binding(), extra: true } as ReturnType<typeof binding>)).rejects.toThrow('Invalid action recovery binding')
  })

  test('rolls back a byte-capacity failure after funding and retains capacity for recovery', async () => {
    const store = await SQLiteActionRecoveryStore.install(context.activeStorage, { records: 2, bytes: 1000 })
    const operation = await store.operation(binding())
    const before = await context.activeStorage.findTransactions({ partial: { userId: context.userId }, noRawTx: true })
    await expect(createAction(context.activeStorage, auth(), args(), undefined, operation)).rejects.toThrow('capacity exhausted')
    expect(await operation.read()).toBeUndefined()
    expect(await context.activeStorage.findTransactions({ partial: { userId: context.userId }, noRawTx: true })).toEqual(before)
    expect(await store.metadata()).toMatchObject({ usedBytes: 0, usedRecords: 0 })
  })

  test('retains the first final bytes across concurrent store instances and rejects signing conflicts', async () => {
    const store = await SQLiteActionRecoveryStore.install(context.activeStorage)
    const operation = await store.operation(binding())
    const dcr = await createAction(context.activeStorage, auth(), args(), undefined, operation)
    const { tx } = buildSignableTransaction(dcr, args(), context.wallet)
    const beef = Beef.fromBinaryStrict(dcr.inputBeef!)
    beef.mergeTransaction(tx)
    const bytes = beef.toBinaryAtomic(tx.id('hex'))
    await operation.retainPrepared(bytes)
    const reopened = await (await SQLiteActionRecoveryStore.open(context.activeStorage)).operation(binding())
    const digest = '11'.repeat(32)
    expect(await operation.retainFinal(digest, bytes)).toEqual(bytes)
    const before = await store.metadata()
    // Exercise storage CAS only: the controller separately requires valid Script.
    // An alternative unlocking script has the same layout but different raw bytes.
    const alternative = Transaction.fromAtomicBEEF(bytes)
    alternative.inputs[0].unlockingScript = UnlockingScript.fromHex('00')
    beef.mergeTransaction(alternative)
    const differentBytes = beef.toBinaryAtomic(alternative.id('hex'))
    const results = await Promise.all([
      operation.retainFinal(digest, differentBytes), reopened.retainFinal(digest, bytes)
    ])
    expect(results).toEqual([bytes, bytes])
    await expect(reopened.retainFinal('22'.repeat(32), bytes)).rejects.toThrow('signing request conflicts')
    await expect(reopened.markProcessed('22'.repeat(32))).rejects.toThrow('final transaction is absent')
    expect((await reopened.signingState()).final).toEqual({ digest, beef: bytes })
    expect((await store.metadata()).usedBytes).toBe(before.usedBytes)
    await reopened.markProcessed(digest)
    expect((await operation.signingState()).processed).toBe(true)
  })
})
