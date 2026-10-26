import { Beef, LockingScript, Transaction, UnlockingScript, Validation } from '@bsv/sdk'
import { _tu, type TestWalletNoSetup } from '../../../../test/utils/TestUtilsWalletStorage'
import { createAction } from '../../methods/createAction'
import { actionRecoveryJSON, ACTION_RECOVERY_RECORD_BYTES } from '../ActionRecoveryCodec'
import { SQLiteActionRecoveryStore, sameRecoveryLayout } from '../SQLiteActionRecoveryStore'
import { buildSignableTransaction } from '../../../signer/methods/buildSignableTransaction'

const metadataTable = 'wallet_action_recovery_metadata_v1'
const recordsTable = 'wallet_action_recovery_v1'

describe('action recovery storage boundaries', () => {
  let context: TestWalletNoSetup
  const request = {
    description: 'Recovery boundary fixture',
    outputs: [{ lockingScript: '51', satoshis: 10, outputDescription: 'Public synthetic output' }],
    options: { noSend: true, signAndProcess: false, randomizeOutputs: false, returnTXIDOnly: false }
  }
  beforeEach(async () => { context = await _tu.createLegacyWalletSQLiteCopy(expect.getState().currentTestName!, 'legacy') })
  afterEach(async () => { jest.restoreAllMocks(); await context?.wallet.destroy() })
  function binding(operationId = 'boundary-one') {
    return { userId: context.userId, walletIdentity: context.identityKey, storageIdentity: context.activeStorage.getSettings().storageIdentityKey,
      chain: context.chain, originator: 'boundary.local', operationId, requestJSON: actionRecoveryJSON(request) }
  }
  async function allocated() {
    const store = await SQLiteActionRecoveryStore.install(context.activeStorage)
    const operation = await store.operation(binding())
    const args = Validation.validateCreateActionArgs(request)
    args.includeAllSourceTransactions = true
    const result = await createAction(context.activeStorage, { userId: context.userId, identityKey: context.identityKey, isActive: true }, args, undefined, operation)
    const { tx } = buildSignableTransaction(result, args, context.wallet)
    const beef = Beef.fromBinaryStrict(result.inputBeef!)
    beef.mergeTransaction(tx)
    const bytes = beef.toBinaryAtomic(tx.id('hex'))
    return { store, operation, result, bytes, tx, beef }
  }

  test('requires SQLite and rejects invalid capacities before any schema mutation', async () => {
    const settings = context.activeStorage.getSettings()
    jest.spyOn(context.activeStorage, 'getSettings').mockReturnValue({ ...settings, dbtype: 'MySQL' })
    const transaction = jest.spyOn(context.activeStorage, 'transaction')
    await expect(SQLiteActionRecoveryStore.open(context.activeStorage)).rejects.toThrow('Action recovery requires local SQLite storage')
    await expect(SQLiteActionRecoveryStore.install(context.activeStorage)).rejects.toThrow('Action recovery requires local SQLite storage')
    jest.mocked(context.activeStorage.getSettings).mockReturnValue(settings)
    for (const field of ['records', 'bytes'] as const) {
      const maximum = field === 'records' ? 4096 : 64 * 1024 * 1024
      for (const value of [0, -1, 0.5, NaN, Infinity, maximum + 1, '1', null]) {
        const limits = { records: 4096, bytes: 64 * 1024 * 1024, [field]: value }
        await expect(SQLiteActionRecoveryStore.install(context.activeStorage, limits as { records: number; bytes: number })).rejects.toThrow('Invalid action recovery capacity')
      }
    }
    expect(transaction).not.toHaveBeenCalled()
    await SQLiteActionRecoveryStore.install(context.activeStorage, { records: 1, bytes: 1 })
    await expect(SQLiteActionRecoveryStore.install(context.activeStorage, { records: 2, bytes: 1 })).rejects.toThrow('capacity differs')
    await expect(SQLiteActionRecoveryStore.install(context.activeStorage, { records: 1, bytes: 2 })).rejects.toThrow('capacity differs')
  })

  test('owns installation limits before yielding to the database', async () => {
    const limits = { records: 2, bytes: 102400 }
    const installing = SQLiteActionRecoveryStore.install(context.activeStorage, limits)
    limits.records = 3
    limits.bytes = 204800
    expect(await (await installing).metadata()).toMatchObject({ maximumRecords: 2, maximumBytes: 102400 })
    expect(limits).toEqual({ records: 3, bytes: 204800 })
  })

  test('rejects partial schema and independently validates retained accounting and capacity', async () => {
    const store = await SQLiteActionRecoveryStore.install(context.activeStorage)
    const db = context.activeStorage.knex, original = await db(metadataTable).where({ id: 1 }).first()
    for (const change of [
      { version: 2 }, { guard: -1 }, { guard: 0.5 }, { guard: 'wrong' },
      { maximumRecords: 0 }, { maximumRecords: 4097 }, { maximumBytes: 0 }, { maximumBytes: 67108865 },
      { usedRecords: 4097 }, { usedBytes: 67108865 }
    ]) {
      await db(metadataTable).where({ id: 1 }).update({ ...original, ...change })
      const reason = 'version' in change ? 'Missing or incompatible action recovery store'
        : 'guard' in change ? 'Corrupt action recovery accounting' : 'Corrupt action recovery capacity'
      await expect(store.metadata()).rejects.toThrow(reason)
    }
    await db(metadataTable).where({ id: 1 }).update({ ...original, usedRecords: 4096, usedBytes: 67108864 })
    expect(await store.metadata()).toMatchObject({ usedRecords: 4096, usedBytes: 67108864 })
    await db(metadataTable).where({ id: 1 }).update({ ...original, usedBytes: 1 })
    await expect(SQLiteActionRecoveryStore.open(context.activeStorage)).rejects.toThrow('accounting does not match retained records')
    await db(metadataTable).where({ id: 1 }).update(original)
    await db(metadataTable).insert({ ...original, id: 0, version: 2 })
    expect((await store.metadata()).version).toBe(1)
    await db(metadataTable).where({ id: 1 }).delete()
    await expect(store.metadata()).rejects.toThrow('Missing or incompatible action recovery store')
    await db.schema.dropTable(recordsTable)
    await expect(SQLiteActionRecoveryStore.install(context.activeStorage)).rejects.toThrow('Incomplete action recovery schema')
  })

  test('validates the complete operation identity before wallet lookup and accepts exact string bounds', async () => {
    const store = await SQLiteActionRecoveryStore.install(context.activeStorage)
    const lookup = jest.spyOn(context.activeStorage, 'findUsers')
    for (const value of [0, -1, null, '1'])
      await expect(store.operation({ ...binding(), userId: value as number })).rejects.toThrow('Invalid action recovery user')
    for (const value of ['', null, 1, 'x'.repeat(129), '!valid', 'valid!', 'with spaces'])
      await expect(store.operation({ ...binding(), operationId: value as string })).rejects.toThrow('Invalid action recovery operation ID')
    for (const value of ['', null, 1, [], 'x'.repeat(251)])
      await expect(store.operation({ ...binding(), originator: value as string })).rejects.toThrow('Invalid action recovery originator')
    for (const field of Object.keys(binding())) {
      const partial = { ...binding(), unexpected: true } as Record<string, unknown>
      delete partial[field]
      await expect(store.operation(partial as ReturnType<typeof binding>)).rejects.toThrow('Invalid action recovery binding')
    }
    expect(lookup).not.toHaveBeenCalled()
    const exact = await store.operation({ ...binding('a.Z_9-' + 'x'.repeat(122)), originator: 'x'.repeat(250) })
    expect(await exact.read()).toBeUndefined()
    await expect(store.operation({ ...binding(), requestJSON: binding().requestJSON + ' ' })).rejects.toThrow('Noncanonical action recovery request')
  })

  test('bounds the write guard and rejects a transaction from a different wallet database', async () => {
    const store = await SQLiteActionRecoveryStore.install(context.activeStorage)
    const db = context.activeStorage.knex
    await db(metadataTable).where({ id: 1 }).update({ guard: Number.MAX_SAFE_INTEGER })
    await expect(context.activeStorage.transaction(async trx => { await store.lock(trx) })).rejects.toThrow('Action recovery store unavailable')
    await db(metadataTable).where({ id: 1 }).update({ guard: 0 })
    await context.activeStorage.transaction(async trx => {
      expect((await store.lock(trx)).guard).toBe(1)
      expect((await store.lock(trx)).guard).toBe(2)
    })
    const other = await _tu.createLegacyWalletSQLiteCopy('independent-recovery-boundary', 'legacy')
    try {
      await expect(other.activeStorage.transaction(async trx => { await store.lock(trx) })).rejects.toThrow('Action recovery transaction belongs to another database')
    } finally { await other.wallet.destroy() }
  })

  test('rejects incomplete lifecycle operations and preserves the first completion', async () => {
    const { store, operation, result, bytes } = await allocated()
    const absent = await store.operation(binding('absent'))
    await expect(absent.complete(result)).rejects.toThrow('Action recovery allocation is absent')
    await expect(absent.signingState()).rejects.toThrow('Action recovery funding is not complete')
    await expect(absent.retainPrepared(bytes)).rejects.toThrow('Action recovery funding is not complete')
    await expect(absent.retainFinal('11'.repeat(32), bytes)).rejects.toThrow('Action recovery signable transaction is absent')
    await expect(absent.markProcessed('11'.repeat(32))).rejects.toThrow('Action recovery final transaction is absent')
    const plan = (await operation.read())!.plan
    await expect(context.activeStorage.transaction(async trx => { await absent.retain(plan, trx) })).rejects.toThrow('Action recovery allocation is not newly claimed')
    await expect(context.activeStorage.transaction(async trx => { await operation.retain(plan, trx) })).rejects.toThrow('Action recovery allocation is not newly claimed')
    await context.activeStorage.transaction(async trx => { await absent.claim(trx) })
    await expect(absent.read()).rejects.toThrow('Action recovery allocation is incomplete')
    await expect(absent.signingState()).rejects.toThrow('Action recovery funding is not complete')
    await expect(absent.retainPrepared(bytes)).rejects.toThrow('Action recovery funding is not complete')
    await expect(operation.retainFinal('11'.repeat(32), bytes)).rejects.toThrow('Action recovery signable transaction is absent')
    await expect(operation.markProcessed('11'.repeat(32))).rejects.toThrow('Action recovery final transaction is absent')
    expect(await operation.complete(result)).toEqual(result)
    expect(await operation.signingState()).toEqual({ processed: false })
    expect(await operation.retainPrepared(bytes)).toEqual(bytes)
    expect(await operation.retainPrepared(bytes)).toEqual(bytes)
    expect(await operation.signingState()).toEqual({ prepared: bytes, processed: false })
    const changed = Transaction.fromAtomicBEEF(bytes)
    changed.lockTime++
    const beef = Beef.fromBinaryStrict(bytes)
    beef.mergeTransaction(changed)
    await expect(operation.retainPrepared(beef.toBinaryAtomic(changed.id('hex')))).rejects.toThrow('Recovered signable transaction changed')
    await expect(operation.retainFinal('11'.repeat(32), beef.toBinaryAtomic(changed.id('hex')))).rejects.toThrow('Final action changed funded layout')
    for (const digest of ['', 'a'.repeat(63), 'x' + 'a'.repeat(64), 'a'.repeat(64) + 'x'])
      await expect(operation.retainFinal(digest, bytes)).rejects.toThrow('Invalid action recovery signing digest')
  })

  test('rejects malformed retained Atomic BEEF independently of public descriptor completion', async () => {
    const { operation, bytes } = await allocated()
    for (const invalid of [new Uint8Array(bytes), {}, null])
      await expect(operation.retainPrepared(invalid as number[])).rejects.toThrow('Invalid action recovery transaction bytes')
    await expect(operation.retainPrepared(bytes.slice(36))).rejects.toThrow('Action recovery requires exact atomic target bytes')
    const only = Beef.fromBinaryStrict(bytes)
    only.makeTxidOnly(only.atomicTxid!)
    await expect(operation.retainPrepared([...bytes.slice(0, 36), ...only.toBinary()])).rejects.toThrow('Action recovery requires exact atomic target bytes')
    await operation.retainPrepared(bytes)
    const db = context.activeStorage.knex, original = await db(recordsTable).first()
    for (const [preparedBeef, reason] of [
      ['x'.repeat(ACTION_RECOVERY_RECORD_BYTES + 1), 'Action recovery record is too large'],
      [Buffer.from(bytes).toString('base64') + '=', 'Invalid action recovery transaction encoding']
    ]) {
      const row = { ...original, preparedBeef }
      row.byteLength = ['binding', 'plan', 'completed', 'preparedBeef', 'finalRequestDigest', 'finalBeef'].reduce((total, key) => total + (row[key] === null ? 0 : Buffer.byteLength(row[key])), 0)
      await db(recordsTable).where({ operationKey: row.operationKey }).update(row)
      await expect(operation.signingState()).rejects.toThrow(reason)
    }
  })

  test('identifies damaged records at the failed invariant before replaying any transaction', async () => {
    const { store, operation, bytes } = await allocated()
    await operation.retainPrepared(bytes)
    const db = context.activeStorage.knex, original = await db(recordsTable).first()
    const cases: [Record<string, unknown>, string][] = [
      [{ binding: Buffer.from([1]) }, 'Corrupt action recovery identity'],
      [{ plan: Buffer.from([1]) }, 'Corrupt action recovery record'],
      [{ byteLength: 0 }, 'Corrupt action recovery accounting'],
      [{ byteLength: 0.5 }, 'Corrupt action recovery accounting'],
      [{ byteLength: 'wrong' }, 'Corrupt action recovery accounting'],
      [{ processed: 2 }, 'Corrupt action recovery accounting'],
      [{ plan: null }, 'Incomplete action recovery allocation'],
      [{ completed: null }, 'Incomplete action recovery preparation'],
      [{ finalRequestDigest: 'a'.repeat(64) }, 'Incomplete action recovery finalization'],
      [{ finalBeef: 'AA==' }, 'Incomplete action recovery finalization'],
      [{ finalBeef: 'AA==', finalRequestDigest: 'a'.repeat(64), preparedBeef: null }, 'Incomplete action recovery finalization'],
      [{ finalBeef: 'AA==', finalRequestDigest: 'x' + 'a'.repeat(64) }, 'Corrupt action recovery signing digest'],
      [{ finalBeef: 'AA==', finalRequestDigest: 'a'.repeat(64) + 'x' }, 'Corrupt action recovery signing digest'],
      [{ processed: 1 }, 'Incomplete action recovery processing']
    ]
    for (const [change, reason] of cases) {
      await db(recordsTable).where({ operationKey: original.operationKey }).update({ ...original, ...change })
      await expect(operation.read()).rejects.toThrow(reason)
      await expect(operation.signingState()).rejects.toThrow(reason)
    }
    await db(recordsTable).where({ operationKey: original.operationKey }).delete()
    for (const operationKey of ['x' + 'a'.repeat(64), 'a'.repeat(64) + 'x', Buffer.from([1])]) {
      await db(recordsTable).insert({ ...original, operationKey })
      await expect(store.read(operationKey as string, original.binding)).rejects.toThrow('Corrupt action recovery identity')
      await db(recordsTable).where({ operationKey }).delete()
    }
    await db(recordsTable).insert(original)
    expect((await operation.signingState()).prepared).toEqual(bytes)
  })

  test('capacity counts exact retained bytes and a failed replacement rolls back without losing the original', async () => {
    const { store, operation, bytes } = await allocated()
    const db = context.activeStorage.knex, before = await store.metadata()
    await db(metadataTable).where({ id: 1 }).update({ maximumBytes: before.usedBytes })
    expect(await SQLiteActionRecoveryStore.open(context.activeStorage)).toBeInstanceOf(SQLiteActionRecoveryStore)
    await expect(operation.retainPrepared(bytes)).rejects.toThrow('Action recovery byte capacity exhausted')
    expect(await operation.signingState()).toEqual({ processed: false })
    expect((await store.metadata()).usedBytes).toBe(before.usedBytes)
    const extra = await store.operation(binding('second-claim'))
    await expect(context.activeStorage.transaction(async trx => { await extra.claim(trx) })).rejects.toThrow('Action recovery byte capacity exhausted')
    expect(await extra.read()).toBeUndefined()
    const addition = Buffer.byteLength(Buffer.from(bytes).toString('base64'))
    await db(metadataTable).where({ id: 1 }).update({ maximumBytes: before.usedBytes + addition })
    await operation.retainPrepared(bytes)
    expect((await store.metadata()).usedBytes).toBe(before.usedBytes + addition)
    expect(await SQLiteActionRecoveryStore.open(context.activeStorage)).toBeInstanceOf(SQLiteActionRecoveryStore)
    await operation.retainPrepared(bytes)
    expect((await store.metadata()).usedBytes).toBe(before.usedBytes + addition)
  })
})

