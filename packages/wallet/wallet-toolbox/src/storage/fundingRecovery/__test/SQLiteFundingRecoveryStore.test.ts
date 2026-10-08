import { outputPacketDigest } from '@bsv/sdk'
import { _tu, type TestWalletNoSetup } from '../../../../test/utils/TestUtilsWalletStorage'
import { SQLiteFundingRecoveryStore } from '../SQLiteFundingRecoveryStore'
import { fundingFixture } from '../__tests__/fundingFixture'
import { RecoverableFundingController } from '../../../signer/fundingRecovery/RecoverableFundingController'

const metadata = 'wallet_funding_recovery_metadata_v1', records = 'wallet_funding_recovery_v1'

describe('bounded atomic funding journal', () => {
  let context: TestWalletNoSetup
  beforeEach(async () => { context = await _tu.createLegacyWalletSQLiteCopy(expect.getState().currentTestName!, 'legacy') })
  afterEach(async () => { jest.restoreAllMocks(); await context?.wallet.destroy() })

  test('requires explicit installation and seals chain, storage identity and capacity', async () => {
    const { chain } = fundingFixture(context)
    await expect(SQLiteFundingRecoveryStore.open(context.activeStorage, chain)).rejects.toThrow()
    for (const limits of [{ records: 0, bytes: 102400 }, { records: 4097, bytes: 102400 }, { records: 1, bytes: 102399 }, { records: 1, bytes: 67108865 }, { records: 1.5, bytes: 102400 }, { records: 1, bytes: NaN }])
      await expect(SQLiteFundingRecoveryStore.install(context.activeStorage, chain, limits)).rejects.toThrow('Invalid funding recovery capacity')
    const settings = context.activeStorage.getSettings()
    jest.spyOn(context.activeStorage, 'getSettings').mockReturnValue({ ...settings, dbtype: 'MySQL' })
    await expect(SQLiteFundingRecoveryStore.install(context.activeStorage, chain)).rejects.toThrow('matching local SQLite')
    await expect(SQLiteFundingRecoveryStore.open(context.activeStorage, chain)).rejects.toThrow('matching local SQLite')
    jest.mocked(context.activeStorage.getSettings).mockReturnValue(settings)
    await expect(SQLiteFundingRecoveryStore.install(context.activeStorage, { ...chain, genesisHash: '00'.repeat(32) })).rejects.toThrow('genesis differs')
    await SQLiteFundingRecoveryStore.install(context.activeStorage, chain, { records: 1, bytes: 102400 })
    await expect(SQLiteFundingRecoveryStore.install(context.activeStorage, chain, { records: 2, bytes: 102400 })).rejects.toThrow('capacity differs')
    await expect(SQLiteFundingRecoveryStore.install(context.activeStorage, chain, { records: 1, bytes: 102401 })).rejects.toThrow('capacity differs')
    await expect(SQLiteFundingRecoveryStore.open(context.activeStorage, { ...chain, network: 'other' })).rejects.toThrow('matching local SQLite')
  })

  test('owns installation limits and the chain before yielding to the database', async () => {
    const { chain } = fundingFixture(context), originalChain = { ...chain }
    const limits = { records: 2, bytes: 102400 }
    const installing = SQLiteFundingRecoveryStore.install(context.activeStorage, chain, limits)
    limits.records = 3
    limits.bytes = 204800
    chain.genesisHash = '00'.repeat(32)
    const store = await installing
    expect(store.chain).toEqual(originalChain)
    expect(Object.isFrozen(store.chain)).toBe(true)
    expect(await context.activeStorage.knex(metadata).where({ id: 1 }).first()).toMatchObject({ maximumRecords: 2, maximumBytes: 102400 })
    expect(limits).toEqual({ records: 3, bytes: 204800 })
  })

  test('reserves terminal capacity before work and retains rejected/unknown fences', async () => {
    const { chain, operation, tx } = fundingFixture(context)
    const store = await SQLiteFundingRecoveryStore.install(context.activeStorage, chain, { records: 1, bytes: 102400 })
    const first = operation(), hook = await store.retain(context.userId, context.identityKey, first)
    expect(await store.getInternalization(context.userId, context.identityKey, first.id)).toEqual({ state: 'unknown' })
    tx.lockTime++
    const second = operation(tx)
    await expect(store.retain(context.userId, context.identityKey, second)).rejects.toThrow('capacity exhausted')
    expect(await store.getInternalization(context.userId, context.identityKey, second.id)).toEqual({ state: 'absent' })
    await hook.reject()
    await hook.reject()
    const reopened = await SQLiteFundingRecoveryStore.open(context.activeStorage, chain)
    expect(await reopened.getInternalization(context.userId, context.identityKey, first.id)).toEqual({ state: 'rejected', reason: 'payment-script-mismatch' })
    await expect(hook.commit(async () => { throw new Error('must not execute') })).rejects.toThrow('Rejected funding')
    expect(await context.activeStorage.knex(records).count({ count: '*' }).first()).toMatchObject({ count: 1 })
  })

  test('never commits a receipt for absent or mismatched ownership and rolls back callback writes', async () => {
    const { chain, operation } = fundingFixture(context), input = operation()
    const store = await SQLiteFundingRecoveryStore.install(context.activeStorage, chain)
    const hook = await store.retain(context.userId, context.identityKey, input)
    await expect(hook.commit(async () => ({ accepted: false, isMerge: false, txid: input.funding.txid, satoshis: 0 }))).rejects.toThrow('finish ownership')
    await expect(hook.commit(async trx => {
      await context.activeStorage.toDb(trx)(metadata).where({ id: 1 }).increment('guard', 10)
      return { accepted: true, isMerge: false, txid: input.funding.txid, satoshis: 100 }
    })).rejects.toThrow('transaction is absent')
    expect((await context.activeStorage.knex(metadata).where({ id: 1 }).first()).guard).toBe(1)
    expect(await store.getInternalization(context.userId, context.identityKey, input.id)).toEqual({ state: 'unknown' })
    await context.activeStorage.knex(records).where({ id: input.id }).delete()
    await expect(hook.commit(async () => { throw new Error('must not execute') })).rejects.toThrow('absent or changed')
    await expect(hook.reject()).rejects.toThrow('Accepted or absent')
    await expect(SQLiteFundingRecoveryStore.open(context.activeStorage, chain)).rejects.toThrow('accounting differs')
  })

  test('owns requests and rejects another user or semantic rebinding', async () => {
    const { chain, operation } = fundingFixture(context), input = operation()
    const store = await SQLiteFundingRecoveryStore.install(context.activeStorage, chain)
    for (const id of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])
      await expect(store.retain(id, context.identityKey, input)).rejects.toThrow('Invalid funding recovery user')
    await expect(store.retain(999999, context.identityKey, input)).rejects.toThrow('wallet binding mismatch')
    await expect(store.retain(context.userId, input.buyer, input)).rejects.toThrow('seller or chain mismatch')
    const hook = await store.retain(context.userId, context.identityKey, input)
    input.derivationSuffix = 'modified'
    await expect(store.retain(context.userId, context.identityKey, input)).rejects.toThrow('conflicts with retained intent')
    const other = { ...operation(), acquisitionId: 'b2'.repeat(32) }
    other.id = outputPacketDigest('wallet-funding', { seller: other.seller, acquisitionId: other.acquisitionId, funding: other.funding })
    await expect(store.retain(context.userId, context.identityKey, other)).rejects.toThrow('already assigned')
    await hook.reject()
    expect(await store.getInternalization(context.userId, context.identityKey, input.id)).toMatchObject({ state: 'rejected' })
  })

  test('fails closed on corrupted accounting, operation records and partial schemas', async () => {
    const { chain, operation } = fundingFixture(context), input = operation()
    const store = await SQLiteFundingRecoveryStore.install(context.activeStorage, chain)
    await store.retain(context.userId, context.identityKey, input)
    const db = context.activeStorage.knex, original = await db(metadata).where({ id: 1 }).first()
    for (const change of [{ version: 2 }, { chain: '{}' }, { storageIdentity: 'other' }, { maximumRecords: 0 }, { maximumRecords: 4097 }, { maximumBytes: 102399 }, { maximumBytes: 67108865 }, { usedRecords: 4097 }, { guard: -1 }, { guard: 0.5 }]) {
      await db(metadata).where({ id: 1 }).update({ ...original, ...change })
      await expect(store.getInternalization(context.userId, context.identityKey, input.id)).rejects.toThrow(/funding recovery/)
    }
    await db(metadata).where({ id: 1 }).update(original)
    const row = await db(records).where({ id: input.id }).first()
    for (const change of [{ userId: 999999 }, { semantic: '{}' }, { operation: Buffer.from('x') }, { receipt: Buffer.from('x') }, { rejected: 2 }, { fundingKey: '0'.repeat(64) }, { receipt: '{}', rejected: 1 }, { receipt: '{}' }]) {
      await db(records).where({ id: input.id }).update({ ...row, ...change })
      await expect(store.getInternalization(context.userId, context.identityKey, input.id)).rejects.toThrow(/funding recovery|Funding recovery/)
    }
    await db(records).where({ id: input.id }).update(row)
    await db(metadata).where({ id: 1 }).update({ guard: Number.MAX_SAFE_INTEGER })
    await expect(store.retain(context.userId, context.identityKey, input)).rejects.toThrow('store unavailable')
    await db.schema.dropTable(records)
    await expect(SQLiteFundingRecoveryStore.install(context.activeStorage, chain)).rejects.toThrow('Incomplete funding recovery schema')
  })

  test('enforces the byte reservation independently of the record count and preserves exact capacity on reopen', async () => {
    const { chain, operation, tx } = fundingFixture(context)
    const store = await SQLiteFundingRecoveryStore.install(context.activeStorage, chain, { records: 2, bytes: 102400 })
    const input = operation()
    await store.retain(context.userId, context.identityKey, input)
    tx.lockTime++
    await expect(store.retain(context.userId, context.identityKey, operation(tx))).rejects.toThrow('capacity exhausted')
    const row = await context.activeStorage.knex(metadata).where({ id: 1 }).first()
    expect(row).toMatchObject({ maximumRecords: 2, maximumBytes: 102400, usedRecords: 1 })
    await SQLiteFundingRecoveryStore.open(context.activeStorage, chain)
    await context.activeStorage.knex(metadata).where({ id: 1 }).update({ usedRecords: 2 })
    await expect(store.getInternalization(context.userId, context.identityKey, input.id)).rejects.toThrow('Corrupt funding recovery capacity')
    await context.activeStorage.knex(metadata).where({ id: 1 }).update(row)
    await expect(SQLiteFundingRecoveryStore.open(context.activeStorage, { ...chain, genesisHash: '00'.repeat(32) })).rejects.toThrow('genesis differs')
  })

  test('accepts the exact maximum limits and rejects missing or invalid counters separately', async () => {
    const { chain, operation } = fundingFixture(context), input = operation()
    const store = await SQLiteFundingRecoveryStore.install(context.activeStorage, chain, { records: 4096, bytes: 67108864 })
    const db = context.activeStorage.knex, original = await db(metadata).where({ id: 1 }).first()
    for (const change of [{ maximumRecords: 0.5 }, { maximumBytes: 102400.5 }, { usedRecords: -1 }, { usedRecords: 0.5 }, { usedRecords: 656 }, { guard: Number.MAX_SAFE_INTEGER + 1 }]) {
      await db(metadata).where({ id: 1 }).update({ ...original, ...change })
      await expect(store.getInternalization(context.userId, context.identityKey, input.id)).rejects.toThrow(/Corrupt funding recovery/)
    }
    await db(metadata).where({ id: 1 }).delete()
    await expect(store.getInternalization(context.userId, context.identityKey, input.id)).rejects.toThrow('Missing or incompatible')
  })

  test('requires the exact callback result and owned output fields before writing a receipt', async () => {
    const fixture = fundingFixture(context), input = fixture.operation()
    jest.spyOn(context.services, 'getChainTracker').mockResolvedValue(fixture.tracker)
    const store = await SQLiteFundingRecoveryStore.install(context.activeStorage, fixture.chain)
    const controller = new RecoverableFundingController(context.wallet, store)
    await controller.internalizeOnce(input)
    const db = context.activeStorage.knex, saved = await db(records).where({ id: input.id }).first()
    await db(records).where({ id: input.id }).update({ receipt: null })
    const hook = await store.retain(context.userId, context.identityKey, input)
    for (const change of [{ txid: '00'.repeat(32) }, { sendWithResults: [] }, { notDelayedResults: [] }])
      await expect(hook.commit(async () => ({ accepted: true, isMerge: true, txid: input.funding.txid, satoshis: 0, ...change }))).rejects.toThrow('finish ownership writes')
    const output = (await context.activeStorage.findOutputs({ partial: { txid: input.funding.txid, vout: input.funding.outputIndex } }))[0]
    for (const change of [{ satoshis: 99 }, { derivationPrefix: 'other' }, { derivationSuffix: 'other' }, { senderIdentityKey: input.seller }]) {
      await expect(hook.commit(async trx => {
        await context.activeStorage.updateOutput(output.outputId, change, trx)
        return { accepted: true, isMerge: true, txid: input.funding.txid, satoshis: 0 }
      })).rejects.toThrow('ownership does not match retained intent')
      expect((await context.activeStorage.findOutputs({ partial: { outputId: output.outputId } }))[0]).toEqual(output)
      expect(await store.getInternalization(context.userId, context.identityKey, input.id)).toEqual({ state: 'unknown' })
    }
    await db(records).where({ id: input.id }).update(saved)
    const receipt = JSON.parse(saved.receipt)
    for (const change of [{ transactionId: 0 }, { transactionId: 0.5 }, { transactionId: Number.MAX_SAFE_INTEGER + 1 }, { walletIdentity: input.buyer }, { storageIdentity: input.buyer }, { operationId: '00'.repeat(32) }, { satoshis: '99' }, { extra: true }]) {
      await db(records).where({ id: input.id }).update({ receipt: JSON.stringify({ ...receipt, ...change }) })
      await expect(store.getInternalization(context.userId, context.identityKey, input.id)).rejects.toThrow('Corrupt funding recovery receipt')
    }
  })

  test('rejects non-text and oversized retained records even when their JSON values otherwise match', async () => {
    const fixture = fundingFixture(context), input = fixture.operation()
    jest.spyOn(context.services, 'getChainTracker').mockResolvedValue(fixture.tracker)
    const store = await SQLiteFundingRecoveryStore.install(context.activeStorage, fixture.chain)
    await new RecoverableFundingController(context.wallet, store).internalizeOnce(input)
    const db = context.activeStorage.knex, saved = await db(records).where({ id: input.id }).first()
    const accepted = await store.getInternalization(context.userId, context.identityKey, input.id)
    expect(accepted.state).toBe('accepted')
    for (const change of [
      { operation: Buffer.from(saved.operation) },
      { operation: saved.operation + ' '.repeat(100000) },
      { receipt: Buffer.from(saved.receipt) },
      { receipt: saved.receipt + ' '.repeat(4096) }
    ]) {
      await db(records).where({ id: input.id }).update({ ...saved, ...change })
      await expect(store.getInternalization(context.userId, context.identityKey, input.id)).rejects.toThrow('Corrupt or inaccessible funding recovery record')
      await db(records).where({ id: input.id }).update(saved)
      expect(await store.getInternalization(context.userId, context.identityKey, input.id)).toEqual(accepted)
    }
  })

  test('does not issue a retained receipt when native ownership metadata cannot support managed spending', async () => {
    const fixture = fundingFixture(context), input = fixture.operation()
    jest.spyOn(context.services, 'getChainTracker').mockResolvedValue(fixture.tracker)
    const store = await SQLiteFundingRecoveryStore.install(context.activeStorage, fixture.chain)
    await new RecoverableFundingController(context.wallet, store).internalizeOnce(input)
    const db = context.activeStorage.knex
    await db(records).where({ id: input.id }).update({ receipt: null })
    const hook = await store.retain(context.userId, context.identityKey, input)
    const output = (await context.activeStorage.findOutputs({ partial: { txid: input.funding.txid, vout: input.funding.outputIndex } }))[0]
    for (const change of [{ type: 'custom' }, { change: false }, { providedBy: 'you' as const }, { purpose: 'payment' }]) {
      await expect(hook.commit(async trx => {
        await context.activeStorage.updateOutput(output.outputId, change, trx)
        return { accepted: true, isMerge: true, txid: input.funding.txid, satoshis: 0 }
      })).rejects.toThrow('ownership does not match retained intent')
      expect((await context.activeStorage.findOutputs({ partial: { outputId: output.outputId } }))[0]).toEqual(output)
      expect(await store.getInternalization(context.userId, context.identityKey, input.id)).toEqual({ state: 'unknown' })
    }
    await hook.commit(async () => ({ accepted: true, isMerge: true, txid: input.funding.txid, satoshis: 0 }))
    expect(await store.getInternalization(context.userId, context.identityKey, input.id)).toMatchObject({ state: 'accepted', funding: input.funding })
  })
})