test('a recovered layout fixes every input, output and header while allowing only unlocking scripts to change', () => {
  const before = new Transaction(1, [
    { sourceTXID: '11'.repeat(32), sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScript: UnlockingScript.fromHex('') },
    { sourceTXID: '22'.repeat(32), sourceOutputIndex: 1, sequence: 0xffffffff, unlockingScript: UnlockingScript.fromHex('') }
  ], [{ satoshis: 1, lockingScript: LockingScript.fromHex('51') }, { satoshis: 2, lockingScript: LockingScript.fromHex('52') }], 0)
  for (const change of [
    (tx: Transaction) => { tx.version++ }, (tx: Transaction) => { tx.lockTime++ },
    (tx: Transaction) => { tx.inputs.pop() }, (tx: Transaction) => { tx.outputs.pop() },
    (tx: Transaction) => { tx.inputs[1].sourceTXID = '33'.repeat(32) },
    (tx: Transaction) => { tx.inputs[1].sourceOutputIndex++ }, (tx: Transaction) => { tx.inputs[1].sequence!-- },
    (tx: Transaction) => { tx.outputs[1].satoshis!++ }, (tx: Transaction) => { tx.outputs[1].lockingScript = LockingScript.fromHex('53') }
  ]) {
    const changed = Transaction.fromHex(before.toHex())
    change(changed)
    expect(sameRecoveryLayout(before, changed)).toBe(false)
  }
  const unlocked = Transaction.fromHex(before.toHex())
  unlocked.inputs[0].unlockingScript = UnlockingScript.fromHex('51')
  expect(sameRecoveryLayout(before, unlocked)).toBe(true)
})
